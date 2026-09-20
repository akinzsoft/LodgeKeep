'use strict';

/**
 * Entitlement gating — PLAN.md Phase 5's own final exit criterion: "a
 * tenant on a lower plan calling a gated endpoint directly is rejected."
 * The one real gated capability this pass wires up end to end:
 * `multi_property` (`setup/service.js`'s `createProperty`) — a tenant's
 * first active property is always creatable regardless of plan; a SECOND
 * requires the plan to grant `multi_property`.
 *
 * Mirrors `tests/auth/tenant-lifecycle.test.js`'s shape for a whole-tenant
 * 403 gate: the write is rejected, reads are unaffected, cross-tenant
 * isolation holds, and — for the real race this gate introduces — see the
 * dedicated `plan-entitlements-concurrency.test.js` instead (this file
 * uses the shared-transaction harness, which cannot prove a real lock).
 *
 * Security fix (2026-11-01): `POST /properties` used to carry no
 * permission check at all past the genuine "tenant has zero properties
 * yet" bootstrap case (`tests/setup/setup.test.js`'s own header has the
 * full story) — every caller below that creates a SECOND (or later)
 * property now needs a real `setup.manage` grant to even reach the
 * entitlement check this file exists to prove, exactly like every other
 * Setup mutation. `grantSetupManage`/`seedRbacCatalogue` below exist
 * purely to give each such caller that grant, so what each test actually
 * proves stays the entitlement gate, not this file accidentally
 * re-testing the permission gate instead.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { SYSTEM_ROLES, DEFAULT_ROLE_PERMISSIONS } = require('../../src/modules/tenancy');

describe('Plan entitlement gating (PLAN.md Phase 5)', () => {
  const t = useTestApp();
  let ctx;
  let basicPlanId;
  let freshTenant;

  /**
   * Security fix: a raw `t.trx('tenants').insert(...)` (this file's own
   * established idiom for a synthetic, test-only tenant, e.g.
   * `freshTenant` below) carries no `roles`/`role_permissions` catalogue —
   * both TENANT_SCOPED, never created just by a bare `tenants` row —
   * matching `tests/setup/setup.test.js`'s own identical `seedEmptyTenant`
   * fix. Without this, granting a user `admin` at a property in such a
   * tenant grants nothing real (`hasPermission` finds no matching
   * `role_permissions` row), and `POST /properties`'s own `setup.manage`
   * check rejects every caller regardless of entitlement.
   */
  async function seedRbacCatalogue(tenantId) {
    const roleIdByCode = {};
    for (const code of SYSTEM_ROLES) {
      roleIdByCode[code] = await t.trx('roles').insert({ tenant_id: tenantId, code, name: code, is_system: true }).then(([id]) => id);
    }
    const permissionRows = await t.trx('permissions').select('id', 'permission_key');
    const permissionIdByKey = new Map(permissionRows.map((row) => [row.permission_key, row.id]));
    const grants = [];
    for (const [code, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const key of keys) {
        const permissionId = permissionIdByKey.get(key);
        if (permissionId) grants.push({ tenant_id: tenantId, role_id: roleIdByCode[code], permission_id: permissionId });
      }
    }
    if (grants.length) await t.trx('role_permissions').insert(grants);
  }

  /** Update-or-insert, matching `tests/setup/setup.test.js`'s own established helper exactly. */
  async function grantSetupManage({ tenantId, userId, propertyId }) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role: 'admin' });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'admin' });
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);

    // A synthetic, test-only non-entitled plan — mirrors
    // tests/platform/lifecycle.test.js's own "insert the fixture row a
    // scenario needs directly" idiom. No `plan_entitlements` row is
    // inserted for it at all, so `hasEntitlement` resolves it to `false`
    // by construction (no matching row = not entitled), never a second
    // real product-facing plan tier.
    [basicPlanId] = await t.trx('plans').insert({
      code: 'basic-isolation-test',
      name: 'Basic (test-only, no multi_property)',
      price: '10000.00',
      currency: 'NGN',
      billing_interval: 'monthly',
      is_active: true,
    });

    // Tenant B keeps its 2 fixture-seeded properties but is switched onto
    // the non-entitled plan for the rest of this file — a real, cheap way
    // to exercise "already has one, plan doesn't allow a second" without
    // building a whole fresh tenant for it.
    await t.trx('tenants').where({ id: ctx.b.id }).update({ plan_id: basicPlanId });

    // Security fix: `fixtureTokenFor` below always signs `users[0]` —
    // fixtures.js's own grant plan gives that user `manager` at
    // `properties[0]`, `setup.view` only. Every test in this file that
    // creates a SECOND property needs real `setup.manage` to even reach
    // the entitlement check this file exists to prove, so `users[0]` is
    // elevated to `admin` here, once, for both fixture tenants — this
    // file never tests a manager/admin distinction, only entitlement.
    await grantSetupManage({ tenantId: ctx.a.id, userId: ctx.a.users[0].id, propertyId: ctx.a.properties[0].id });
    await grantSetupManage({ tenantId: ctx.b.id, userId: ctx.b.users[0].id, propertyId: ctx.b.properties[0].id });

    // A brand-new tenant with ZERO properties, on the SAME non-entitled
    // plan — the only way to prove "property #1 is always allowed
    // regardless of plan," since both fixture tenants start with 2.
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const [tenantId] = await t.trx('tenants').insert({
      name: 'Fresh Entitlement Tenant',
      slug: `entitlement-fresh-${suffix}`,
      plan_id: basicPlanId,
    });
    const [userId] = await t.trx('users').insert({
      tenant_id: tenantId,
      email: `entitlement-fresh-${suffix}@example.test`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Fresh',
      last_name: 'Tenant',
    });
    await seedRbacCatalogue(tenantId);
    freshTenant = { id: tenantId, userId };
  });

  it('rejects a plan that EXPLICITLY carries enabled:false (not merely an absent row) — the real MySQL boolean round trip, not just "no row found"', async () => {
    // A dedicated plan/tenant, separate from `basicPlanId`'s fixtures above
    // (which prove absence-means-not-entitled): this one inserts a real
    // `plan_entitlements` row with `enabled: false` and proves the
    // TINYINT(1)-as-0/1 value mysql2 hands back is coerced correctly by
    // `hasEntitlement`'s `Boolean(row.enabled)` — this codebase has shipped
    // the `0 !== false` bug once before (the property-level MFA toggle),
    // and this is the one path in this pass with the identical shape.
    const [explicitDisabledPlanId] = await t.trx('plans').insert({
      code: 'explicit-disabled-isolation-test',
      name: 'Explicitly Disabled (test-only)',
      price: '5000.00',
      currency: 'NGN',
      billing_interval: 'monthly',
      is_active: true,
    });
    await t.trx('plan_entitlements').insert({ plan_id: explicitDisabledPlanId, feature_key: 'multi_property', enabled: false });

    const suffix = `explicit-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const [tenantId] = await t.trx('tenants').insert({ name: 'Explicit Disable Tenant', slug: suffix, plan_id: explicitDisabledPlanId });
    const [userId] = await t.trx('users').insert({
      tenant_id: tenantId,
      email: `${suffix}@example.test`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Explicit',
      last_name: 'Disable',
    });
    const [propertyId] = await t.trx('properties').insert({ tenant_id: tenantId, slug: `${suffix}-first`, name: 'First', timezone: 'Africa/Lagos', base_currency: 'NGN' });
    await seedRbacCatalogue(tenantId);
    // Security fix: creating a SECOND property is an ordinary setup.manage
    // mutation — this caller needs the grant to even reach the entitlement
    // check this test exists to prove.
    await grantSetupManage({ tenantId, userId, propertyId });

    const token = tokenFor({ tenantId, userId, propertyId });
    const res = await t.request
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Second', slug: `${suffix}-second`, timezone: 'Africa/Lagos', base_currency: 'NGN' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_PLAN_ENTITLEMENT');
    expect(res.body.error.details).toEqual({ featureKey: 'multi_property', planCode: 'explicit-disabled-isolation-test' });
  });

  function tokenFor({ tenantId, userId, propertyId }) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId),
      tenant_id: String(tenantId),
      ...(propertyId === undefined ? {} : { property_id: String(propertyId) }),
    });
  }

  function fixtureTokenFor(tenant, propertyId) {
    return tokenFor({ tenantId: tenant.id, userId: tenant.users[0].id, propertyId: propertyId ?? tenant.properties[0].id });
  }

  it("a brand-new tenant's first property is always allowed, regardless of plan", async () => {
    const token = tokenFor({ tenantId: freshTenant.id, userId: freshTenant.userId });
    const res = await t.request
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'First Property', slug: 'entitlement-fresh-property-1', timezone: 'Africa/Lagos', base_currency: 'NGN' });

    expect(res.status).toBe(201);
    freshTenant.firstPropertyId = res.body.data.id;
  });

  it("that same tenant's second property is rejected with FORBIDDEN_PLAN_ENTITLEMENT once its plan doesn't grant multi_property", async () => {
    // Security fix: needs setup.manage at the first property to even reach
    // the entitlement check below.
    await grantSetupManage({ tenantId: freshTenant.id, userId: freshTenant.userId, propertyId: freshTenant.firstPropertyId });
    const token = tokenFor({ tenantId: freshTenant.id, userId: freshTenant.userId, propertyId: freshTenant.firstPropertyId });
    const res = await t.request
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Second Property', slug: 'entitlement-fresh-property-2', timezone: 'Africa/Lagos', base_currency: 'NGN' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_PLAN_ENTITLEMENT');
    expect(res.body.error.details).toEqual({ featureKey: 'multi_property', planCode: 'basic-isolation-test' });

    const count = await t.trx('properties').where({ tenant_id: freshTenant.id, status: 'active' }).count({ n: '*' }).first();
    expect(Number(count.n)).toBe(1);
  });

  it('reads are completely unaffected by the entitlement gate — only the write is blocked', async () => {
    const token = tokenFor({ tenantId: freshTenant.id, userId: freshTenant.userId, propertyId: freshTenant.firstPropertyId });
    const res = await t.request.get('/api/v1/properties').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('a tenant with no plan_id at all (the trial/never-converted default) resolves the default active plan and is entitled', async () => {
    // ctx.a's tenant row carries plan_id: null (fixtures.js never sets it) —
    // resolveActivePlanId's fallback should find the real seeded `standard`
    // plan, which the 20260926090000 migration grants multi_property to.
    const before = await t.trx('tenants').where({ id: ctx.a.id }).first('plan_id');
    expect(before.plan_id).toBeNull();

    const token = fixtureTokenFor(ctx.a);
    const res = await t.request
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Third Property', slug: `${ctx.a.slug}-entitlement-third`, timezone: 'Africa/Lagos', base_currency: 'NGN' });

    expect(res.status).toBe(201);
  });

  it("a tenant already carrying 2 active properties is rejected on a 3rd once switched to a non-entitled plan", async () => {
    const token = fixtureTokenFor(ctx.b);
    const res = await t.request
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Should Be Blocked', slug: `${ctx.b.slug}-entitlement-blocked`, timezone: 'Africa/Lagos', base_currency: 'NGN' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_PLAN_ENTITLEMENT');
    expect(res.body.error.details.featureKey).toBe('multi_property');
    expect(res.body.error.details.planCode).toBe('basic-isolation-test');
  });

  it("cross-tenant isolation: tenant B's rejection has no effect on tenant A's own, separately-decided entitlement", async () => {
    const countA = await t.trx('properties').where({ tenant_id: ctx.a.id, status: 'active' }).count({ n: '*' }).first();
    const countB = await t.trx('properties').where({ tenant_id: ctx.b.id, status: 'active' }).count({ n: '*' }).first();
    expect(Number(countA.n)).toBe(3); // 2 fixture + 1 created above
    expect(Number(countB.n)).toBe(2); // 2 fixture, the 3rd attempt was rejected
  });
});
