'use strict';

/**
 * Self-service tenant signup — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md
 * §3.22. HTTP-level coverage against the shared rolled-back transaction
 * (`useTestApp()`) — genuine multi-connection rollback proof lives in
 * `tests/signup/atomicity.test.js` instead, for the same reason
 * `tests/platform/atomicity.test.js` exists separately from
 * `tests/platform/platform.test.js`.
 */

const { useTestApp } = require('../helpers/app');

describe('POST /api/v1/signup', () => {
  const t = useTestApp();

  function validBody(overrides = {}) {
    return {
      company_name: 'Riverside Hotels',
      slug: `riverside-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      admin_email: `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@riverside.example`,
      admin_password: 'a genuinely long enough password',
      admin_first_name: 'Ada',
      admin_last_name: 'Okafor',
      ...overrides,
    };
  }

  it('creates a tenant, its first admin, and an empty property, and signs the admin in', async () => {
    const body = validBody();
    const res = await t.request.post('/api/v1/signup').send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.role).toBe('super_admin');
    expect(res.body.data.tenantId).toEqual(expect.any(String));
    expect(res.body.data.propertyId).toEqual(expect.any(String));
    expect(res.body.data.activePropertyId).toBe(res.body.data.propertyId);
    expect(res.body.data.trialEndsAt).toEqual(expect.any(String));

    const tenant = await t.trx('tenants').where({ id: res.body.data.tenantId }).first();
    expect(tenant.name).toBe('Riverside Hotels');
    expect(tenant.slug).toBe(body.slug);
    expect(tenant.status).toBe('trial');
    expect(tenant.trial_ends_at).not.toBeNull();

    const property = await t.trx('properties').where({ id: res.body.data.propertyId }).first();
    expect(String(property.tenant_id)).toBe(res.body.data.tenantId);
    expect(property.name).toBe('Riverside Hotels — Main Property');
    expect(property.timezone).toBe('Africa/Lagos');
    expect(property.base_currency).toBe('NGN');
    // Not auto-completed — PRODUCT_REQUIREMENTS.md §3.19's own wizard opens it.
    expect(property.current_business_date).toBeNull();

    const user = await t.trx('users').where({ id: res.body.data.userId }).first();
    expect(String(user.tenant_id)).toBe(res.body.data.tenantId);
    expect(user.email).toBe(body.admin_email.toLowerCase());

    const grant = await t.trx('user_property_access').where({ user_id: user.id, property_id: property.id }).first();
    expect(grant.role).toBe('super_admin');

    const roles = await t.trx('roles').where({ tenant_id: tenant.id });
    expect(roles.map((r) => r.code).sort()).toEqual(
      ['admin', 'cashier', 'front_desk', 'housekeeping', 'manager', 'pos_operator', 'super_admin'].sort()
    );

    // The complete SECURITY.md §5 matrix, not the dev seed script's
    // narrower subset — front_desk/cashier/housekeeping genuinely hold
    // grants, not zero.
    const superAdminRole = roles.find((r) => r.code === 'super_admin');
    const frontDeskRole = roles.find((r) => r.code === 'front_desk');
    const superAdminGrantCount = await t.trx('role_permissions').where({ role_id: superAdminRole.id }).count({ n: '*' });
    const frontDeskGrantCount = await t.trx('role_permissions').where({ role_id: frontDeskRole.id }).count({ n: '*' });
    expect(Number(superAdminGrantCount[0].n)).toBeGreaterThan(0);
    expect(Number(frontDeskGrantCount[0].n)).toBeGreaterThan(0);

    const auditRow = await t.trx('audit_log').where({ entity_type: 'tenants', entity_id: tenant.id, action: 'create' }).first();
    expect(auditRow).toBeTruthy();
    expect(auditRow.source).toBe('api');
  });

  it('the new admin holds super_admin at the new property and can immediately act with it', async () => {
    const body = validBody();
    const res = await t.request.post('/api/v1/signup').send(body);

    const progressRes = await t.request
      .get('/api/v1/setup/progress')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);

    expect(progressRes.status).toBe(200);
    expect(progressRes.body.data.operational).toBe(false);
    const propertyStep = progressRes.body.data.steps.find((s) => s.key === 'property');
    expect(propertyStep.complete).toBe(true);
    const roomTypesStep = progressRes.body.data.steps.find((s) => s.key === 'room-types');
    expect(roomTypesStep.complete).toBe(false);
  });

  // Real proof that a rejected signup rolls back everything already
  // inserted ahead of the failure (not just "returns the right error code")
  // needs genuine multi-connection transactions — the shared
  // rolled-back-transaction-per-file harness `useTestApp()` uses cannot
  // prove it: a nested `.transaction()` call against an already-open trx
  // is a no-op reuse of the SAME trx (`scoped-db.js`'s own documented
  // behavior), not a real savepoint, so an earlier insert in the SAME test
  // would still be visible even if rollback were silently broken. See
  // `tests/signup/atomicity.test.js` for the real proof, against real
  // pooled connections — the identical distinction
  // `tests/platform/atomicity.test.js` already draws from
  // `tests/platform/platform.test.js`. These two tests stay here only to
  // prove the right error CODE is returned for each collision.
  it('a duplicate tenant slug is rejected with the generic conflict code', async () => {
    const first = validBody();
    await t.request.post('/api/v1/signup').send(first);

    const second = validBody({ slug: first.slug });
    const res = await t.request.post('/api/v1/signup').send(second);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE_ENTRY');
  });

  it('a duplicate admin email (a different slug) is rejected with a distinct error code', async () => {
    const first = validBody();
    const firstRes = await t.request.post('/api/v1/signup').send(first);
    expect(firstRes.status).toBe(201);

    const second = validBody({ admin_email: first.admin_email.toUpperCase() });
    const res = await t.request.post('/api/v1/signup').send(second);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_SIGNUP_EMAIL_ALREADY_USED');
  });

  it('rejects a missing required field', async () => {
    const body = validBody();
    delete body.admin_password;
    const res = await t.request.post('/api/v1/signup').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
  });

  it('rejects a too-short password and creates nothing', async () => {
    const body = validBody({ admin_password: 'short' });
    const res = await t.request.post('/api/v1/signup').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_PASSWORD_TOO_SHORT');
    const tenants = await t.trx('tenants').where({ slug: body.slug });
    expect(tenants).toHaveLength(0);
  });

  it('rejects an invalid slug format', async () => {
    const res = await t.request.post('/api/v1/signup').send(validBody({ slug: 'Not A Valid Slug!' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_SLUG');
  });

  it('the new tenant is immediately reachable at its own subdomain (no engineer in the loop)', async () => {
    const body = validBody();
    const signupRes = await t.request.post('/api/v1/signup').send(body);
    expect(signupRes.status).toBe(201);

    const loginRes = await t.request
      .post('/api/v1/auth/login')
      .set('X-Tenant-Slug', body.slug)
      .send({ email: body.admin_email, password: body.admin_password });

    expect(loginRes.status).toBe(200);
  });
});
