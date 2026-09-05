'use strict';

/**
 * HTTP-level tests for the reservations + front desk module — PLAN.md
 * Phase 2's "Tests required to close": TESTING.md RES-1 through RES-10,
 * FD-1 through FD-7, a representative slice of the idempotency
 * requirements (ARCHITECTURE.md §7/§11), RBAC gating across the four new
 * permission keys, and a representative cross-tenant isolation check
 * (DB-level coverage for every table here already comes free from
 * tests/isolation's ISO-* suite via tests/helpers/entities.js).
 *
 * Tokens are minted directly (`signAccessToken`), the same pattern
 * `tests/setup/setup.test.js` already uses.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Reservations + Front Desk (PLAN.md Phase 2)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  /** users[0] holds `manager` at properties[0] (fixtures.js's own grant plan) — full reservations + front_desk access per this pass's grant. */
  function tokenFor({ tenant = ctx.a, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function createRoomType(tenant, { code, defaultOccupancy = 2, baseRate = '100.00' }) {
    const [id] = await t.trx('room_types').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      code,
      name: code,
      default_occupancy: defaultOccupancy,
      base_rate: baseRate,
    });
    return id;
  }

  async function createRoom(tenant, { roomTypeId, roomNumber, status = 'active', housekeeping = 'clean' }) {
    const [id] = await t.trx('rooms').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      room_type_id: roomTypeId,
      room_number: roomNumber,
      status,
      housekeeping_reported_status: housekeeping,
    });
    return id;
  }

  async function createRateCode(tenant, { code, baseRate = '100.00' }) {
    const [id] = await t.trx('rate_codes').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      code,
      base_rate: baseRate,
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    return id;
  }

  async function createMarketSegment(tenant, { code }) {
    const [id] = await t.trx('market_segments').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      code,
      name: code,
    });
    return id;
  }

  async function createBookingSource(tenant, { code }) {
    const [id] = await t.trx('booking_sources').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      code,
      name: code,
    });
    return id;
  }

  async function createCancellationPolicy(tenant, { code }) {
    const [id] = await t.trx('cancellation_policies').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      code,
      name: code,
      fee_type: 'none',
    });
    return id;
  }

  let idemCounter = 0;
  function idemKey() {
    idemCounter += 1;
    return `test-key-${idemCounter}-${Date.now()}`;
  }

  // ====================================================================
  // Availability & the last-room race — RES-1..RES-6
  // ====================================================================
  describe('availability & the last-room race', () => {
    let roomTypeId;
    let rateCodeId;

    beforeAll(async () => {
      roomTypeId = await createRoomType(ctx.a, { code: 'LASTROOM' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'LR1' });
      rateCodeId = await createRateCode(ctx.a, { code: 'LASTROOMRATE' });
    });

    it('RES-1: with the room free, availability returns the full sellable count', async () => {
      const res = await t.request
        .get('/api/v1/availability')
        .query({ room_type_id: String(roomTypeId), arrival_date: '2027-05-01', departure_date: '2027-05-02' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.minSellable).toBe(1);
      expect(res.body.data.nights[0]).toMatchObject({ physicalCount: 1, roomsSold: 0, sellable: 1 });
    });

    it('RES-3: booking the one room at the threshold succeeds', async () => {
      const res = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-05-01',
          departure_date: '2027-05-02',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('confirmed');
    });

    it('RES-2: availability now reflects the booked room — sellable reduced by 1', async () => {
      const res = await t.request
        .get('/api/v1/availability')
        .query({ room_type_id: String(roomTypeId), arrival_date: '2027-05-01', departure_date: '2027-05-02' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.body.data.nights[0]).toMatchObject({ roomsSold: 1, sellable: 0 });
    });

    it('RES-4: a second booking past the threshold is rejected with a clear reason', async () => {
      const res = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-05-01',
          departure_date: '2027-05-02',
        });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_OVERBOOKING_THRESHOLD_EXCEEDED');
    });

    it('RES-9: a departure date before the arrival date is rejected', async () => {
      const res = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-06-05',
          departure_date: '2027-06-01',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ARRIVAL_AFTER_DEPARTURE');
    });

    // RES-5 ("two concurrent requests for the last room") needs two
    // genuinely separate database connections to prove real lock
    // contention — this file's whole suite shares one transaction
    // (`useTestApp`), so two "concurrent" requests against it are really
    // two savepoints on the same session, which never blocks itself and
    // would pass vacuously. See `tests/reservations/concurrency.test.js`,
    // which binds the app to the real connection pool instead, for the
    // genuine version of this test.

    it('RES-6: a room taken out of service is excluded from sellable inventory', async () => {
      const oooRoomTypeId = await createRoomType(ctx.a, { code: 'OOOTYPE' });
      await createRoom(ctx.a, { roomTypeId: oooRoomTypeId, roomNumber: 'OOO1' });
      await createRoom(ctx.a, { roomTypeId: oooRoomTypeId, roomNumber: 'OOO2', status: 'out_of_service' });

      const res = await t.request
        .get('/api/v1/availability')
        .query({ room_type_id: String(oooRoomTypeId), arrival_date: '2027-08-01', departure_date: '2027-08-02' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      // Two physical rooms exist, but only one is `active` — sellable must
      // reflect the live count, not the raw row count. Physical count is now
      // per-night (PLAN.md Phase 3), not a single top-level field, since an
      // OOO window can cover only part of a requested range.
      expect(res.body.data.nights[0].physicalCount).toBe(1);
      expect(res.body.data.nights[0].sellable).toBe(1);
    });

    it('RES-10: cancellation changes status, releases inventory, and writes an audit row', async () => {
      const created = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-09-01',
          departure_date: '2027-09-03',
        });
      // roomTypeId (LASTROOM) is already fully sold for 2027-05-01, but this
      // is a different date range with its own inventory rows.
      expect(created.status).toBe(201);
      const id = created.body.data.id;

      const cancelRes = await t.request
        .post(`/api/v1/reservations/${id}/cancel`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Guest requested cancellation.' });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('cancelled');

      const inventoryRow = await t.trx('room_type_inventory')
        .where({ tenant_id: ctx.a.id, room_type_id: roomTypeId, stay_date: '2027-09-01' })
        .first();
      expect(inventoryRow.rooms_sold).toBe(0);

      const auditRow = await t.trx('audit_log')
        .where({ tenant_id: ctx.a.id, entity_type: 'reservations', entity_id: id, action: 'cancel' })
        .first();
      expect(auditRow).toBeDefined();
    });

    it('RES-7/RES-8: booking snapshots the rate per night, and a later rate-code change does not alter it', async () => {
      const snapshotRateCodeId = await createRateCode(ctx.a, { code: 'SNAPRATE', baseRate: '175.00' });
      const created = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(snapshotRateCodeId),
          arrival_date: '2027-10-01',
          departure_date: '2027-10-03',
        });
      expect(created.status).toBe(201);
      const id = created.body.data.id;

      const dailyRates = await t.trx('reservation_daily_rates').where({ reservation_id: id }).orderBy('stay_date');
      expect(dailyRates).toHaveLength(2);
      expect(dailyRates.map((r) => r.rate)).toEqual(['175.00', '175.00']);

      // RES-8: change the rate code's base rate directly — the already-booked reservation must be unaffected.
      await t.trx('rate_codes').where({ id: snapshotRateCodeId }).update({ base_rate: '999.00' });

      const unchangedRates = await t.trx('reservation_daily_rates').where({ reservation_id: id }).orderBy('stay_date');
      expect(unchangedRates.map((r) => r.rate)).toEqual(['175.00', '175.00']);
    });
  });

  // ====================================================================
  // Waitlist
  // ====================================================================
  describe('waitlist', () => {
    it('booking past the threshold with allow_waitlist creates a waitlisted reservation instead, holding no inventory', async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'WLTYPE' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'WL1' });
      const rateCodeId = await createRateCode(ctx.a, { code: 'WLRATE' });

      const first = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-11-01',
          departure_date: '2027-11-02',
        });
      expect(first.status).toBe(201);

      const waitlisted = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-11-01',
          departure_date: '2027-11-02',
          allow_waitlist: true,
        });
      expect(waitlisted.status).toBe(201);
      expect(waitlisted.body.data.status).toBe('waitlisted');

      const inventoryRow = await t.trx('room_type_inventory')
        .where({ tenant_id: ctx.a.id, room_type_id: roomTypeId, stay_date: '2027-11-01' })
        .first();
      expect(inventoryRow.rooms_sold).toBe(1); // still just the first booking

      // Cancel the first, freeing the room, then promote the waitlisted one.
      await t.request
        .post(`/api/v1/reservations/${first.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Making room for promotion test.' });

      const promoted = await t.request
        .post(`/api/v1/reservations/${waitlisted.body.data.id}/promote-waitlist`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(promoted.status).toBe(200);
      expect(promoted.body.data.status).toBe('confirmed');
    });
  });

  // ====================================================================
  // Market segment / booking source / cancellation policy on a reservation
  // — PLAN.md Phase 1 gap closure, PRODUCT_REQUIREMENTS.md §3.19 ("needed
  // for meaningful revenue reporting later ... referenced at reservation
  // time"). All three are optional.
  // ====================================================================
  describe('market segment / booking source / cancellation policy', () => {
    let roomTypeId;
    let rateCodeId;
    let marketSegmentId;
    let bookingSourceId;
    let cancellationPolicyId;

    beforeAll(async () => {
      roomTypeId = await createRoomType(ctx.a, { code: 'REFDATA' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'RD1' });
      rateCodeId = await createRateCode(ctx.a, { code: 'REFDATARATE' });
      marketSegmentId = await createMarketSegment(ctx.a, { code: 'REFCORP' });
      bookingSourceId = await createBookingSource(ctx.a, { code: 'REFDIRECT' });
      cancellationPolicyId = await createCancellationPolicy(ctx.a, { code: 'REFFLEX' });
    });

    it('books a reservation carrying all three reference-data ids', async () => {
      const res = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-06-01',
          departure_date: '2027-06-02',
          market_segment_id: String(marketSegmentId),
          booking_source_id: String(bookingSourceId),
          cancellation_policy_id: String(cancellationPolicyId),
        });
      expect(res.status).toBe(201);
      expect(res.body.data.market_segment_id).toBe(String(marketSegmentId));
      expect(res.body.data.booking_source_id).toBe(String(bookingSourceId));
      expect(res.body.data.cancellation_policy_id).toBe(String(cancellationPolicyId));
    });

    it('rejects a market_segment_id that does not exist at this property', async () => {
      const res = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-06-03',
          departure_date: '2027-06-04',
          market_segment_id: '999999999',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MARKET_SEGMENT_NOT_FOUND');
    });

    it("rejects another tenant's cancellation policy id — proves the composite FK is scoped, not just existence", async () => {
      const otherCancellationPolicyId = await createCancellationPolicy(ctx.b, { code: 'OTHERFLEX' });
      const res = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-06-05',
          departure_date: '2027-06-06',
          cancellation_policy_id: String(otherCancellationPolicyId),
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_CANCELLATION_POLICY_NOT_FOUND');
    });
  });

  // ====================================================================
  // Front desk — FD-1..FD-7
  // ====================================================================
  describe('front desk', () => {
    let reservationId;
    let roomId;

    beforeAll(async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'FDTYPE' });
      roomId = await createRoom(ctx.a, { roomTypeId, roomNumber: 'FD1' });
      const rateCodeId = await createRateCode(ctx.a, { code: 'FDRATE' });

      const created = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-12-01',
          departure_date: '2027-12-03',
        });
      reservationId = created.body.data.id;
    });

    it('FD-2: check-in to a dirty room is blocked', async () => {
      await t.trx('rooms').where({ id: roomId }).update({ housekeeping_reported_status: 'dirty' });
      const res = await t.request
        .post(`/api/v1/reservations/${reservationId}/check-in`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ room_id: String(roomId) });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_ROOM_NOT_CLEAN');
      await t.trx('rooms').where({ id: roomId }).update({ housekeeping_reported_status: 'clean' });
    });

    it('FD-1: check-in sets status checked_in, occupies the room, and opens a folio', async () => {
      const res = await t.request
        .post(`/api/v1/reservations/${reservationId}/check-in`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ room_id: String(roomId) });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('checked_in');

      const assignment = await t.trx('reservation_rooms').where({ reservation_id: reservationId, effective_to: null }).first();
      expect(assignment).toBeDefined();
      expect(String(assignment.room_id)).toBe(String(roomId));

      const folio = await t.trx('folios').where({ reservation_id: reservationId, status: 'open' }).first();
      expect(folio).toBeDefined();
      expect(folio.balance).toBe('0.00');
    });

    it('FD-3: a room move closes the old assignment and opens a new one, preserving history', async () => {
      const roomTypeId = (await t.trx('rooms').where({ id: roomId }).first()).room_type_id;
      const newRoomId = await createRoom(ctx.a, { roomTypeId, roomNumber: 'FD2' });

      const res = await t.request
        .post(`/api/v1/reservations/${reservationId}/room-move`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ new_room_id: String(newRoomId), reason: 'Guest requested a quieter room.' });
      expect(res.status).toBe(200);

      const oldAssignment = await t.trx('reservation_rooms').where({ reservation_id: reservationId, room_id: roomId }).first();
      expect(oldAssignment.effective_to).not.toBeNull();

      const newAssignment = await t.trx('reservation_rooms').where({ reservation_id: reservationId, room_id: newRoomId }).first();
      expect(newAssignment.effective_to).toBeNull();
      expect(newAssignment.reason).toBe('Guest requested a quieter room.');
    });

    it('FD-4: check-out with an outstanding folio balance is blocked', async () => {
      const folio = await t.trx('folios').where({ reservation_id: reservationId, status: 'open' }).first();
      await t.trx('folios').where({ id: folio.id }).update({ balance: '50.00' });

      const res = await t.request
        .post(`/api/v1/reservations/${reservationId}/check-out`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_FOLIO_BALANCE_OWING');

      await t.trx('folios').where({ id: folio.id }).update({ balance: '0.00' });
    });

    it('FD-6/FD-5: an early or late checkout time posts the configured fee, and check-out completes', async () => {
      const res = await t.request
        .post(`/api/v1/reservations/${reservationId}/check-out`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          scheduled_checkout_time: '11:00',
          actual_checkout_time: '14:00',
          late_checkout_fee: '25.00',
        });
      expect(res.status).toBe(200);
      expect(res.body.meta.fee).toEqual({ type: 'late_checkout', amount: '25.00' });
      expect(res.body.data.status).toBe('checked_out');

      const folio = await t.trx('folios').where({ reservation_id: reservationId }).orderBy('id', 'desc').first();
      expect(folio.status).toBe('closed');
      expect(folio.balance).toBe('25.00');

      const assignment = await t.trx('reservation_rooms').where({ reservation_id: reservationId, effective_to: null }).first();
      expect(assignment).toBeUndefined();
    });

    it('FD-7: availability surfaces an oversold room type before a walk-in sale is allowed', async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'WALKINTYPE' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'WALKIN1' });
      const rateCodeId = await createRateCode(ctx.a, { code: 'WALKINRATE' });

      await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-12-20',
          departure_date: '2027-12-21',
        });

      const availability = await t.request
        .get('/api/v1/availability')
        .query({ room_type_id: String(roomTypeId), arrival_date: '2027-12-20', departure_date: '2027-12-21' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(availability.body.data.minSellable).toBe(0);
    });
  });

  // ====================================================================
  // Idempotency — ARCHITECTURE.md §7/§11
  // ====================================================================
  describe('idempotency', () => {
    it('rejects a mutation with no Idempotency-Key header, even with an otherwise-complete payload', async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'NOKEYTYPE' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'NOKEY1' });
      const rateCodeId = await createRateCode(ctx.a, { code: 'NOKEYRATE' });

      const res = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2028-07-01',
          departure_date: '2028-07-02',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_IDEMPOTENCY_KEY');
    });

    it('a retried request with the same key and same payload replays the first response, without creating a second reservation', async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'IDEMTYPE' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'IDEM1' });
      const rateCodeId = await createRateCode(ctx.a, { code: 'IDEMRATE' });
      const key = idemKey();
      const payload = {
        guest_id: String(ctx.a.guests[0].id),
        room_type_id: String(roomTypeId),
        rate_code_id: String(rateCodeId),
        arrival_date: '2028-01-01',
        departure_date: '2028-01-02',
      };

      const first = await t.request.post('/api/v1/reservations').set('Authorization', `Bearer ${tokenFor()}`).set('Idempotency-Key', key).send(payload);
      const second = await t.request.post('/api/v1/reservations').set('Authorization', `Bearer ${tokenFor()}`).set('Idempotency-Key', key).send(payload);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);

      const count = await t.trx('reservations')
        .where({ tenant_id: ctx.a.id, room_type_id: roomTypeId, status: 'confirmed' })
        .count({ n: '*' })
        .first();
      expect(Number(count.n)).toBe(1);
    });

    it('the same key reused with a different payload is a conflict, not a silent re-process or replay', async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'IDEMTYPE2' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'IDEM2' });
      const rateCodeId = await createRateCode(ctx.a, { code: 'IDEMRATE2' });
      const key = idemKey();

      const first = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', key)
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2028-02-01',
          departure_date: '2028-02-02',
        });
      expect(first.status).toBe(201);

      const second = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', key)
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2028-03-01', // different dates — a genuinely different request
          departure_date: '2028-03-02',
        });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('CONFLICT_IDEMPOTENCY_KEY_REUSE');
    });

    it('a key reused after its retention window has expired is treated as a brand-new operation', async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'IDEMTYPE3' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'IDEM3' });
      const rateCodeId = await createRateCode(ctx.a, { code: 'IDEMRATE3' });
      const key = idemKey();

      const first = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', key)
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2028-04-01',
          departure_date: '2028-04-02',
        });
      expect(first.status).toBe(201);

      // Force the stored key past its retention window.
      await t.trx('idempotency_keys')
        .where({ tenant_id: ctx.a.id, operation_type: 'reservations.create', key_value: key })
        .update({ expires_at: new Date(Date.now() - 1000) });

      const second = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', key)
        .send({
          guest_id: String(ctx.a.guests[0].id),
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2028-05-01', // different payload — must NOT conflict, since the key expired
          departure_date: '2028-05-02',
        });
      expect(second.status).toBe(201);
      expect(second.body.data.id).not.toBe(first.body.data.id);
    });
  });

  // ====================================================================
  // PLAN.md Phase 3: the missing overbooking-threshold config endpoint
  // ====================================================================
  describe('overbooking threshold configuration', () => {
    it('configures a higher threshold for a specific date, which raises what the last-room race allows', async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'OVERCONFIGTYPE' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'OC1' });

      const configured = await t.request
        .put(`/api/v1/room-types/${roomTypeId}/inventory/2027-09-10`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ overbooking_threshold_pct: 200 });
      expect(configured.status).toBe(200);
      expect(configured.body.data.overbooking_threshold_pct).toBe('200.00');

      const availability = await t.request
        .get('/api/v1/availability')
        .query({ room_type_id: String(roomTypeId), arrival_date: '2027-09-10', departure_date: '2027-09-11' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      // One physical room at 200% threshold sells 2, not 1.
      expect(availability.body.data.nights[0].threshold).toBe(2);
    });

    it('is idempotent-by-value: reconfiguring the same date updates rather than duplicating the row', async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'OVERCONFIGTYPE2' });
      await t.request
        .put(`/api/v1/room-types/${roomTypeId}/inventory/2027-09-15`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ overbooking_threshold_pct: 110 });
      const second = await t.request
        .put(`/api/v1/room-types/${roomTypeId}/inventory/2027-09-15`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ overbooking_threshold_pct: 120 });
      expect(second.status).toBe(200);
      expect(second.body.data.overbooking_threshold_pct).toBe('120.00');

      const rows = await t.trx('room_type_inventory').where({ room_type_id: roomTypeId, stay_date: '2027-09-15' });
      expect(rows.length).toBe(1);
    });

    it('requires reservations.manage, not just reservations.view', async () => {
      const roomTypeId = await createRoomType(ctx.a, { code: 'OVERCONFIGTYPE3' });
      // users[1] at properties[0] already holds `housekeeping` per fixtures.js's
      // own grant plan — reassigned to `cashier` here (view-only on
      // reservations, per SECURITY.md §5) rather than inserted fresh, since a
      // second row for the same (user, property) would collide on that
      // table's own UNIQUE constraint.
      const existingAccess = await t.trx('user_property_access').where({ user_id: ctx.a.users[1].id, property_id: ctx.a.properties[0].id }).first('id');
      await t.trx('user_property_access').where({ id: existingAccess.id }).update({ role: 'cashier' });
      const cashierToken = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
      const res = await t.request
        .put(`/api/v1/room-types/${roomTypeId}/inventory/2027-09-20`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ overbooking_threshold_pct: 150 });
      expect(res.status).toBe(403);
    });
  });

  // ====================================================================
  // RBAC gating — SECURITY.md §5's Reservations vs Front Desk split
  // ====================================================================
  describe('RBAC gating', () => {
    async function grantRoleToUser({ tenant, userIndex, propertyIndex, role }) {
      const propertyId = tenant.properties[propertyIndex].id;
      const userId = tenant.users[userIndex].id;
      const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
      if (existing) {
        await t.trx('user_property_access').where({ id: existing.id }).update({ role });
        return;
      }
      await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
    }

    it('cashier gets Read on reservations but nothing on front desk', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'cashier' });
      const token = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });

      const list = await t.request.get('/api/v1/reservations').set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(200);

      const arrivals = await t.request.get('/api/v1/front-desk/arrivals').set('Authorization', `Bearer ${token}`);
      expect(arrivals.status).toBe(403);
      expect(arrivals.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('front_desk role (ctx.a.users[0] at properties[1]) can check in a reservation there', async () => {
      const roomTypeId = await t.trx('room_types').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        code: 'P2TYPE',
        name: 'P2 type',
        default_occupancy: 2,
        base_rate: '100.00',
      });
      const [roomId] = await t.trx('rooms').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        room_type_id: roomTypeId[0],
        room_number: 'P2-1',
      });
      const [rateCodeId] = await t.trx('rate_codes').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[1].id,
        code: 'P2RATE',
        base_rate: '100.00',
        currency: 'GBP',
        valid_from: '2026-01-01',
      });
      const [guestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'P2', last_name: 'Guest' });

      const token = tokenFor({ propertyId: ctx.a.properties[1].id });
      const created = await t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(guestId),
          room_type_id: String(roomTypeId[0]),
          rate_code_id: String(rateCodeId),
          arrival_date: '2028-06-01',
          departure_date: '2028-06-02',
        });
      expect(created.status).toBe(201);

      const checkIn = await t.request
        .post(`/api/v1/reservations/${created.body.data.id}/check-in`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ room_id: String(roomId) });
      expect(checkIn.status).toBe(200);
    });
  });

  // ====================================================================
  // Cross-tenant isolation — representative HTTP-level check
  // ====================================================================
  describe('cross-tenant isolation at the route level', () => {
    it("tenant A cannot read tenant B's reservation by id — 404, never 403", async () => {
      const res = await t.request
        .get(`/api/v1/reservations/${ctx.b.reservations[0].id}`)
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(404);
    });

    it("tenant A cannot check in tenant B's reservation — 404, and tenant B's row is untouched", async () => {
      const res = await t.request
        .post(`/api/v1/reservations/${ctx.b.reservations[0].id}/check-in`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ room_id: String(ctx.b.rooms[0].id) });
      expect(res.status).toBe(404);

      const stillIntact = await t.trx('reservations').where({ id: ctx.b.reservations[0].id }).first();
      expect(stillIntact.status).toBe('confirmed');
    });
  });
});
