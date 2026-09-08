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

  /** 'YYYY-MM-DD' n months before today — real wall-clock relative dates, since `activityCutoffDate` computes its own cutoff from the real clock, not an injectable one at the HTTP layer. */
  function monthsAgo(n) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString().slice(0, 10);
  }

  async function createGuestWithReservation({ arrivalDate }) {
    const [guestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Activity', last_name: `Test${Date.now()}${Math.random()}` });
    if (arrivalDate) {
      await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        guest_id: guestId,
        room_type_id: ctx.a.roomTypes[0].id,
        rate_code_id: ctx.a.rateCodes[0].id,
        arrival_date: arrivalDate,
        departure_date: '2099-01-02',
        status: 'confirmed',
        confirmation_number: `ACT${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      });
    }
    return guestId;
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

  /**
   * Gap closure (user-reported): "add summary report on the profile num of
   * active and inactive customer. also i hsld be able to click to see
   * active or inactive customers." Confirmed with the user: "active" means
   * a reservation arriving in the last 12 months, not `guests.status`
   * (a GDPR lifecycle field nothing ever sets to anything but `active`).
   */
  describe('active/inactive customer activity', () => {
    it('a guest with a recent reservation is active; a guest with none, or only an old one, is inactive', async () => {
      const recentGuestId = await createGuestWithReservation({ arrivalDate: monthsAgo(3) });
      const oldGuestId = await createGuestWithReservation({ arrivalDate: monthsAgo(18) });
      const neverBookedGuestId = await createGuestWithReservation({ arrivalDate: null });

      const active = await t.request.get('/api/v1/guests').query({ activity: 'active' }).set('Authorization', `Bearer ${tokenFor()}`);
      expect(active.status).toBe(200);
      expect(active.body.data.some((g) => String(g.id) === String(recentGuestId))).toBe(true);
      expect(active.body.data.some((g) => String(g.id) === String(oldGuestId))).toBe(false);
      expect(active.body.data.some((g) => String(g.id) === String(neverBookedGuestId))).toBe(false);

      const inactive = await t.request.get('/api/v1/guests').query({ activity: 'inactive' }).set('Authorization', `Bearer ${tokenFor()}`);
      expect(inactive.status).toBe(200);
      expect(inactive.body.data.some((g) => String(g.id) === String(recentGuestId))).toBe(false);
      expect(inactive.body.data.some((g) => String(g.id) === String(oldGuestId))).toBe(true);
      expect(inactive.body.data.some((g) => String(g.id) === String(neverBookedGuestId))).toBe(true);
    });

    it('an unrecognised activity value returns every guest, unfiltered (the original behaviour)', async () => {
      const withNoFilter = await t.request.get('/api/v1/guests').set('Authorization', `Bearer ${tokenFor()}`);
      const withGarbage = await t.request.get('/api/v1/guests').query({ activity: 'bogus' }).set('Authorization', `Bearer ${tokenFor()}`);
      expect(withGarbage.body.data.length).toBe(withNoFilter.body.data.length);
    });

    it('the activity summary\'s active + inactive counts equal the real total, and reflects a newly-active guest', async () => {
      const before = await t.request.get('/api/v1/guests/activity-summary').set('Authorization', `Bearer ${tokenFor()}`);
      expect(before.status).toBe(200);
      const totalBefore = await t.request.get('/api/v1/guests').set('Authorization', `Bearer ${tokenFor()}`);
      expect(before.body.data.active + before.body.data.inactive).toBe(totalBefore.body.data.length);

      await createGuestWithReservation({ arrivalDate: monthsAgo(1) });

      const after = await t.request.get('/api/v1/guests/activity-summary').set('Authorization', `Bearer ${tokenFor()}`);
      expect(after.body.data.active).toBe(before.body.data.active + 1);
      expect(after.body.data.inactive).toBe(before.body.data.inactive);
    });

    it('never counts another tenant\'s guests, in either the summary or the filtered lists', async () => {
      const bGuestId = await (async () => {
        const [id] = await t.trx('guests').insert({ tenant_id: ctx.b.id, first_name: 'CrossTenant', last_name: `Test${Date.now()}` });
        return id;
      })();

      const summaryA = await t.request.get('/api/v1/guests/activity-summary').set('Authorization', `Bearer ${tokenFor()}`);
      const totalA = await t.request.get('/api/v1/guests').set('Authorization', `Bearer ${tokenFor()}`);
      expect(summaryA.body.data.active + summaryA.body.data.inactive).toBe(totalA.body.data.length);
      expect(totalA.body.data.some((g) => String(g.id) === String(bGuestId))).toBe(false);

      const inactiveA = await t.request.get('/api/v1/guests').query({ activity: 'inactive' }).set('Authorization', `Bearer ${tokenFor()}`);
      expect(inactiveA.body.data.some((g) => String(g.id) === String(bGuestId))).toBe(false);
    });
  });

  describe('RBAC', () => {
    it('requires reservations.view', async () => {
      const res = await t.request.get('/api/v1/guests/search').query({ q: 'x' });
      expect(res.status).toBe(401);
    });
  });
});
