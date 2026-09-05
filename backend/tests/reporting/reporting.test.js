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
const { seedTwoTenants } = require('../helpers/fixtures');
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
});
