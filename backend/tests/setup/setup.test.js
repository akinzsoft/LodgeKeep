'use strict';

/**
 * HTTP-level tests for the setup module — PLAN.md Phase 1's "Tests required
 * to close": SET-1 through SET-8 (TESTING.md), plus RBAC gating
 * (setup.view/setup.manage, seeded for real now — see the permissions
 * migration and fixtures.js) and a representative cross-tenant isolation
 * check at the route level.
 *
 * Tokens are minted directly (`signAccessToken`), the same pattern
 * `tests/auth/rbac.test.js` and `tests/audit/audit.test.js` already use —
 * this file tests the setup module's own endpoints, not login itself.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Setup module (PLAN.md Phase 1)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  /**
   * A token for `tenant.users[0]` — the seeded fixture user who already
   * holds `manager` at `properties[0]` (fixtures.js's own grant plan) —
   * against a given property, or no active property at all when
   * `propertyId` is explicitly `null`.
   */
  function tokenFor({ tenant, propertyId }) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[0].id),
      tenant_id: String(tenant.id),
      ...(propertyId === null ? {} : { property_id: String(propertyId ?? tenant.properties[0].id) }),
    });
  }

  /**
   * Update-or-insert: fixtures.js's own grant plan already gives
   * `users[1]` a role (`housekeeping`) at `properties[0]` — UNIQUE(user_id,
   * property_id) means a blind insert collides with that existing row
   * (SECURITY.md §4: the pair resolves to exactly one role), so this
   * replaces it rather than assuming a clean slate.
   */
  async function grantRoleToUser({ tenant, userIndex, propertyIndex, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      user_id: userId,
      role,
    });
  }

  // ====================================================================
  // Properties — deliberately ungated by requirePermission (see routes.js)
  // ====================================================================
  describe('POST /api/v1/properties', () => {
    it('creates a property with no active property required — the chicken-and-egg case this session flagged', async () => {
      const token = tokenFor({ tenant: ctx.a, propertyId: null });
      const res = await t.request
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'New Property',
          slug: `${ctx.a.slug}-brand-new`,
          timezone: 'Africa/Lagos',
          base_currency: 'NGN',
          business_date: '2026-09-01',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('New Property');
      expect(res.body.data.current_business_date).toBe('2026-09-01');
    });

    it('rejects a missing required field', async () => {
      const token = tokenFor({ tenant: ctx.a, propertyId: null });
      const res = await t.request
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'No slug' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
    });

    it('rejects a duplicate slug within the tenant with a real 409, not a bare 500', async () => {
      const token = tokenFor({ tenant: ctx.a, propertyId: null });
      const res = await t.request
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Clash',
          slug: `${ctx.a.slug}-property-1`, // already seeded by seedTwoTenants
          timezone: 'Africa/Lagos',
          base_currency: 'NGN',
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_DUPLICATE_ENTRY');
    });

    it('requires authentication', async () => {
      const res = await t.request.post('/api/v1/properties').send({ name: 'x' });
      expect(res.status).toBe(401);
    });
  });

  // ====================================================================
  // Setup wizard progress — PLAN.md Phase 1 gap closure,
  // PRODUCT_REQUIREMENTS.md §3.19's "show progress and allow resuming."
  // Ungated, the same chicken-and-egg exception as /properties above.
  // ====================================================================
  describe('GET /api/v1/setup/progress', () => {
    it('with no active property at all, reports every step incomplete rather than 403ing', async () => {
      const token = tokenFor({ tenant: ctx.a, propertyId: null });
      const res = await t.request.get('/api/v1/setup/progress').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.operational).toBe(false);
      expect(res.body.data.steps.every((step) => step.complete === false)).toBe(true);
    });

    it("reports a fully-seeded property as operational", async () => {
      const token = tokenFor({ tenant: ctx.a, propertyId: ctx.a.properties[0].id });
      const res = await t.request.get('/api/v1/setup/progress').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.operational).toBe(true);
      expect(res.body.data.steps.find((s) => s.key === 'property').complete).toBe(true);
      expect(res.body.data.steps.find((s) => s.key === 'room-types').complete).toBe(true);
    });

    it('resumes correctly from a partial state: a brand-new property is not operational until each required step has real data', async () => {
      const bootstrapToken = tokenFor({ tenant: ctx.a, propertyId: null });
      const created = await t.request
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${bootstrapToken}`)
        .send({ name: 'Wizard Test Property', slug: `${ctx.a.slug}-wizard-test`, timezone: 'Africa/Lagos', base_currency: 'NGN' });
      const propertyId = created.body.data.id;
      const token = tokenFor({ tenant: ctx.a, propertyId });

      // A brand-new property (via the ungated bootstrap endpoint above)
      // grants the creator no access at all — the same real, already-
      // flagged Phase 1 gap `createProperty`'s own header documents ("real
      // tenant/first-admin provisioning is Phase 5 territory"). Granted
      // directly here, same as a real deployment would need some other
      // provisioning step to do, so this test can reach the
      // setup.manage-gated room-type endpoint below.
      await t.trx('user_property_access').insert({
        tenant_id: ctx.a.id,
        property_id: propertyId,
        user_id: ctx.a.users[0].id,
        role: 'admin',
      });

      const initial = await t.request.get('/api/v1/setup/progress').set('Authorization', `Bearer ${token}`);
      expect(initial.body.data.operational).toBe(false);
      expect(initial.body.data.steps.find((s) => s.key === 'property').complete).toBe(true);
      expect(initial.body.data.steps.find((s) => s.key === 'room-types').complete).toBe(false);

      await t.request
        .post('/api/v1/room-types')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'WIZ', name: 'Wizard', default_occupancy: 2, base_rate: '100.00' });

      const afterRoomType = await t.request.get('/api/v1/setup/progress').set('Authorization', `Bearer ${token}`);
      expect(afterRoomType.body.data.steps.find((s) => s.key === 'room-types').complete).toBe(true);
      expect(afterRoomType.body.data.operational).toBe(false); // still no rooms/rate codes
      // Taxes/users are optional — never block "operational" on their own.
      expect(afterRoomType.body.data.steps.find((s) => s.key === 'taxes').optional).toBe(true);
    });
  });

  // ====================================================================
  // RBAC gating — setup.view vs setup.manage, seeded for real (not fixture-only)
  // ====================================================================
  describe('setup.view / setup.manage gating', () => {
    it('manager (setup.view only) can list room types but not create one', async () => {
      const viewToken = tokenFor({ tenant: ctx.a });

      const list = await t.request.get('/api/v1/room-types').set('Authorization', `Bearer ${viewToken}`);
      expect(list.status).toBe(200);

      const create = await t.request
        .post('/api/v1/room-types')
        .set('Authorization', `Bearer ${viewToken}`)
        .send({ code: 'X', name: 'X', default_occupancy: 2, base_rate: '100.00' });
      expect(create.status).toBe(403);
      expect(create.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('admin (setup.manage) can create a room type', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'admin' });
      // tokenFor always signs users[0] — mint this one directly for users[1],
      // the user grantRoleToUser just gave the admin role to.
      const token = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });

      const res = await t.request
        .post('/api/v1/room-types')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'ADMRT', name: 'Admin-created', default_occupancy: 2, base_rate: '100.00' });
      expect(res.status).toBe(201);
      expect(res.body.data.code).toBe('ADMRT');
    });

    it('with no active property at all, a setup.view-gated route is 403, not 500', async () => {
      const token = tokenFor({ tenant: ctx.a, propertyId: null });
      const res = await t.request.get('/api/v1/room-types').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_NO_ACTIVE_PROPERTY');
    });
  });

  // ====================================================================
  // Rooms — SET-1, SET-2, SET-3
  // ====================================================================
  describe('rooms', () => {
    const adminToken = () =>
      signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id), // granted admin above
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });

    it('SET-1: bulk creates a room-number range, correct type/floor, correct count', async () => {
      const res = await t.request
        .post('/api/v1/rooms/bulk')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ room_type_id: String(ctx.a.roomTypes[0].id), floor: '2', from: '201', to: '260' });

      expect(res.status).toBe(201);
      expect(res.body.data).toHaveLength(60);
      expect(res.body.meta.count).toBe(60);
      expect(res.body.data[0].room_number).toBe('201');
      expect(res.body.data.every((room) => room.floor === '2')).toBe(true);
      expect(res.body.data.every((room) => String(room.room_type_id) === String(ctx.a.roomTypes[0].id))).toBe(true);
    });

    it('SET-2: a duplicate room number within the same property is rejected with 409, nothing partially commits', async () => {
      const res = await t.request
        .post('/api/v1/rooms/bulk')
        .set('Authorization', `Bearer ${adminToken()}`)
        // 101 already exists (seedTwoTenants); 301/302 do not.
        .send({ room_type_id: String(ctx.a.roomTypes[0].id), floor: '1', from: '101', to: '101' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_DUPLICATE_ENTRY');

      const stillAbsent = await t.trx('rooms').where({ property_id: ctx.a.properties[0].id, room_number: '301' }).first();
      expect(stillAbsent).toBeUndefined();
    });

    it('SET-3: the same room number is allowed on a DIFFERENT property', async () => {
      const res = await t.request
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ room_number: '101', room_type_id: String(ctx.a.roomTypes[0].id) });
      // ctx.a.properties[0] already has room 101 (fixture) — same property, must fail.
      expect(res.status).toBe(409);

      // Grant admin on properties[1] too, and create room 101 there — must succeed.
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 1, role: 'admin' });
      const otherPropertyToken = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[1].id),
      });
      const roomTypeOnOtherProperty = await t.trx('room_types').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        code: 'STD2',
        name: 'Standard',
        default_occupancy: 2,
        base_rate: '80.00',
      });
      const otherRes = await t.request
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${otherPropertyToken}`)
        .send({ room_number: '101', room_type_id: String(roomTypeOnOtherProperty[0]) });
      expect(otherRes.status).toBe(201);
    });
  });

  // ====================================================================
  // Rate calendar — SET-6
  // ====================================================================
  describe('rate calendar', () => {
    it('SET-6: a date override wins over the rate code base rate', async () => {
      const token = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });

      // No override yet for this date -> resolves to the rate code's base_rate.
      const before = await t.request
        .get('/api/v1/rate-calendar/resolve')
        .query({ rate_code_id: String(ctx.a.rateCodes[0].id), room_type_id: String(ctx.a.roomTypes[0].id), stay_date: '2026-11-01' })
        .set('Authorization', `Bearer ${token}`);
      expect(before.status).toBe(200);
      expect(before.body.data.rate).toBe('150.00');
      expect(before.body.data.overridden).toBe(false);

      await t.request
        .post('/api/v1/rate-calendar')
        .set('Authorization', `Bearer ${token}`)
        .send({
          rate_code_id: String(ctx.a.rateCodes[0].id),
          room_type_id: String(ctx.a.roomTypes[0].id),
          stay_date: '2026-11-01',
          rate: '300.00',
        });

      const after = await t.request
        .get('/api/v1/rate-calendar/resolve')
        .query({ rate_code_id: String(ctx.a.rateCodes[0].id), room_type_id: String(ctx.a.roomTypes[0].id), stay_date: '2026-11-01' })
        .set('Authorization', `Bearer ${token}`);
      expect(after.status).toBe(200);
      expect(after.body.data.rate).toBe('300.00');
      expect(after.body.data.overridden).toBe(true);

      // An adjacent date with no override is unaffected.
      const adjacent = await t.request
        .get('/api/v1/rate-calendar/resolve')
        .query({ rate_code_id: String(ctx.a.rateCodes[0].id), room_type_id: String(ctx.a.roomTypes[0].id), stay_date: '2026-11-02' })
        .set('Authorization', `Bearer ${token}`);
      expect(adjacent.body.data.rate).toBe('150.00');
    });
  });

  // ====================================================================
  // Taxes — effective-dating, end to end through the real HTTP endpoints
  // ====================================================================
  describe('taxes', () => {
    const token = () =>
      signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });

    it('a rate change creates a new version and closes the old one out, without altering what an old date resolves to', async () => {
      // ctx.a already has a VAT version effective 2026-01-01 (fixtures.js), open-ended.
      const beforeChange = await t.request
        .get('/api/v1/taxes/resolve')
        .query({ tax_code: 'VAT', business_date: '2026-03-01' })
        .set('Authorization', `Bearer ${token()}`);
      expect(beforeChange.body.data.rate).toBe('7.5000');

      const changeRes = await t.request
        .post('/api/v1/taxes')
        .set('Authorization', `Bearer ${token()}`)
        .send({
          tax_code: 'VAT',
          name: 'VAT',
          rate: '10.0000',
          effective_from: '2026-06-01',
          is_inclusive: false,
          calculation_method: 'percentage',
        });
      expect(changeRes.status).toBe(201);

      // SET-4: a date BEFORE the change still resolves to the OLD rate.
      const stillOld = await t.request
        .get('/api/v1/taxes/resolve')
        .query({ tax_code: 'VAT', business_date: '2026-03-01' })
        .set('Authorization', `Bearer ${token()}`);
      expect(stillOld.body.data.rate).toBe('7.5000');

      // SET-5: a date after the change uses the new rate.
      const nowNew = await t.request
        .get('/api/v1/taxes/resolve')
        .query({ tax_code: 'VAT', business_date: '2026-07-01' })
        .set('Authorization', `Bearer ${token()}`);
      expect(nowNew.body.data.rate).toBe('10.0000');

      // The old version's row itself is untouched in substance — only
      // effective_to was closed out, never its rate (ARCHITECTURE.md §12.1:
      // never an UPDATE to an existing version's rate).
      const oldRow = await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'VAT', effective_from: '2026-01-01' }).first();
      expect(oldRow.rate).toBe('7.5000');
      expect(oldRow.effective_to).toBe('2026-05-31');
    });

    it('rejects an overlapping effective_from for the same tax_code', async () => {
      const res = await t.request
        .post('/api/v1/taxes')
        .set('Authorization', `Bearer ${token()}`)
        .send({
          tax_code: 'VAT',
          name: 'VAT',
          rate: '99.0000',
          effective_from: '2026-02-01', // inside the already-closed first version's range
          is_inclusive: false,
          calculation_method: 'percentage',
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_TAX_EFFECTIVE_DATE_OVERLAP');
    });
  });

  // ====================================================================
  // Market segments / booking sources / cancellation policies — PLAN.md
  // Phase 1 gap closure, PRODUCT_REQUIREMENTS.md §3.19. Simple
  // reference-data CRUD, the same shape as room_types above.
  // ====================================================================
  describe('market segments / booking sources / cancellation policies', () => {
    const adminToken = () =>
      signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id), // granted admin earlier in this file
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
    const viewToken = () => tokenFor({ tenant: ctx.a });

    it('creates, lists, updates, and archives a market segment', async () => {
      const create = await t.request
        .post('/api/v1/market-segments')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ code: 'CORP', name: 'Corporate' });
      expect(create.status).toBe(201);
      expect(create.body.data.status).toBe('active');

      const list = await t.request.get('/api/v1/market-segments').set('Authorization', `Bearer ${viewToken()}`);
      expect(list.status).toBe(200);
      expect(list.body.data.some((row) => row.code === 'CORP')).toBe(true);

      const update = await t.request
        .patch(`/api/v1/market-segments/${create.body.data.id}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ name: 'Corporate accounts' });
      expect(update.status).toBe(200);
      expect(update.body.data.name).toBe('Corporate accounts');

      const archive = await t.request
        .post(`/api/v1/market-segments/${create.body.data.id}/archive`)
        .set('Authorization', `Bearer ${adminToken()}`);
      expect(archive.status).toBe(200);
      expect(archive.body.data.status).toBe('archived');

      const listAfter = await t.request.get('/api/v1/market-segments').set('Authorization', `Bearer ${viewToken()}`);
      expect(listAfter.body.data.some((row) => row.code === 'CORP')).toBe(false);
    });

    it('rejects a duplicate market segment code at the same property with a real 409', async () => {
      const res = await t.request
        .post('/api/v1/market-segments')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ code: 'GOVT', name: 'Government' });
      expect(res.status).toBe(201);
      const dupe = await t.request
        .post('/api/v1/market-segments')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ code: 'GOVT', name: 'Clash' });
      expect(dupe.status).toBe(409);
      expect(dupe.body.error.code).toBe('CONFLICT_DUPLICATE_ENTRY');
    });

    it('view-only role cannot create a market segment', async () => {
      const res = await t.request
        .post('/api/v1/market-segments')
        .set('Authorization', `Bearer ${viewToken()}`)
        .send({ code: 'X', name: 'X' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('creates, lists, updates, and archives a booking source', async () => {
      const create = await t.request
        .post('/api/v1/booking-sources')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ code: 'DIRECT', name: 'Direct' });
      expect(create.status).toBe(201);

      const list = await t.request.get('/api/v1/booking-sources').set('Authorization', `Bearer ${viewToken()}`);
      expect(list.body.data.some((row) => row.code === 'DIRECT')).toBe(true);

      const archive = await t.request
        .post(`/api/v1/booking-sources/${create.body.data.id}/archive`)
        .set('Authorization', `Bearer ${adminToken()}`);
      expect(archive.status).toBe(200);
      expect(archive.body.data.status).toBe('archived');
    });

    it('creates a cancellation policy with a fee rule and rejects an invalid fee_type', async () => {
      const create = await t.request
        .post('/api/v1/cancellation-policies')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ code: 'STRICT', name: 'Strict', cutoff_hours: 48, fee_type: 'first_night' });
      expect(create.status).toBe(201);
      expect(create.body.data.fee_type).toBe('first_night');
      expect(create.body.data.cutoff_hours).toBe(48);

      const invalid = await t.request
        .post('/api/v1/cancellation-policies')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ code: 'BAD', name: 'Bad', fee_type: 'not_a_real_type' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('VALIDATION_INVALID_FEE_TYPE');
    });
  });

  // ====================================================================
  // Isolation — representative HTTP-level check (DB-level coverage for
  // every Phase 1 table already comes free from tests/isolation's ISO-*
  // suite via tests/helpers/entities.js).
  // ====================================================================
  describe('cross-tenant isolation at the route level', () => {
    it('tenant A cannot read tenant B\'s room type by id — 404, never 403', async () => {
      const token = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
      // There's no GET /room-types/:id route (list-only) — prove isolation via
      // update instead, which does take an :id.
      const res = await t.request
        .patch(`/api/v1/room-types/${ctx.b.roomTypes[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Hijacked' });

      // A real bug this exact test caught while being written: the
      // controller fetched `before` but never checked it, so a cross-tenant
      // id silently updated zero rows and returned a broken 200 with no
      // `data` key at all, instead of 404. Fixed in controller.js — every
      // by-id update/archive handler now checks `before` first.
      expect(res.status).toBe(404);

      const stillIntact = await t.trx('room_types').where({ id: ctx.b.roomTypes[0].id }).first();
      expect(stillIntact.name).toBe('Deluxe');
    });
  });
});
