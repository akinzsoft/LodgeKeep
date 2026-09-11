'use strict';

/**
 * The real race the `multi_property` entitlement gate introduces —
 * PLAN.md Phase 5's own final exit criterion, mutation-tested rather than
 * just asserted, per this codebase's own RES-5 precedent
 * (`tests/reservations/concurrency.test.js`, whose header this file's own
 * setup below follows almost verbatim).
 *
 * `setup/service.js`'s `createProperty` had NO locking at all before this
 * gate existed. Without locking the tenant's own row first: a fresh
 * tenant with 0 active properties, on a plan lacking `multi_property`,
 * firing two genuinely concurrent `POST /properties` could see BOTH
 * requests read "0 other active properties" before either commits — both
 * correctly conclude "this is property #1, no entitlement check applies"
 * — and both succeed, silently granting a non-entitled tenant 2
 * properties. `createProperty` closes this by locking `tenants` (this
 * schema's one natural "exactly one row per tenant" target, scopeRoot:
 * 'tenant') with `SELECT ... FOR UPDATE` before counting or inserting.
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
    return { tenantId, userId };
  }

  async function cleanupTenant(tenantId) {
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('users').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
  }

  it('exactly one of two truly concurrent first-and-second property creations succeeds for a non-entitled tenant; the other is rejected, never both', async () => {
    const suffix = `nonent-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const { tenantId, userId } = await makeTenant(basicPlanId, suffix);

    try {
      const token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId) });

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

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 403]);

      const winner = first.status === 201 ? first : second;
      const loser = first.status === 201 ? second : first;
      expect(winner.body.data.name).toMatch(/^Race Property/);
      expect(loser.body.error.code).toBe('FORBIDDEN_PLAN_ENTITLEMENT');

      // No partial write: exactly one property ever committed, never two.
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
      const token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId) });

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
      expect(Number(count.n)).toBe(2);
    } finally {
      await cleanupTenant(tenantId);
    }
  });
});
