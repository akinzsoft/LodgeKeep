'use strict';

/**
 * HTTP-level tests for the reporting module — PLAN.md Phase 3's "Tests
 * required to close": "Report figures reconcile against the underlying
 * folio data for a seeded day" (this pass's real scope is occupancy/revenue
 * reconciled against `room_type_inventory`/`reservation_daily_rates`
 * instead — see `src/modules/reporting/index.js`'s own header for why
 * there is no folio-based financial report yet) and "Exports respect the
 * filters applied on screen."
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants, seedPlatformUser } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Reporting (PLAN.md Phase 3)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  function tokenFor({ userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? ctx.a.users[0].id),
      tenant_id: String(ctx.a.id),
      property_id: String(propertyId ?? ctx.a.properties[0].id),
    });
  }

  async function grantRoleToUser({ userIndex, propertyIndex, role }) {
    const propertyId = ctx.a.properties[propertyIndex].id;
    const userId = ctx.a.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  describe('occupancy', () => {
    let roomTypeId;

    beforeAll(async () => {
      const [id] = await t.trx('room_types').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        code: `RPTTYPE${Date.now().toString(36)}`,
        name: 'Report Type',
        default_occupancy: 2,
        base_rate: '100.00',
      });
      roomTypeId = id;
      // Two physical rooms, one out of service — physical count must be 1.
      await t.trx('rooms').insert([
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, room_type_id: roomTypeId, room_number: `RA${Date.now().toString(36)}`, status: 'active' },
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, room_type_id: roomTypeId, room_number: `RB${Date.now().toString(36)}`, status: 'out_of_service' },
      ]);
      await t.trx('room_type_inventory').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_type_id: roomTypeId,
        stay_date: '2027-05-10',
        rooms_sold: 1,
        overbooking_threshold_pct: '100.00',
      });
    });

    it('reports occupancy reconciled against room_type_inventory and the live physical count', async () => {
      const res = await t.request
        .get('/api/v1/reports/occupancy')
        .query({ date_from: '2027-05-10', date_to: '2027-05-10' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      const day = res.body.data.find((d) => d.date === '2027-05-10');
      expect(day.roomsSold).toBeGreaterThanOrEqual(1);
      expect(day.physicalCount).toBeGreaterThanOrEqual(1);
      expect(day.occupancyPct).toBeGreaterThan(0);
    });

    it('exports occupancy as CSV reflecting the same filtered date range', async () => {
      const res = await t.request
        .get('/api/v1/reports/occupancy')
        .query({ date_from: '2027-05-10', date_to: '2027-05-10', format: 'csv' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text).toContain('date,physicalCount,roomsSold,occupancyPct');
      expect(res.text).toContain('2027-05-10');
    });

    it('front_desk (Limited: reports.view only) can read occupancy', async () => {
      await grantRoleToUser({ userIndex: 1, propertyIndex: 0, role: 'front_desk' });
      const res = await t.request
        .get('/api/v1/reports/occupancy')
        .query({ date_from: '2027-05-10', date_to: '2027-05-10' })
        .set('Authorization', `Bearer ${tokenFor({ userId: ctx.a.users[1].id })}`);
      expect(res.status).toBe(200);
    });
  });

  describe('revenue', () => {
    let reservationId;
    let cancelledReservationId;

    beforeAll(async () => {
      const [guestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Rev', last_name: 'Guest' });
      const [rateCodeId] = await t.trx('rate_codes').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        code: `RPTRATE${Date.now().toString(36)}`,
        base_rate: '133.33',
        currency: 'NGN',
        valid_from: '2026-01-01',
      });
      const [roomTypeId] = await t.trx('room_types').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        code: `RPTTYPE2${Date.now().toString(36)}`,
        name: 'Report Revenue Type',
        default_occupancy: 2,
        base_rate: '133.33',
      });
      await t.trx('rooms').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_type_id: roomTypeId,
        room_number: `RREV${Date.now().toString(36)}`,
        status: 'active',
      });

      [reservationId] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        guest_id: guestId,
        room_type_id: roomTypeId,
        rate_code_id: rateCodeId,
        arrival_date: '2027-06-01',
        departure_date: '2027-06-03',
        status: 'confirmed',
        confirmation_number: `RPTCONF${Date.now().toString(36)}`,
      });
      await t.trx('reservation_daily_rates').insert([
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, reservation_id: reservationId, stay_date: '2027-06-01', rate: '133.33', currency: 'NGN' },
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, reservation_id: reservationId, stay_date: '2027-06-02', rate: '133.34', currency: 'NGN' },
      ]);

      // A cancelled reservation on the same date — must NOT count toward revenue.
      [cancelledReservationId] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        guest_id: guestId,
        room_type_id: roomTypeId,
        rate_code_id: rateCodeId,
        arrival_date: '2027-06-01',
        departure_date: '2027-06-02',
        status: 'cancelled',
        confirmation_number: `RPTCANCEL${Date.now().toString(36)}`,
      });
      await t.trx('reservation_daily_rates').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        reservation_id: cancelledReservationId,
        stay_date: '2027-06-01',
        rate: '999.99',
        currency: 'NGN',
      });
    });

    it('sums exact decimal revenue, excludes cancelled reservations, and computes ADR', async () => {
      const res = await t.request
        .get('/api/v1/reports/revenue')
        .query({ date_from: '2027-06-01', date_to: '2027-06-01' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      const day = res.body.data.find((d) => d.date === '2027-06-01');
      // Exactly 133.33 — not 133.33 + 999.99 (the cancelled row), and not a
      // float-drifted value.
      expect(day.roomRevenue).toBe('133.33');
      expect(day.roomsSold).toBe(1);
      expect(day.adr).toBe('133.33');
    });

    it('front_desk (Limited) cannot read the financial revenue report', async () => {
      const res = await t.request
        .get('/api/v1/reports/revenue')
        .query({ date_from: '2027-06-01', date_to: '2027-06-01' })
        .set('Authorization', `Bearer ${tokenFor({ userId: ctx.a.users[1].id })}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('manager (full reports access) can read the financial revenue report', async () => {
      const res = await t.request
        .get('/api/v1/reports/revenue')
        .query({ date_from: '2027-06-01', date_to: '2027-06-01' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
    });
  });

  describe('housekeeping summary & oversold room types', () => {
    it('summarises discrepancies and assignment status counts for a business date', async () => {
      const [roomTypeId] = await t.trx('room_types').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        code: `RPTHK${Date.now().toString(36)}`,
        name: 'HK Report Type',
        default_occupancy: 2,
        base_rate: '100.00',
      });
      const [roomId] = await t.trx('rooms').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_type_id: roomTypeId,
        room_number: `RHK${Date.now().toString(36)}`,
        status: 'active',
      });
      await t.trx('housekeeping_assignments').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_id: roomId,
        attendant_user_id: ctx.a.users[0].id,
        business_date: '2027-07-01',
        status: 'completed',
        completed_at: new Date(),
      });
      await t.trx('housekeeping_discrepancies').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_id: roomId,
        business_date: '2027-07-01',
        front_desk_status: 'vacant',
        housekeeping_status: 'occupied',
      });

      const res = await t.request
        .get('/api/v1/reports/housekeeping')
        .query({ business_date: '2027-07-01' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.openDiscrepancies).toBeGreaterThanOrEqual(1);
      expect(res.body.data.assignments.completed).toBeGreaterThanOrEqual(1);
    });

    it('flags a room type oversold beyond its configured threshold', async () => {
      const [roomTypeId] = await t.trx('room_types').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        code: `RPTOVER${Date.now().toString(36)}`,
        name: 'Oversold Type',
        default_occupancy: 2,
        base_rate: '100.00',
      });
      await t.trx('rooms').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_type_id: roomTypeId,
        room_number: `ROV${Date.now().toString(36)}`,
        status: 'active',
      });
      await t.trx('room_type_inventory').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_type_id: roomTypeId,
        stay_date: '2027-07-15',
        rooms_sold: 2,
        overbooking_threshold_pct: '100.00',
      });

      const res = await t.request
        .get('/api/v1/reports/oversold')
        .query({ business_date: '2027-07-15' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((row) => String(row.roomTypeId) === String(roomTypeId))).toBe(true);
    });
  });

  // ==========================================================================
  // Night Audit reconciliation — PLAN.md Phase 2.5 closes Phase 3's own named
  // gap: "Report figures reconcile against the underlying folio data."
  // ==========================================================================

  describe('audited (Night Audit) reconciliation', () => {
    it('a business_date Night Audit has closed reads its real daily_reports snapshot, not the live computation', async () => {
      const [runId] = await t.trx('night_audit_runs').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        business_date: '2027-08-01',
        status: 'COMPLETED',
        worker_id: 'reporting-test-worker',
        heartbeat_at: new Date(),
        started_at: new Date(),
        completed_at: new Date(),
      });
      await t.trx('daily_reports').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        night_audit_run_id: runId,
        business_date: '2027-08-01',
        room_revenue: '999.00',
        pos_revenue: '0.00',
        payments_collected: '500.00',
        occupancy_pct: '88.88',
        adr: '111.00',
        revpar: '99.90',
      });

      const occupancyRes = await t.request
        .get('/api/v1/reports/occupancy')
        .query({ date_from: '2027-08-01', date_to: '2027-08-01' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      const occupancyDay = occupancyRes.body.data.find((d) => d.date === '2027-08-01');
      expect(occupancyDay.audited).toBe(true);
      expect(occupancyDay.occupancyPct).toBe(88.88);

      const revenueRes = await t.request
        .get('/api/v1/reports/revenue')
        .query({ date_from: '2027-08-01', date_to: '2027-08-01' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      const revenueDay = revenueRes.body.data.find((d) => d.date === '2027-08-01');
      expect(revenueDay.audited).toBe(true);
      expect(revenueDay.roomRevenue).toBe('999.00'); // The real ledger figure, not a reservation_daily_rates guess.
      expect(revenueDay.adr).toBe('111.00');
      expect(revenueDay.revpar).toBe('99.90');
      expect(revenueDay.paymentsCollected).toBe('500.00');
    });

    it('a date with no daily_reports snapshot yet still falls back to the live computation, flagged audited: false', async () => {
      const res = await t.request
        .get('/api/v1/reports/occupancy')
        .query({ date_from: '2027-08-20', date_to: '2027-08-20' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      const day = res.body.data.find((d) => d.date === '2027-08-20');
      expect(day.audited).toBe(false);
    });
  });

  // ==========================================================================
  // Chain overview — PLAN.md Phase 6's Multi-Property Roll-Up
  // (PRODUCT_REQUIREMENTS.md §3.13), reusing computeOccupancy/computeRevenue
  // per active property. Property[0] is NGN, Property[1] is GBP — the exact
  // fixture shape already established by seedTwoTenants — so the same
  // seeding proves both correct aggregation math and mixed-currency
  // grouping at once.
  // ==========================================================================

  describe('chain overview (PLAN.md Phase 6)', () => {
    let superAdminUserId;
    let adminUserId;

    async function createUserWithRole(role) {
      const suffix = `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const [userId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email: `chain-${suffix}@example.com`,
        first_name: 'Chain',
        last_name: role,
        password_hash: 'x',
        status: 'active',
      });
      await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, user_id: userId, role });
      return userId;
    }

    function tokenForUser(userId) {
      return signAccessToken({
        aud: 'staff',
        sub: String(userId),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
    }

    beforeAll(async () => {
      // Each property's own "today" — ARCHITECTURE.md §6, never wall-clock,
      // and every property in a chain can legitimately be at a different
      // point in time.
      await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-09-01' });
      await t.trx('properties').where({ id: ctx.a.properties[1].id }).update({ current_business_date: '2027-09-05' });

      // Property[0] (NGN, from the fixture): 1 of 2 physical rooms sold -> 50% occupancy, NGN 250.00 revenue.
      const [roomTypeAId] = await t.trx('room_types').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        code: `CHAINA${Date.now().toString(36)}`,
        name: 'Chain Type A',
        default_occupancy: 2,
        base_rate: '250.00',
      });
      await t.trx('rooms').insert([
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, room_type_id: roomTypeAId, room_number: `CA1${Date.now().toString(36)}`, status: 'active' },
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, room_type_id: roomTypeAId, room_number: `CA2${Date.now().toString(36)}`, status: 'active' },
      ]);
      await t.trx('room_type_inventory').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_type_id: roomTypeAId,
        stay_date: '2027-09-01',
        rooms_sold: 1,
        overbooking_threshold_pct: '100.00',
      });
      const [guestAId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Chain', last_name: 'GuestA' });
      const [rateCodeAId] = await t.trx('rate_codes').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        code: `CHAINRATEA${Date.now().toString(36)}`,
        base_rate: '250.00',
        currency: 'NGN',
        valid_from: '2026-01-01',
      });
      const [reservationAId] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        guest_id: guestAId,
        room_type_id: roomTypeAId,
        rate_code_id: rateCodeAId,
        arrival_date: '2027-09-01',
        departure_date: '2027-09-02',
        status: 'confirmed',
        confirmation_number: `CHAINCONFA${Date.now().toString(36)}`,
      });
      await t.trx('reservation_daily_rates').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        reservation_id: reservationAId,
        stay_date: '2027-09-01',
        rate: '250.00',
        currency: 'NGN',
      });

      // Property[1] (GBP, from the fixture): 1 of 1 physical rooms sold -> 100% occupancy, GBP 80.00 revenue.
      const [roomTypeBId] = await t.trx('room_types').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        code: `CHAINB${Date.now().toString(36)}`,
        name: 'Chain Type B',
        default_occupancy: 2,
        base_rate: '80.00',
      });
      await t.trx('rooms').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        room_type_id: roomTypeBId,
        room_number: `CB1${Date.now().toString(36)}`,
        status: 'active',
      });
      await t.trx('room_type_inventory').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        room_type_id: roomTypeBId,
        stay_date: '2027-09-05',
        rooms_sold: 1,
        overbooking_threshold_pct: '100.00',
      });
      const [guestBId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Chain', last_name: 'GuestB' });
      const [rateCodeBId] = await t.trx('rate_codes').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        code: `CHAINRATEB${Date.now().toString(36)}`,
        base_rate: '80.00',
        currency: 'GBP',
        valid_from: '2026-01-01',
      });
      const [reservationBId] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        guest_id: guestBId,
        room_type_id: roomTypeBId,
        rate_code_id: rateCodeBId,
        arrival_date: '2027-09-05',
        departure_date: '2027-09-06',
        status: 'confirmed',
        confirmation_number: `CHAINCONFB${Date.now().toString(36)}`,
      });
      await t.trx('reservation_daily_rates').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        reservation_id: reservationBId,
        stay_date: '2027-09-05',
        rate: '80.00',
        currency: 'GBP',
      });

      superAdminUserId = await createUserWithRole('super_admin');
      adminUserId = await createUserWithRole('admin');
    });

    it('super_admin gets a 200 with correct aggregation math across two real, distinctly-currencied properties', async () => {
      const res = await t.request.get('/api/v1/reports/chain-overview').set('Authorization', `Bearer ${tokenForUser(superAdminUserId)}`);
      expect(res.status).toBe(200);
      const { properties, totals } = res.body.data;

      const propertyA = properties.find((p) => String(p.propertyId) === String(ctx.a.properties[0].id));
      const propertyB = properties.find((p) => String(p.propertyId) === String(ctx.a.properties[1].id));
      // roomsSold/roomRevenue are exact and fully controlled by this test's own
      // seeded reservation_daily_rates/room_type_inventory rows. occupancyPct
      // for property[0] is NOT hardcoded here — livePhysicalCount is a real,
      // property-wide count of every active room regardless of room type, and
      // property[0] already carries other active rooms from the base Setup
      // fixture plus the earlier describe blocks above in this same file, so
      // any fixed expected percentage would be a fragile guess at that total.
      // property[1] is untouched by anything else in this file (the base
      // fixture only seeds properties[0]), so its 1-sold-of-1-active room is
      // genuinely exact.
      expect(propertyA).toMatchObject({ businessDate: '2027-09-01', roomsSold: 1, roomRevenue: '250.00', currencyCode: 'NGN' });
      expect(propertyA.occupancyPct).toBeGreaterThan(0);
      expect(propertyA.occupancyPct).toBeLessThanOrEqual(100);
      expect(propertyB).toMatchObject({ businessDate: '2027-09-05', occupancyPct: 100, roomsSold: 1, roomRevenue: '80.00', currencyCode: 'GBP' });

      // Never blended across currencies (ARCHITECTURE.md §1) — two separate entries, not one summed total.
      expect(totals.totalRoomsSoldToday).toBe(2);
      // The chain-wide average is a plain, unweighted mean of the two real
      // per-property figures just asserted above — proven self-consistently
      // rather than against a second hardcoded guess.
      expect(totals.averageOccupancyPctToday).toBe(Number(((propertyA.occupancyPct + propertyB.occupancyPct) / 2).toFixed(2)));
      expect(totals.revenueByCurrency).toEqual(
        expect.arrayContaining([
          { currencyCode: 'NGN', totalRoomRevenue: '250.00' },
          { currencyCode: 'GBP', totalRoomRevenue: '80.00' },
        ])
      );
      expect(totals.revenueByCurrency).toHaveLength(2);
    });

    it('admin gets 403 — the second admin/super_admin divergence in this matrix, after room_types.update', async () => {
      const res = await t.request.get('/api/v1/reports/chain-overview').set('Authorization', `Bearer ${tokenForUser(adminUserId)}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('manager (full reports.view_financial access, but not the chain key) gets 403', async () => {
      // tokenFor()'s own default is ctx.a.users[0] @ properties[0], granted 'manager' by the shared fixture.
      const res = await t.request.get('/api/v1/reports/chain-overview').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('front_desk gets 403', async () => {
      // ctx.a.users[1] @ properties[0] was reassigned to front_desk by the earlier "occupancy" describe block above.
      const res = await t.request.get('/api/v1/reports/chain-overview').set('Authorization', `Bearer ${tokenFor({ userId: ctx.a.users[1].id })}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('excludes a property with no business date configured from every total, but still lists it', async () => {
      const [unconfiguredPropertyId] = await t.trx('properties').insert({
        tenant_id: ctx.a.id,
        slug: `chain-unconfigured-${Date.now().toString(36)}`,
        name: 'Chain Unconfigured Property',
        timezone: 'UTC',
        base_currency: 'NGN',
        status: 'active',
      });

      const res = await t.request.get('/api/v1/reports/chain-overview').set('Authorization', `Bearer ${tokenForUser(superAdminUserId)}`);
      expect(res.status).toBe(200);
      const { properties, totals } = res.body.data;
      const row = properties.find((p) => String(p.propertyId) === String(unconfiguredPropertyId));
      expect(row).toMatchObject({ businessDate: null, occupancyPct: null, roomsSold: null, roomRevenue: null });
      // The unconfigured property never joins the denominator — still exactly the 2 properly-configured properties.
      expect(totals.configuredPropertyCount).toBe(2);
    });

    it('never includes tenant B’s properties in tenant A’s roll-up', async () => {
      const res = await t.request.get('/api/v1/reports/chain-overview').set('Authorization', `Bearer ${tokenForUser(superAdminUserId)}`);
      expect(res.status).toBe(200);
      const propertyIds = res.body.data.properties.map((p) => String(p.propertyId));
      expect(propertyIds).not.toContain(String(ctx.b.properties[0].id));
      expect(propertyIds).not.toContain(String(ctx.b.properties[1].id));
    });

    it('exports the per-property breakdown as CSV, never the blended totals', async () => {
      const res = await t.request
        .get('/api/v1/reports/chain-overview')
        .query({ format: 'csv' })
        .set('Authorization', `Bearer ${tokenForUser(superAdminUserId)}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text).toContain('propertyId,propertyName,currencyCode,businessDate,occupancyPct,roomsSold,roomRevenue,audited');
      expect(res.text).toContain('2027-09-01');
      expect(res.text).not.toMatch(/averageOccupancyPctToday|revenueByCurrency/);
    });

    it('under impersonation, sees only the one impersonated property, never the rest of the chain', async () => {
      const platform = await seedPlatformUser(t.trx);
      const platformToken = signAccessToken({ aud: 'platform', sub: String(platform.id) });
      const startRes = await t.request
        .post(`/api/v1/platform/tenants/${ctx.a.id}/impersonate`)
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ property_id: ctx.a.properties[0].id, reason: 'Chain overview isolation proof' });
      expect(startRes.status).toBe(201);

      const res = await t.request
        .get('/api/v1/reports/chain-overview')
        .set('Authorization', `Bearer ${startRes.body.data.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.properties.map((p) => String(p.propertyId))).toEqual([String(ctx.a.properties[0].id)]);
    });
  });
});
