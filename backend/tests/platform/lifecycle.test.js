'use strict';

/**
 * Tenant lifecycle (trial/active/suspended) and platform-staff tiering —
 * PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22, SECURITY.md §2's
 * "platform staff RBAC" paragraph, revisited once self-service signup
 * meant these actions reach real customer data.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants, seedPlatformUser } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Tenant lifecycle + platform-staff tiering (PLAN.md Phase 5)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    ctx.platformAdmin = await seedPlatformUser(t.trx, 'admin-ops@planmsys.test', 'admin');
    ctx.platformSupport = await seedPlatformUser(t.trx, 'support-ops@planmsys.test', 'support');

    // The fixture's own `manager`-role user (ctx.a.users[0]) holds
    // `setup.view` but not `setup.manage` — this suite's own write-gate
    // proof needs a real gated write the seeded staff token can otherwise
    // perform, so it grants that one extra key directly rather than
    // reaching for a heavier endpoint (reservation creation) just to
    // prove "was this request's write blocked or not."
    const setupManage = await t.trx('permissions').where({ permission_key: 'setup.manage' }).first('id');
    await t.trx('role_permissions').insert({ tenant_id: ctx.a.id, role_id: ctx.a.roles.manager, permission_id: setupManage.id });
  });

  function platformToken(platformUser = ctx.platformAdmin) {
    return signAccessToken({ aud: 'platform', sub: String(platformUser.id) });
  }

  function staffToken({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function resetTenantStatus(tenantId, status = 'active') {
    await t.trx('tenants').where({ id: tenantId }).update({ status, trial_ends_at: null });
  }

  afterEach(async () => {
    await resetTenantStatus(ctx.a.id, 'active');
    await resetTenantStatus(ctx.b.id, 'active');
  });

  // ------------------------------------------------------------------
  // Platform-staff tiering
  // ------------------------------------------------------------------

  describe('platform-staff tiering', () => {
    it('a support-tier account is refused starting an impersonation grant', async () => {
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/impersonate`)
        .set('Authorization', `Bearer ${platformToken(ctx.platformSupport)}`)
        .send({ property_id: ctx.a.properties[0].id, reason: 'Should be refused' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PLATFORM_ROLE');
    });

    it('a support-tier account is refused suspending a tenant', async () => {
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/suspend`)
        .set('Authorization', `Bearer ${platformToken(ctx.platformSupport)}`)
        .send({ reason: 'Should be refused' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PLATFORM_ROLE');
    });

    it('a support-tier account is refused reactivating a tenant', async () => {
      await resetTenantStatus(ctx.a.id, 'suspended');
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/reactivate`)
        .set('Authorization', `Bearer ${platformToken(ctx.platformSupport)}`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PLATFORM_ROLE');
    });

    it('a support-tier account can still read the tenant roster and impersonation history', async () => {
      const listRes = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${platformToken(ctx.platformSupport)}`);
      expect(listRes.status).toBe(200);
      const getRes = await t.request.get(`/api/v1/platform/tenants/${ctx.a.id}`).set('Authorization', `Bearer ${platformToken(ctx.platformSupport)}`);
      expect(getRes.status).toBe(200);
      const historyRes = await t.request
        .get(`/api/v1/platform/tenants/${ctx.a.id}/impersonation-sessions`)
        .set('Authorization', `Bearer ${platformToken(ctx.platformSupport)}`);
      expect(historyRes.status).toBe(200);
    });

    it('an admin-tier account can do all three', async () => {
      const impersonateRes = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/impersonate`)
        .set('Authorization', `Bearer ${platformToken(ctx.platformAdmin)}`)
        .send({ property_id: ctx.a.properties[0].id, reason: 'Admin can do this' });
      expect(impersonateRes.status).toBe(201);

      const suspendRes = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/suspend`)
        .set('Authorization', `Bearer ${platformToken(ctx.platformAdmin)}`)
        .send({ reason: 'Admin can do this too' });
      expect(suspendRes.status).toBe(200);

      const reactivateRes = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/reactivate`)
        .set('Authorization', `Bearer ${platformToken(ctx.platformAdmin)}`)
        .send({});
      expect(reactivateRes.status).toBe(200);
    });
  });

  // ------------------------------------------------------------------
  // Suspend / reactivate transitions
  // ------------------------------------------------------------------

  describe('suspend', () => {
    it('an active tenant can be suspended, with a reason, and the transition is audited', async () => {
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/suspend`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({ reason: 'Payment failed' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('suspended');
      const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first();
      expect(tenant.status).toBe('suspended');

      const entry = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'tenants', action: 'suspend' }).orderBy('id', 'desc').first();
      expect(entry).toBeTruthy();
      expect(entry.reason).toBe('Payment failed');
      expect(entry.source).toBe('api');
      expect(entry.before_state).toEqual({ status: 'active' });
      expect(entry.after_state).toEqual({ status: 'suspended' });
    });

    it('requires a reason', async () => {
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/suspend`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
    });

    it('a trial tenant can also be suspended', async () => {
      await resetTenantStatus(ctx.a.id, 'trial');
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/suspend`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({ reason: 'Suspending a trial directly' });
      expect(res.status).toBe(200);
    });

    it('an already-suspended tenant cannot be suspended again — invalid transition', async () => {
      await resetTenantStatus(ctx.a.id, 'suspended');
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/suspend`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({ reason: 'Already suspended' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_TENANT_TRANSITION');
    });

    it('an offboarding tenant cannot be suspended — invalid transition', async () => {
      await resetTenantStatus(ctx.a.id, 'offboarding');
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/suspend`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({ reason: 'Cannot suspend offboarding' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_TENANT_TRANSITION');
    });

    it('a nonexistent tenant is a real 422, not a bare crash', async () => {
      const res = await t.request
        .post('/api/v1/platform/tenants/999999999/suspend')
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({ reason: 'No such tenant' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_TENANT_NOT_FOUND');
    });
  });

  describe('reactivate', () => {
    it('a suspended tenant is restored to active — no data recreation, existing rows intact', async () => {
      await resetTenantStatus(ctx.a.id, 'suspended');
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/reactivate`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({ reason: 'Payment received' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('active');
      const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first();
      expect(tenant.status).toBe('active');
      // The tenant, its property, and its users are the exact same rows —
      // never recreated.
      expect(await t.trx('properties').where({ tenant_id: ctx.a.id })).toHaveLength(ctx.a.properties.length);
      expect(await t.trx('users').where({ tenant_id: ctx.a.id })).toHaveLength(ctx.a.users.length);

      const entry = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'tenants', action: 'reactivate' }).orderBy('id', 'desc').first();
      expect(entry).toBeTruthy();
      expect(entry.reason).toBe('Payment received');
    });

    it('a trial tenant can be reactivated to active directly (e.g. extended/converted early)', async () => {
      await resetTenantStatus(ctx.a.id, 'trial');
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/reactivate`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({});
      expect(res.status).toBe(200);
    });

    it('an already-active tenant cannot be "reactivated" — invalid transition', async () => {
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/reactivate`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_TENANT_TRANSITION');
    });

    it('an offboarding tenant cannot be reactivated — invalid transition', async () => {
      await resetTenantStatus(ctx.a.id, 'offboarding');
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/reactivate`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_TENANT_TRANSITION');
    });

    it('reactivation restores write access on the very next staff request', async () => {
      await resetTenantStatus(ctx.a.id, 'suspended');
      const blockedRes = await t.request
        .post('/api/v1/market-segments')
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ name: 'Should be blocked', code: `blocked-${Date.now()}` });
      expect(blockedRes.status).toBe(403);
      expect(blockedRes.body.error.code).toBe('FORBIDDEN_TENANT_READ_ONLY');

      await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/reactivate`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({});

      const allowedRes = await t.request
        .post('/api/v1/market-segments')
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ name: 'Should be allowed now', code: `allowed-${Date.now()}` });
      expect(allowedRes.status).toBe(201);
    });
  });

  // ------------------------------------------------------------------
  // Cross-tenant / provisioning isolation
  // ------------------------------------------------------------------

  describe('security', () => {
    it('suspending tenant A never touches tenant B', async () => {
      await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/suspend`)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send({ reason: 'Only A' });

      const tenantB = await t.trx('tenants').where({ id: ctx.b.id }).first();
      expect(tenantB.status).toBe('active');
    });

    it('an ordinary staff token cannot reach any platform lifecycle route', async () => {
      const res = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/suspend`)
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ reason: 'Staff should never reach this' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_WRONG_AUDIENCE');
    });
  });
});
