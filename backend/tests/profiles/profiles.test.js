'use strict';

/**
 * HTTP-level tests for Profiles (Guest CRM) — PLAN.md Phase 2 gap closure,
 * PRODUCT_REQUIREMENTS.md §3.1's "create, search, stay history."
 *
 * Tokens are minted directly (`signAccessToken`), the same pattern
 * `tests/reservations/reservations.test.js` already uses.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Profiles / Guest CRM (PLAN.md Phase 2 gap closure)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  function tokenFor({ tenant = ctx.a, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  describe('search', () => {
    it('finds a guest by a substring of their first name', async () => {
      const res = await t.request
        .get('/api/v1/guests/search')
        .query({ q: 'Jordan' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((g) => String(g.id) === String(ctx.a.guests[0].id))).toBe(true);
    });

    it('finds a guest by a substring of their email', async () => {
      const res = await t.request
        .get('/api/v1/guests/search')
        .query({ q: `guest-${ctx.a.slug}` })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((g) => String(g.id) === String(ctx.a.guests[0].id))).toBe(true);
    });

    it('never returns another tenant\'s guest, even on an identical query', async () => {
      const res = await t.request
        .get('/api/v1/guests/search')
        .query({ q: 'Jordan' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.body.data.some((g) => String(g.id) === String(ctx.b.guests[0].id))).toBe(false);
    });

    it('requires the query parameter', async () => {
      const res = await t.request.get('/api/v1/guests/search').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
    });
  });

  describe('get by id', () => {
    it('returns a real guest by id', async () => {
      const res = await t.request.get(`/api/v1/guests/${ctx.a.guests[0].id}`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.first_name).toBe('Jordan');
    });

    it("404s another tenant's guest, never 403", async () => {
      const res = await t.request.get(`/api/v1/guests/${ctx.b.guests[0].id}`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(404);
    });
  });

  describe('stay history', () => {
    it("lists the guest's reservations across every property in the tenant", async () => {
      const res = await t.request
        .get(`/api/v1/guests/${ctx.a.guests[0].id}/stay-history`)
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((r) => String(r.id) === String(ctx.a.reservations[0].id))).toBe(true);
    });

    it('404s stay history for a nonexistent guest id', async () => {
      const res = await t.request.get('/api/v1/guests/999999999/stay-history').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(404);
    });
  });

  describe('RBAC', () => {
    it('requires reservations.view', async () => {
      const res = await t.request.get('/api/v1/guests/search').query({ q: 'x' });
      expect(res.status).toBe(401);
    });
  });
});
