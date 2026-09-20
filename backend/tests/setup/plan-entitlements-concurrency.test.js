'use strict';

/**
 * The real race the `multi_property` entitlement gate introduces —
 * PLAN.md Phase 5's own final exit criterion, mutation-tested rather than
 * just asserted, per this codebase's own RES-5 precedent
 * (`tests/reservations/concurrency.test.js`, whose header this file's own
 * setup below follows almost verbatim).
 *
 * `setup/service.js`'s `createProperty` had NO locking at all before this
 * gate existed. Without locking the tenant's own row first: a tenant
 * already holding exactly one property, on a plan lacking
 * `multi_property`, firing two genuinely concurrent `POST /properties`
 * could see BOTH requests read the same "1 active property" count before
 * either commits — both reach the entitlement check with stale state —
 * and, depending on exactly how the check were written, could both
 * succeed, silently granting a non-entitled tenant 2 properties.
 * `createProperty` closes this by locking `tenants` (this schema's one
 * natural "exactly one row per tenant" target, scopeRoot: 'tenant') with
 * `SELECT ... FOR UPDATE` before counting or inserting.
 *
 * Security fix (2026-11-01): `POST /properties` used to carry no
 * permission check at all past the genuine "tenant has zero properties
 * yet" bootstrap case — see `tests/setup/setup.test.js`'s own header for
 * the full story. That fix means a caller creating a SECOND property now
 * needs a real, already-active-property `setup.manage` grant regardless
 * of entitlement — which is exactly why this file's own two races are now
 * built SEQUENTIALLY up to property #1 (the genuine bootstrap step, no
 * grant possible yet) and only race concurrently from property #2 onward,
 * once a real grant exists to race with. Racing property #1 itself
 * concurrently is no longer the scenario that exercises the entitlement
 * lock — a bootstrap-less caller is now rejected by the PERMISSION layer
 * the moment a sibling request wins that race first, deterministically,
 * not entitlement — and that specific, now-doubly-defended scenario is
 * covered directly in `tests/setup/setup.test.js` instead.
 *
 * Uses the real pooled test connection, not the shared-transaction
 * harness (`useTestApp()`) — two "concurrent" requests against a single
 * shared transaction are really two savepoints on the same MySQL session,
 * which never blocks itself, so that harness cannot prove a real lock
 * (see `tests/reservations/concurrency.test.js`'s own header for the full
 * reasoning, identical here).
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const { SYSTEM_ROLES, DEFAULT_ROLE_PERMISSIONS } = require('../../src/modules/tenancy');

describe('Entitlement gating: the multi_property race under real concurrent connections', () => {
  let req;
  let standardPlanId;
  let basicPlanId;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const standard = await db()('plans').where({ code: 'standard' }).first('id');
    standardPlanId = standard.id;

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    [basicPlanId] = await db()('plans').insert({
      code: `basic-race-${suffix}`,
      name: 'Basic (race test, no multi_property)',
      price: '10000.00',
      currency: 'NGN',
      billing_interval: 'monthly',
      is_active: true,
    });
    // Deliberately no `plan_entitlements` row for basicPlanId — absence
    // means "not entitled" by construction (src/shared/entitlements.js).
  });

  afterAll(async () => {
    await db()('plan_entitlements').where({ plan_id: basicPlanId }).delete();
    await db()('plans').where({ id: basicPlanId }).delete();
    dbModule.__resetForTesting();
  });

  /**
   * Security fix: a raw `tenants` insert carries no `roles`/
   * `role_permissions` catalogue (both TENANT_SCOPED) — matching
   * `tests/setup/setup.test.js`/`tests/setup/plan-entitlements.test.js`'s
   * own identical fix, needed here for the same reason: `POST /properties`
   * now requires a real `setup.manage` grant to create anything past the
   * tenant's very first property.
   */
  async function seedRbacCatalogue(tenantId) {
    const roleIdByCode = {};
    for (const code of SYSTEM_ROLES) {
      roleIdByCode[code] = await db()('roles').insert({ tenant_id: tenantId, code, name: code, is_system: true }).then(([id]) => id);
    }
    const permissionRows = await db()('permissions').select('id', 'permission_key');
    const permissionIdByKey = new Map(permissionRows.map((row) => [row.permission_key, row.id]));
    const grants = [];
    for (const [code, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const key of keys) {
        const permissionId = permissionIdByKey.get(key);
        if (permissionId) grants.push({ tenant_id: tenantId, role_id: roleIdByCode[code], permission_id: permissionId });
      }
    }
    if (grants.length) await db()('role_permissions').insert(grants);
  }

  /** A fresh, committed tenant with zero properties, on the given plan. */
  async function makeTenant(planId, suffix) {
    const [tenantId] = await db()('tenants').insert({
      name: `Race Tenant ${suffix}`,
      slug: `entitlement-race-${suffix}`,
      plan_id: planId,
    });
    const [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `entitlement-race-${suffix}@example.test`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Race',
      last_name: 'Tenant',
    });
    await seedRbacCatalogue(tenantId);
    return { tenantId, userId };
  }

  /**
   * The genuine bootstrap step (no active property, no grant possible
   * yet) — always sequential, never raced, per this file's own header.
   * Grants `admin` (`setup.manage`) at the new property immediately
   * afterward, so the caller returned here can go on to race property #2.
   */
  async function bootstrapFirstProperty({ tenantId, userId, suffix }) {
    const bootstrapToken = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId) });
    const res = await req
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${bootstrapToken}`)
      .send({ name: `Race Property first`, slug: `${suffix}-property-first`, timezone: 'Africa/Lagos', base_currency: 'NGN' });
    if (res.status !== 201) throw new Error(`bootstrap property creation failed: ${res.status} ${JSON.stringify(res.body)}`);
    const propertyId = res.body.data.id;
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'admin' });
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  }

  async function cleanupTenant(tenantId) {
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('user_property_access').where({ tenant_id: tenantId }).delete();
    await db()('role_permissions').where({ tenant_id: tenantId }).delete();
    await db()('roles').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    // Bell rows the flow under test raised (staff notifications) reference these users.
    await db()('in_app_notifications').where({ tenant_id: tenantId }).delete();
    await db()('users').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
  }

  it('two truly concurrent SECOND-property creations for a non-entitled tenant both correctly reject on entitlement, with no deadlock and no partial write', async () => {
    // Unlike the entitled test below, there is no "winner" here to race
    // for: the bootstrap property already exists (`activeCount >= 1` is
    // already a fixed fact before either request starts), so the
    // entitlement check runs — and fails — deterministically for BOTH
    // concurrent callers, not conditionally on which one the lock lets
    // through first. What this test actually proves is concurrency
    // SAFETY under that shared condition: two simultaneous rejections
    // against the same locked `tenants` row never deadlock and never
    // leave a partial/double write behind.
    const suffix = `nonent-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const { tenantId, userId } = await makeTenant(basicPlanId, suffix);

    try {
      const token = await bootstrapFirstProperty({ tenantId, userId, suffix });

      const create = (slugSuffix) =>
        req
          .post('/api/v1/properties')
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: `Race Property ${slugSuffix}`,
            slug: `${suffix}-property-${slugSuffix}`,
            timezone: 'Africa/Lagos',
            base_currency: 'NGN',
          });

      const [first, second] = await Promise.all([create('a'), create('b')]);

      expect(first.status).toBe(403);
      expect(first.body.error.code).toBe('FORBIDDEN_PLAN_ENTITLEMENT');
      expect(second.status).toBe(403);
      expect(second.body.error.code).toBe('FORBIDDEN_PLAN_ENTITLEMENT');

      // No partial write: only the bootstrap property itself ever committed.
      const count = await db()('properties').where({ tenant_id: tenantId, status: 'active' }).count({ n: '*' }).first();
      expect(Number(count.n)).toBe(1);
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  it('the same two-concurrent-creates shape against an ENTITLED tenant is unaffected — the lock serialises the decision, not throughput, for a tenant the gate does not restrict', async () => {
    const suffix = `ent-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const { tenantId, userId } = await makeTenant(standardPlanId, suffix);

    try {
      const token = await bootstrapFirstProperty({ tenantId, userId, suffix });

      const create = (slugSuffix) =>
        req
          .post('/api/v1/properties')
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: `Race Property ${slugSuffix}`,
            slug: `${suffix}-property-${slugSuffix}`,
            timezone: 'Africa/Lagos',
            base_currency: 'NGN',
          });

      const [first, second] = await Promise.all([create('a'), create('b')]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const count = await db()('properties').where({ tenant_id: tenantId, status: 'active' }).count({ n: '*' }).first();
      expect(Number(count.n)).toBe(3); // bootstrap + both concurrent winners
    } finally {
      await cleanupTenant(tenantId);
    }
  });
});
