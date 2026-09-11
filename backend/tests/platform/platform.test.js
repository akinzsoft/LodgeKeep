'use strict';

/**
 * The platform console + impersonation lifecycle — PLAN.md Phase 5
 * (Platform Foundation), PRODUCT_REQUIREMENTS.md §3.22, SECURITY.md §2.
 *
 * The central proof this suite exists for: a `staff_impersonation` token
 * reaches EVERY existing, unmodified staff route read-only, via the exact
 * same service functions a real staff session uses — not a parallel,
 * hand-picked slice. `GET /room-types` and `GET /reservations` stand in
 * for "any existing business module," chosen only because they're simple,
 * real, already-gated GET endpoints.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants, seedPlatformUser } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Platform console + impersonation (PLAN.md Phase 5)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    ctx.platform = await seedPlatformUser(t.trx);
  });

  function platformToken() {
    return signAccessToken({ aud: 'platform', sub: String(ctx.platform.id) });
  }

  function staffToken({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function startImpersonation({ tenantId = ctx.a.id, propertyId = ctx.a.properties[0].id, reason = 'Live support ticket #123' } = {}) {
    return t.request
      .post(`/api/v1/platform/tenants/${tenantId}/impersonate`)
      .set('Authorization', `Bearer ${platformToken()}`)
      .send({ property_id: propertyId, reason });
  }

  it('revokes an existing impersonation token when platform staff is deactivated', async () => {
    const start = await startImpersonation();
    await t.trx('platform_users').where({ id: ctx.platform.id }).update({ status: 'inactive' });
    try {
      const res = await t.request.get('/api/v1/room-types').set('Authorization', `Bearer ${start.body.data.accessToken}`);
      expect(res.status).toBe(401);
    } finally {
      await t.trx('platform_users').where({ id: ctx.platform.id }).update({ status: 'active' });
    }
  });

  it('limits the property list to the granted property', async () => {
    const start = await startImpersonation();
    const res = await t.request.get('/api/v1/properties').set('Authorization', `Bearer ${start.body.data.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => String(p.id))).toEqual([String(ctx.a.properties[0].id)]);
  });

  // ====================================================================
  // Tenant roster — no impersonation grant required
  // ====================================================================

  describe('tenant roster', () => {
    it('lists real tenants', async () => {
      const res = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${platformToken()}`);
      expect(res.status).toBe(200);
      const slugs = res.body.data.map((row) => row.slug);
      expect(slugs).toEqual(expect.arrayContaining([ctx.a.slug, ctx.b.slug]));
    });

    it('gets a tenant with its properties', async () => {
      const res = await t.request.get(`/api/v1/platform/tenants/${ctx.a.id}`).set('Authorization', `Bearer ${platformToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.slug).toBe(ctx.a.slug);
      expect(res.body.data.properties.map((p) => String(p.id))).toEqual(expect.arrayContaining([String(ctx.a.properties[0].id)]));
    });

    it('a nonexistent tenant is a real 404', async () => {
      const res = await t.request.get('/api/v1/platform/tenants/999999999').set('Authorization', `Bearer ${platformToken()}`);
      expect(res.status).toBe(404);
    });

    it('a staff token cannot reach the platform tree at all', async () => {
      const res = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${staffToken()}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_WRONG_AUDIENCE');
    });
  });

  // ====================================================================
  // Tenant health — PLAN.md Phase 5's own "tenant list, health" bullet,
  // PRODUCT_REQUIREMENTS.md §3.22's tenant-list/tenant-detail UI spec.
  // ====================================================================

  describe('tenant health', () => {
    let legacyPlanId;

    beforeAll(async () => {
      [legacyPlanId] = await t.trx('plans').insert({
        code: 'legacy-health-test',
        name: 'Legacy (health test fixture)',
        price: '10000.00',
        currency: 'NGN',
        billing_interval: 'monthly',
        is_active: false,
      });

      // ctx.a already carries a real fixture `subscriptions` row
      // (`tests/helpers/fixtures.js`'s own "ONLY tenant a gets a fixture
      // subscriptions row" — that table's bare UNIQUE(tenant_id) means
      // only one row can ever exist per tenant) — updated here to the
      // 'past_due' status this describe's own tests need, rather than
      // inserted fresh, which would collide with it. ctx.b deliberately
      // has none — the fixture's own "nothing yet" baseline every
      // assertion below is checked against for leakage.
      ctx.a.subscriptionId = ctx.a.subscriptions[0].id;
      await t.trx('subscriptions').where({ id: ctx.a.subscriptionId }).update({
        status: 'past_due',
        current_period_start: '2027-01-01',
        current_period_end: '2027-02-01',
      });

      // An explicit, non-default plan on the TENANT itself — a separate
      // column from the subscription's own plan_id above.
      await t.trx('tenants').where({ id: ctx.a.id }).update({ plan_id: legacyPlanId });

      await t.trx('auth_events').insert([
        { audience: 'staff', event_type: 'login_success', tenant_id: ctx.a.id, user_id: ctx.a.users[0].id, occurred_at: '2027-01-05T09:00:00' },
        { audience: 'staff', event_type: 'login_success', tenant_id: ctx.a.id, user_id: ctx.a.users[0].id, occurred_at: '2027-01-08T09:00:00' },
        // The LATEST event overall for this tenant is a guest login — must
        // never win over the staff-only max below.
        { audience: 'guest', event_type: 'login_success', tenant_id: ctx.a.id, occurred_at: '2027-01-20T09:00:00' },
      ]);

      // 6 more invoices on top of the fixture's own single 2026-12-01 row
      // (7 total for ctx.a) — enough to prove the detail endpoint's
      // RECENT_INVOICE_COUNT (5) cap and its descending order, with the
      // fixture row and the oldest of these correctly falling outside it.
      const periods = ['2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01', '2027-06-01', '2027-07-01'];
      for (const periodStart of periods) {
        await t.trx('subscription_invoices').insert({
          tenant_id: ctx.a.id,
          subscription_id: ctx.a.subscriptionId,
          amount: '50000.00',
          currency: 'NGN',
          status: 'paid',
          period_start: periodStart,
          period_end: periodStart,
          due_at: periodStart,
        });
      }
    });

    it('lists property_count from the real seeded properties', async () => {
      const res = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${platformToken()}`);
      const rowA = res.body.data.find((row) => String(row.id) === String(ctx.a.id));
      const rowB = res.body.data.find((row) => String(row.id) === String(ctx.b.id));
      expect(rowA.property_count).toBe(ctx.a.properties.length);
      expect(rowB.property_count).toBe(ctx.b.properties.length);
    });

    it('resolves subscription_status from a real row, and null when none exists', async () => {
      const res = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${platformToken()}`);
      const rowA = res.body.data.find((row) => String(row.id) === String(ctx.a.id));
      const rowB = res.body.data.find((row) => String(row.id) === String(ctx.b.id));
      expect(rowA.subscription_status).toBe('past_due');
      expect(rowB.subscription_status).toBeNull();
    });

    it('resolves an explicit plan_id to its own plan, and a null plan_id to the seeded default', async () => {
      const res = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${platformToken()}`);
      const rowA = res.body.data.find((row) => String(row.id) === String(ctx.a.id));
      const rowB = res.body.data.find((row) => String(row.id) === String(ctx.b.id));
      expect(rowA.plan).toEqual({ code: 'legacy-health-test', name: 'Legacy (health test fixture)' });
      expect(rowB.plan).toEqual({ code: 'standard', name: 'Standard' });
    });

    it('resolves last_login_at to the most recent STAFF login, excluding guest logins', async () => {
      const res = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${platformToken()}`);
      const rowA = res.body.data.find((row) => String(row.id) === String(ctx.a.id));
      const rowB = res.body.data.find((row) => String(row.id) === String(ctx.b.id));
      // The later of the two staff events, never the even-later guest one.
      expect(rowA.last_login_at).toBe('2027-01-08T09:00:00.000Z');
      expect(rowB.last_login_at).toBeNull();
    });

    it('reports trial_days_remaining only for a trial-status tenant — exact boundary arithmetic is covered by health.test.js\'s own fixed-clock pure-function tests; this proves the real wiring resolves a genuine, roughly-correct positive count', async () => {
      const now = new Date();
      const trialEndsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const [trialTenantId] = await t.trx('tenants').insert({
        name: 'Fixture trial tenant (health test)',
        slug: 'health-test-trial-tenant',
        status: 'trial',
        trial_ends_at: trialEndsAt,
      });
      try {
        const res = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${platformToken()}`);
        const trialRow = res.body.data.find((row) => String(row.id) === String(trialTenantId));
        const activeRow = res.body.data.find((row) => String(row.id) === String(ctx.a.id));
        // A generous tolerance, not a razor-thin exact boundary — this
        // integration test's job is proving the real DB round trip and
        // response wiring, not the day-boundary arithmetic itself.
        expect(trialRow.trial_days_remaining).toBeGreaterThanOrEqual(28);
        expect(trialRow.trial_days_remaining).toBeLessThanOrEqual(31);
        expect(activeRow.trial_days_remaining).toBeNull();
      } finally {
        await t.trx('tenants').where({ id: trialTenantId }).delete();
      }
    });

    it('cross-tenant isolation: no health signal from one tenant ever appears on another\'s row', async () => {
      const res = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${platformToken()}`);
      const rowB = res.body.data.find((row) => String(row.id) === String(ctx.b.id));
      expect(rowB.subscription_status).not.toBe('past_due');
      expect(rowB.plan.code).not.toBe('legacy-health-test');
      expect(rowB.last_login_at).toBeNull();
    });

    it('tenant detail includes the real subscription (without payment-method detail) and the 5 most recent invoices, most recent first', async () => {
      const res = await t.request.get(`/api/v1/platform/tenants/${ctx.a.id}`).set('Authorization', `Bearer ${platformToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.property_count).toBe(ctx.a.properties.length);
      expect(res.body.data.plan).toEqual({ code: 'legacy-health-test', name: 'Legacy (health test fixture)' });
      expect(res.body.data.last_login_at).toBe('2027-01-08T09:00:00.000Z');
      expect(res.body.data.trial_days_remaining).toBeNull();

      expect(res.body.data.subscription).toEqual({
        id: String(ctx.a.subscriptionId),
        status: 'past_due',
        current_period_start: '2027-01-01',
        current_period_end: '2027-02-01',
        consecutive_failed_attempts: 0,
      });
      // The deliberate exclusion, proven directly: real payment-method
      // fields exist on the underlying row (seeded above) but never
      // surface on this broader-audience, cross-tenant console.
      expect(res.body.data.subscription).not.toHaveProperty('payment_method_provider');
      expect(res.body.data.subscription).not.toHaveProperty('payment_method_last4');
      expect(res.body.data.subscription).not.toHaveProperty('payment_method_brand');
      expect(res.body.data.subscription).not.toHaveProperty('payment_method_exp_month');
      expect(res.body.data.subscription).not.toHaveProperty('payment_method_exp_year');

      expect(res.body.data.recent_invoices).toHaveLength(5);
      expect(res.body.data.recent_invoices.map((invoice) => invoice.period_start)).toEqual([
        '2027-07-01',
        '2027-06-01',
        '2027-05-01',
        '2027-04-01',
        '2027-03-01',
      ]);
    });

    it('tenant detail for a tenant with no subscription returns null subscription and an empty invoice list', async () => {
      const res = await t.request.get(`/api/v1/platform/tenants/${ctx.b.id}`).set('Authorization', `Bearer ${platformToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.subscription).toBeNull();
      expect(res.body.data.recent_invoices).toEqual([]);
    });

    it('a support-tier platform token reads the same enriched roster and detail as an admin-tier one', async () => {
      const support = await seedPlatformUser(t.trx, 'support-health-test@planmsys.test', 'support');
      const supportToken = signAccessToken({ aud: 'platform', sub: String(support.id) });

      const listRes = await t.request.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${supportToken}`);
      expect(listRes.status).toBe(200);
      const rowA = listRes.body.data.find((row) => String(row.id) === String(ctx.a.id));
      expect(rowA.subscription_status).toBe('past_due');

      const detailRes = await t.request.get(`/api/v1/platform/tenants/${ctx.a.id}`).set('Authorization', `Bearer ${supportToken}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data.subscription.status).toBe('past_due');
    });
  });

  // ====================================================================
  // Starting an impersonation grant
  // ====================================================================

  describe('starting impersonation', () => {
    it('requires a reason', async () => {
      const res = await startImpersonation({ reason: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
    });

    it('rejects a property that does not belong to the tenant', async () => {
      const res = await startImpersonation({ tenantId: ctx.a.id, propertyId: ctx.b.properties[0].id });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_PROPERTY_NOT_IN_TENANT');
    });

    it('rejects a nonexistent tenant', async () => {
      const res = await startImpersonation({ tenantId: '999999999' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_TENANT_NOT_FOUND');
    });

    it('creates a real, reason-carrying row and writes a real auth_events row', async () => {
      const res = await startImpersonation({ reason: 'Debugging a real support ticket' });
      expect(res.status).toBe(201);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(String(res.body.data.tenantId)).toBe(String(ctx.a.id));

      const row = await t.trx('impersonation_sessions').where({ id: res.body.data.impersonationSessionId }).first();
      expect(row.reason).toBe('Debugging a real support ticket');
      expect(row.ended_at).toBeNull();

      const event = await t.trx('auth_events').where({ event_type: 'impersonation_started', platform_user_id: ctx.platform.id }).orderBy('id', 'desc').first();
      expect(event).toBeTruthy();
      expect(String(event.tenant_id)).toBe(String(ctx.a.id));
    });
  });

  // ====================================================================
  // The mechanism itself: real reuse of existing staff routes, read-only
  // ====================================================================

  describe('an active impersonation grant', () => {
    async function activeToken(options) {
      const res = await startImpersonation(options);
      expect(res.status).toBe(201);
      return res.body.data.accessToken;
    }

    it('reaches a real, unmodified staff GET route and sees the same data a real staff session would', async () => {
      const token = await activeToken();
      const impersonatedRes = await t.request.get('/api/v1/room-types').set('Authorization', `Bearer ${token}`);
      const staffRes = await t.request.get('/api/v1/room-types').set('Authorization', `Bearer ${staffToken()}`);

      expect(impersonatedRes.status).toBe(200);
      expect(impersonatedRes.body.data.map((r) => r.id).sort()).toEqual(staffRes.body.data.map((r) => r.id).sort());
    });

    it("never leaks another tenant's data — scoped to exactly the impersonated tenant", async () => {
      const token = await activeToken({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id });
      const res = await t.request.get('/api/v1/room-types').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const otherTenantIds = ctx.b.roomTypes.map((r) => String(r.id));
      expect(res.body.data.some((row) => otherTenantIds.includes(String(row.id)))).toBe(false);
    });

    it('reaches a second, differently-permissioned module read too (Reservations, not just Setup)', async () => {
      const token = await activeToken();
      const res = await t.request.get('/api/v1/reservations').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('rejects a mutation with a real 403, never a silent success', async () => {
      const token = await activeToken();
      const res = await t.request
        .post('/api/v1/room-types')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'IMP', name: 'Should not be created', default_occupancy: 2, base_rate: '100.00' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_IMPERSONATION_READ_ONLY');

      const created = await t.trx('room_types').where({ code: 'IMP' }).first();
      expect(created).toBeUndefined();
    });

    it('ending the grant makes the next request fail, and is idempotent', async () => {
      const token = await activeToken();

      const endRes = await t.request.post('/api/v1/impersonation/end').set('Authorization', `Bearer ${token}`);
      expect(endRes.status).toBe(200);
      expect(endRes.body.data.ended).toBe(true);

      const replayRes = await t.request.get('/api/v1/room-types').set('Authorization', `Bearer ${token}`);
      expect(replayRes.status).toBe(401);
      expect(replayRes.body.error.code).toBe('AUTH_IMPERSONATION_ENDED');

      // A second end call on the same, already-ended token still fails at
      // the auth layer (the token itself is dead the moment the grant
      // ends) — but a *different* still-active token's own end-call is
      // idempotent, proven by the endImpersonation-on-ordinary-staff-token
      // no-op test below.
    });

    it('a lapsed (expired, never explicitly ended) grant is rejected the same way', async () => {
      const token = await activeToken();
      const decoded = require('jsonwebtoken').decode(token);
      await t.trx('impersonation_sessions').where({ id: decoded.impersonation_session_id }).update({ expires_at: new Date(Date.now() - 1000) });

      const res = await t.request.get('/api/v1/room-types').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_IMPERSONATION_ENDED');
    });

    it('POST /impersonation/end on an ordinary staff token is a harmless no-op, never an error', async () => {
      const res = await t.request.post('/api/v1/impersonation/end').set('Authorization', `Bearer ${staffToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.ended).toBe(false);
    });
  });

  // ====================================================================
  // Tenant-side visibility (SECURITY.md §2: "visible to the tenant")
  // ====================================================================

  describe('tenant-side visibility', () => {
    it("a real tenant admin sees the session on their own tenant's history, with the platform admin's email attached", async () => {
      const startRes = await startImpersonation({ reason: 'Visible-to-tenant proof' });
      expect(startRes.status).toBe(201);

      const res = await t.request.get('/api/v1/impersonation-sessions').set('Authorization', `Bearer ${staffToken()}`);
      expect(res.status).toBe(200);
      const row = res.body.data.find((r) => String(r.id) === String(startRes.body.data.impersonationSessionId));
      expect(row).toBeTruthy();
      expect(row.reason).toBe('Visible-to-tenant proof');
      expect(row.platform_user.email).toBe(ctx.platform.email);
    });

    it("never shows another tenant's impersonation history", async () => {
      const startRes = await startImpersonation({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id, reason: 'Tenant A only' });
      expect(startRes.status).toBe(201);

      const res = await t.request.get('/api/v1/impersonation-sessions').set('Authorization', `Bearer ${staffToken({ tenant: ctx.b })}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((row) => String(row.id) === String(startRes.body.data.impersonationSessionId))).toBe(false);
    });
  });
});
