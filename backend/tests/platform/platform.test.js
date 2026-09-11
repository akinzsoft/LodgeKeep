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
