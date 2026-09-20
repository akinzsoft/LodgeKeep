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

    /**
     * Gap closure (user-reported): "all houseppers shld show ... i dont
     * need to type anytin" — a real, pickable list of housekeeping-role
     * users, not a raw id typed by hand.
     */
    it('lists every user holding the housekeeping role at this property, and no one else', async () => {
      const res = await t.request.get('/api/v1/housekeeping/attendants').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({ id: String(ctx.a.users[1].id), email: 'ada@example.com', first_name: 'Ada', last_name: 'Bello' }),
      ]);
      // users[0] (Sam Okoro) holds `manager`, not `housekeeping` — excluded.
      expect(res.body.data.some((row) => String(row.id) === String(ctx.a.users[0].id))).toBe(false);
    });

    it('is gated on housekeeping.view — a role without it is refused', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 1, role: 'cashier' });
      const token = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[1].id),
      });
      const res = await t.request.get('/api/v1/housekeeping/attendants').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    /**
     * Bug fix (user-reported): "wen house keeper login the room number to
     * select is emfpty" — `BoardTab.jsx`'s room picker used to call
     * `GET /rooms` (`setup.view`-gated), which the `housekeeping` role does
     * not hold, so it 403'd for a real housekeeper and the picker rendered
     * empty. `GET /housekeeping/rooms` is the fix — same room data,
     * `housekeeping.view`-gated instead, reachable by the housekeeping role
     * that actually uses this screen.
     */
    it('lists active rooms via a housekeeping.view-gated read, reachable by the housekeeping role', async () => {
      await t.trx('rooms').where({ id: roomId }).update({ housekeeping_reported_status: 'dirty' });

      const housekeeperToken = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
      const res = await t.request.get('/api/v1/housekeeping/rooms').set('Authorization', `Bearer ${housekeeperToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((row) => String(row.id) === String(roomId) && row.housekeeping_reported_status === 'dirty')).toBe(
        true
      );
    });

    it('GET /housekeeping/rooms is gated on housekeeping.view — a role without it is refused', async () => {
      const token = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[1].id),
      });
      const res = await t.request.get('/api/v1/housekeeping/rooms').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
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
  // Gap closure (user-reported): a housekeeping-role account could assign
  // rooms to OTHER attendants, resolve discrepancies, and manage
  // out-of-order periods — all supervisor decisions. `housekeeping.operate`
  // (report a room's status; progress the status of THEIR OWN assignment)
  // vs `housekeeping.manage` (create/reassign an assignment, resolve a
  // discrepancy, out-of-order create/close) — manager holds both.
  // ====================================================================
  describe('the housekeeping role is scoped to its own job, not a supervisor\'s', () => {
    let roomTypeId;
    let myRoomId;
    let othersRoomId;
    let unassignedRoomId;
    let myAssignmentId;
    let othersAssignmentId;
    let secondHousekeeperId;

    beforeAll(async () => {
      roomTypeId = await createRoomType(ctx.a, 'HKSPLITTYPE');
      myRoomId = await createRoom(ctx.a, { roomTypeId, roomNumber: 'SPLIT-MINE' });
      othersRoomId = await createRoom(ctx.a, { roomTypeId, roomNumber: 'SPLIT-OTHER' });
      unassignedRoomId = await createRoom(ctx.a, { roomTypeId, roomNumber: 'SPLIT-NONE' });

      [secondHousekeeperId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email: 'second-housekeeper@example.com',
        first_name: 'Second',
        last_name: 'Housekeeper',
        password_hash: 'x',
        status: 'active',
      });
      await t.trx('user_property_access').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        user_id: secondHousekeeperId,
        role: 'housekeeping',
      });

      const mine = await t.request
        .post('/api/v1/housekeeping/assignments')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ room_id: String(myRoomId), attendant_user_id: String(ctx.a.users[1].id), business_date: '2027-01-10' });
      myAssignmentId = mine.body.data.id;

      const others = await t.request
        .post('/api/v1/housekeeping/assignments')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ room_id: String(othersRoomId), attendant_user_id: String(secondHousekeeperId), business_date: '2027-01-10' });
      othersAssignmentId = others.body.data.id;
    });

    function housekeeperToken() {
      return signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[1].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
    }

    it('a housekeeper cannot create a new assignment — housekeeping.manage required', async () => {
      const res = await t.request
        .post('/api/v1/housekeeping/assignments')
        .set('Authorization', `Bearer ${housekeeperToken()}`)
        .send({ room_id: String(unassignedRoomId), attendant_user_id: String(ctx.a.users[1].id), business_date: '2027-01-10' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
      expect(res.body.error.details.permission).toBe('housekeeping.manage');
    });

    it('a housekeeper CAN progress the status of their OWN assignment', async () => {
      const res = await t.request
        .patch(`/api/v1/housekeeping/assignments/${myAssignmentId}`)
        .set('Authorization', `Bearer ${housekeeperToken()}`)
        .send({ status: 'in_progress' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('in_progress');
    });

    it('a housekeeper CANNOT progress the status of someone ELSE\'S assignment', async () => {
      const res = await t.request
        .patch(`/api/v1/housekeeping/assignments/${othersAssignmentId}`)
        .set('Authorization', `Bearer ${housekeeperToken()}`)
        .send({ status: 'in_progress' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_NOT_YOUR_ASSIGNMENT');
    });

    it('a housekeeper cannot reassign their OWN assignment to a different attendant', async () => {
      const res = await t.request
        .patch(`/api/v1/housekeeping/assignments/${myAssignmentId}`)
        .set('Authorization', `Bearer ${housekeeperToken()}`)
        .send({ attendant_user_id: String(secondHousekeeperId) });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
      expect(res.body.error.details.permission).toBe('housekeeping.manage');

      const stillMine = await t.trx('housekeeping_assignments').where({ id: myAssignmentId }).first();
      expect(String(stillMine.attendant_user_id)).toBe(String(ctx.a.users[1].id));
    });

    it('a housekeeper CAN report status for a room assigned to them today', async () => {
      const res = await t.request
        .post(`/api/v1/housekeeping/rooms/${myRoomId}/status`)
        .set('Authorization', `Bearer ${housekeeperToken()}`)
        .send({ cleanliness: 'clean', occupancy_observed: 'vacant' });
      expect(res.status).toBe(200);
    });

    it('a housekeeper CANNOT report status for a room not assigned to them today', async () => {
      const res = await t.request
        .post(`/api/v1/housekeeping/rooms/${unassignedRoomId}/status`)
        .set('Authorization', `Bearer ${housekeeperToken()}`)
        .send({ cleanliness: 'clean', occupancy_observed: 'vacant' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROOM_NOT_ASSIGNED_TO_YOU');
    });

    it('a housekeeper cannot resolve a discrepancy', async () => {
      const [discrepancyId] = await t.trx('housekeeping_discrepancies').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_id: unassignedRoomId,
        business_date: '2027-01-10',
        front_desk_status: 'vacant',
        housekeeping_status: 'occupied',
      });
      const res = await t.request
        .post(`/api/v1/housekeeping/discrepancies/${discrepancyId}/resolve`)
        .set('Authorization', `Bearer ${housekeeperToken()}`)
        .send({ resolution_note: 'attempted by a housekeeper' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('a housekeeper cannot create an out-of-order period', async () => {
      const res = await t.request
        .post('/api/v1/housekeeping/out-of-order')
        .set('Authorization', `Bearer ${housekeeperToken()}`)
        .send({ room_id: String(unassignedRoomId), type: 'ooo', reason: 'Attempted by a housekeeper', start_date: '2027-06-01', end_date: '2027-06-02' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('a manager (housekeeping.manage) CAN reassign an existing assignment to a different attendant', async () => {
      const res = await t.request
        .patch(`/api/v1/housekeeping/assignments/${othersAssignmentId}`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ attendant_user_id: String(ctx.a.users[1].id) });
      expect(res.status).toBe(200);
      expect(String(res.body.data.attendant_user_id)).toBe(String(ctx.a.users[1].id));
    });

    it('a manager (housekeeping.manage) CAN report status for a room with no assignment to them at all', async () => {
      const res = await t.request
        .post(`/api/v1/housekeeping/rooms/${unassignedRoomId}/status`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ cleanliness: 'clean', occupancy_observed: 'vacant' });
      expect(res.status).toBe(200);
    });
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
