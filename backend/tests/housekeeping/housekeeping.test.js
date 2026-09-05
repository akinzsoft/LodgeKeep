'use strict';

/**
 * HTTP-level tests for the housekeeping module — PLAN.md Phase 3's "Tests
 * required to close": "Housekeeping discrepancy raised when front-desk and
 * reported status diverge; not silently overwritten either way" and
 * "Out-of-order room is excluded from sellable inventory" (the latter
 * verified through the reservations module's own `/availability` endpoint —
 * a real cross-module integration check, not a unit test standing in for
 * one). Also covers attendant assignments, the status board, and RBAC
 * gating across the two new permission keys.
 *
 * Cross-tenant isolation for every table here already comes free from
 * tests/isolation's ISO-* suite via tests/helpers/entities.js.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Housekeeping (PLAN.md Phase 3)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    // Housekeeping's discrepancy/business-date logic needs an opened
    // property (business_date is NOT NULL on housekeeping_discrepancies) —
    // fixtures.js leaves properties unopened (current_business_date null)
    // by design (Phase 1's own reasoning: not every fixture needs one).
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-01-10' });
  });

  /** users[0] holds `manager` at properties[0] (fixtures.js's own grant plan) — full housekeeping access per this pass's grant. */
  function tokenFor({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

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

  async function createRoomType(tenant, code) {
    const [id] = await t.trx('room_types').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      code,
      name: code,
      default_occupancy: 2,
      base_rate: '100.00',
    });
    return id;
  }

  async function createRoom(tenant, { roomTypeId, roomNumber, status = 'active' }) {
    const [id] = await t.trx('rooms').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      room_type_id: roomTypeId,
      room_number: roomNumber,
      status,
    });
    return id;
  }

  // ====================================================================
  // Attendant assignments & the status board
  // ====================================================================
  describe('attendant assignments & the status board', () => {
    let roomTypeId;
    let roomId;

    beforeAll(async () => {
      roomTypeId = await createRoomType(ctx.a, 'HKROOMTYPE');
      roomId = await createRoom(ctx.a, { roomTypeId, roomNumber: 'HK1' });
    });

    it('creates an assignment and it appears on the board', async () => {
      const res = await t.request
        .post('/api/v1/housekeeping/assignments')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ room_id: String(roomId), attendant_user_id: String(ctx.a.users[1].id), business_date: '2027-01-10' });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('assigned');

      const board = await t.request
        .get('/api/v1/housekeeping/board')
        .query({ business_date: '2027-01-10' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(board.status).toBe(200);
      expect(board.body.data.some((row) => String(row.room_id) === String(roomId))).toBe(true);
    });

    it('rejects a second assignment for the same room and date', async () => {
      const res = await t.request
        .post('/api/v1/housekeeping/assignments')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ room_id: String(roomId), attendant_user_id: String(ctx.a.users[1].id), business_date: '2027-01-10' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_ASSIGNMENT_ALREADY_EXISTS');
    });

    it('moves an assignment through in_progress to completed, and rejects an invalid transition', async () => {
      const created = await t.trx('housekeeping_assignments').where({ room_id: roomId, business_date: '2027-01-10' }).first();

      const started = await t.request
        .patch(`/api/v1/housekeeping/assignments/${created.id}`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ status: 'in_progress' });
      expect(started.status).toBe(200);
      expect(started.body.data.started_at).not.toBeNull();

      const backwards = await t.request
        .patch(`/api/v1/housekeeping/assignments/${created.id}`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ status: 'assigned' });
      expect(backwards.status).toBe(422);
      expect(backwards.body.error.code).toBe('BUSINESS_RULE_INVALID_ASSIGNMENT_TRANSITION');

      const completed = await t.request
        .patch(`/api/v1/housekeeping/assignments/${created.id}`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ status: 'completed' });
      expect(completed.status).toBe(200);
      expect(completed.body.data.completed_at).not.toBeNull();
    });
  });

  // ====================================================================
  // Discrepancy detection & the resolve flow
  // ====================================================================
  describe('discrepancy detection', () => {
    let roomTypeId;
    let roomId;

    beforeAll(async () => {
      roomTypeId = await createRoomType(ctx.a, 'HKDISCTYPE');
      roomId = await createRoom(ctx.a, { roomTypeId, roomNumber: 'DISC1' });
      // front_desk_status defaults to 'vacant' on a freshly created room.
    });

    it('raises a discrepancy when the housekeeper observes occupied but front desk expects vacant', async () => {
      const res = await t.request
        .post(`/api/v1/housekeeping/rooms/${roomId}/status`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ cleanliness: 'dirty', occupancy_observed: 'occupied' });
      expect(res.status).toBe(200);
      expect(res.body.data.discrepancyRaised).toBe(true);
      expect(Boolean(res.body.data.room.has_discrepancy)).toBe(true);

      const list = await t.request
        .get('/api/v1/housekeeping/discrepancies')
        .query({ resolved: 'false' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(list.status).toBe(200);
      const row = list.body.data.find((d) => String(d.room_id) === String(roomId));
      expect(row).toMatchObject({ front_desk_status: 'vacant', housekeeping_status: 'occupied' });
      expect(row.resolved_at).toBeNull();
    });

    it('does not raise a second discrepancy while one is already open — not silently overwritten', async () => {
      const before = await t.trx('housekeeping_discrepancies').where({ room_id: roomId }).count({ n: '*' });

      const res = await t.request
        .post(`/api/v1/housekeeping/rooms/${roomId}/status`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ cleanliness: 'dirty', occupancy_observed: 'occupied' });
      expect(res.status).toBe(200);
      expect(res.body.data.discrepancyRaised).toBe(false);

      const after = await t.trx('housekeeping_discrepancies').where({ room_id: roomId }).count({ n: '*' });
      expect(after[0].n).toBe(before[0].n);
    });

    it('a matching report does not silently auto-resolve the open discrepancy', async () => {
      const res = await t.request
        .post(`/api/v1/housekeeping/rooms/${roomId}/status`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ cleanliness: 'clean', occupancy_observed: 'vacant' });
      expect(res.status).toBe(200);

      const room = await t.trx('rooms').where({ id: roomId }).first();
      expect(Boolean(room.has_discrepancy)).toBe(true);
    });

    it('resolves the discrepancy explicitly and clears rooms.has_discrepancy', async () => {
      const open = await t.trx('housekeeping_discrepancies').where({ room_id: roomId, resolved_at: null }).first();

      const res = await t.request
        .post(`/api/v1/housekeeping/discrepancies/${open.id}/resolve`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ resolution_note: 'Confirmed guest had already left; front desk record corrected.' });
      expect(res.status).toBe(200);
      expect(res.body.data.resolved_at).not.toBeNull();

      const room = await t.trx('rooms').where({ id: roomId }).first();
      expect(Boolean(room.has_discrepancy)).toBe(false);

      const again = await t.request
        .post(`/api/v1/housekeeping/discrepancies/${open.id}/resolve`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ resolution_note: 'again' });
      expect(again.status).toBe(422);
      expect(again.body.error.code).toBe('BUSINESS_RULE_DISCREPANCY_ALREADY_RESOLVED');
    });

    it('notifies every staff member at the property via the in-app bell', async () => {
      const notifications = await t.trx('in_app_notifications').where({ type: 'housekeeping.discrepancy_raised' });
      expect(notifications.length).toBeGreaterThan(0);
    });
  });

  // ====================================================================
  // Out-of-order periods — PLAN.md Phase 3's own test gate
  // ====================================================================
  describe('out-of-order periods exclude a room from sellable inventory', () => {
    let roomTypeId;

    beforeAll(async () => {
      roomTypeId = await createRoomType(ctx.a, 'OOOROOMTYPE');
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'OOO-A' });
      await createRoom(ctx.a, { roomTypeId, roomNumber: 'OOO-B' });
    });

    it('excludes the room only on dates inside the scheduled window', async () => {
      const roomId = (await t.trx('rooms').where({ room_type_id: roomTypeId, room_number: 'OOO-A' }).first()).id;

      const create = await t.request
        .post('/api/v1/housekeeping/out-of-order')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ room_id: String(roomId), type: 'ooo', reason: 'Plumbing repair', start_date: '2027-03-10', end_date: '2027-03-12' });
      expect(create.status).toBe(201);

      const inside = await t.request
        .get('/api/v1/availability')
        .query({ room_type_id: String(roomTypeId), arrival_date: '2027-03-10', departure_date: '2027-03-11' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(inside.body.data.nights[0].physicalCount).toBe(1);

      const outside = await t.request
        .get('/api/v1/availability')
        .query({ room_type_id: String(roomTypeId), arrival_date: '2027-03-20', departure_date: '2027-03-21' })
        .set('Authorization', `Bearer ${tokenFor()}`);
      expect(outside.body.data.nights[0].physicalCount).toBe(2);
    });

    it('rejects an end date before the start date', async () => {
      const roomId = (await t.trx('rooms').where({ room_type_id: roomTypeId, room_number: 'OOO-B' }).first()).id;
      const res = await t.request
        .post('/api/v1/housekeeping/out-of-order')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ room_id: String(roomId), type: 'oos', reason: 'Test', start_date: '2027-04-05', end_date: '2027-04-01' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_OOO_END_BEFORE_START');
    });
  });

  // ====================================================================
  // A discrepant room cannot be checked into
  // ====================================================================
  it('refuses check-in to a room with an unresolved discrepancy', async () => {
    const roomTypeId = await createRoomType(ctx.a, 'HKCHECKINTYPE');
    const roomId = await createRoom(ctx.a, { roomTypeId, roomNumber: 'DISCCHK1' });
    await t.trx('rooms').where({ id: roomId }).update({ has_discrepancy: true });

    const [guestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Test', last_name: 'Guest' });
    const [rateCodeId] = await t.trx('rate_codes').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code: 'HKCHECKINRATE',
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    const [reservationId] = await t.trx('reservations').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      guest_id: guestId,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: '2027-01-10',
      departure_date: '2027-01-11',
      status: 'confirmed',
      confirmation_number: 'HKCHECKINCONF',
    });

    const res = await t.request
      .post(`/api/v1/reservations/${reservationId}/check-in`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .set('Idempotency-Key', 'hk-checkin-discrepancy-test')
      .send({ room_id: String(roomId) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_ROOM_OUT_OF_ORDER');
  });

  // ====================================================================
  // RBAC gating — SECURITY.md §5's Housekeeping row
  // ====================================================================
  describe('RBAC gating', () => {
    it('front_desk gets Read on housekeeping but nothing on manage actions', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'front_desk' });
      const token = tokenFor({ userId: ctx.a.users[1].id });

      const board = await t.request.get('/api/v1/housekeeping/board').set('Authorization', `Bearer ${token}`);
      expect(board.status).toBe(200);

      const assign = await t.request
        .post('/api/v1/housekeeping/assignments')
        .set('Authorization', `Bearer ${token}`)
        .send({ room_id: '1', attendant_user_id: String(ctx.a.users[1].id), business_date: '2027-01-10' });
      expect(assign.status).toBe(403);
      expect(assign.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('cashier gets neither view nor manage on housekeeping', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'cashier' });
      const token = tokenFor({ userId: ctx.a.users[1].id });

      const board = await t.request.get('/api/v1/housekeeping/board').set('Authorization', `Bearer ${token}`);
      expect(board.status).toBe(403);
      expect(board.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });
  });
});
