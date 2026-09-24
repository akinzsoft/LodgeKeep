'use strict';

/**
 * Room management under REAL concurrent connections — the races that
 * `room-management.test.js` (one shared, rolled-back transaction, so its
 * "concurrent" requests are savepoints on one session) cannot prove.
 * Same harness as `tests/reservations/concurrency.test.js`: the app is bound
 * to the real pooled test connection and this file seeds and cleans up real
 * COMMITTED rows. See that file's header for why a shared-transaction harness
 * cannot show lock contention.
 *
 * What each race protects (see `setup/room-management.js`'s lock-order note):
 *   A. check-in vs archive of the same clean room — a guest must never end up
 *      in an archived room, and an archived room must never be left occupied.
 *   B. a booking vs moving a room out of the same type — an accepted booking
 *      must never end up with no room to fit in.
 *   C. cancelling a reservation vs a room move that clears its preferred room
 *      — the two lock the same reservation and inventory rows in opposite
 *      natural orders; the shared lock order must keep them deadlock-free.
 *   D. two identical change-type requests — one changes it, the other sees
 *      it already changed.
 *
 * Verified by mutation (recorded in CLAUDE.md): replacing `lockRooms` in
 * room-management with a plain read fails race A; dropping the `status`
 * guard from `checkIn` fails race A; making the inventory lock a plain read
 * fails race B; removing the reservation pre-lock fails race C.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

describe('room management — races under real concurrent connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let guestId;
  let rateCodeId;
  let userId;
  let token;
  let seq = 0;

  const post = (path, body = {}) =>
    req.post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', `rmc-${(seq += 1)}-${Date.now()}`).send(body);

  async function createType(code) {
    const [id] = await db()('room_types').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: `${code}-${(seq += 1)}`,
      name: code,
      default_occupancy: 2,
      base_rate: '100.00',
    });
    return id;
  }

  async function createRoom(typeId, number) {
    const [id] = await db()('rooms').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      room_type_id: typeId,
      room_number: `${number}-${(seq += 1)}`,
      housekeeping_reported_status: 'clean',
    });
    return id;
  }

  async function book(typeId, date, { preferredRoomId } = {}) {
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const res = await post('/reservations', {
      guest_id: String(guestId),
      room_type_id: String(typeId),
      rate_code_id: String(rateCodeId),
      arrival_date: date,
      departure_date: next.toISOString().slice(0, 10),
      ...(preferredRoomId ? { preferred_room_id: String(preferredRoomId) } : {}),
    });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  const roomRow = (id) => db()('rooms').where({ id }).first();

  /**
   * Starts two requests with a small stagger between them — `offsetMs` > 0
   * delays the SECOND, < 0 delays the FIRST. Two requests fired in the same
   * tick almost always reach the database in the same order, so an unstaggered
   * race only ever exercises one interleaving; sweeping the offset in both
   * directions makes each side win the lock in some rounds.
   */
  const raceWithOffset = (first, second, offsetMs) =>
    Promise.all([
      new Promise((resolve) => setTimeout(resolve, Math.max(0, -offsetMs))).then(first),
      new Promise((resolve) => setTimeout(resolve, Math.max(0, offsetMs))).then(second),
    ]);
  const OFFSETS = [0, 4, -4, 10, -10, 18, -18, 30, -30, 45, -45, 2, -2, 8, -8, 14, -14, 22, -22, 6];

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Room Mgmt Race Tenant', slug: `rmrace-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `rmrace-property-${suffix}`,
      name: 'Room Mgmt Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'admin', name: 'admin', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `rmrace-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Race',
      last_name: 'Admin',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'admin' });
    const perms = await db()('permissions')
      .whereIn('permission_key', ['setup.view', 'setup.manage', 'reservations.view', 'reservations.manage', 'front_desk.view', 'front_desk.manage'])
      .select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [guestId] = await db()('guests').insert({ tenant_id: tenantId, first_name: 'Race', last_name: 'Guest' });
    [rateCodeId] = await db()('rate_codes').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: 'RMRACE',
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  });

  afterAll(async () => {
    const t = { tenant_id: tenantId };
    await db()('audit_log').where(t).delete();
    await db()('outbox_events').where(t).delete();
    await db()('idempotency_keys').where(t).delete();
    await db()('in_app_notifications').where(t).delete();
    await db()('reservation_rooms').where(t).delete();
    await db()('folio_line_items').where(t).delete();
    await db()('folios').where(t).delete();
    await db()('reservation_daily_rates').where(t).delete();
    await db()('room_type_inventory').where(t).delete();
    await db()('reservations').where(t).delete();
    await db()('rate_codes').where(t).delete();
    await db()('rooms').where(t).delete();
    await db()('room_types').where(t).delete();
    await db()('guests').where(t).delete();
    await db()('user_property_access').where(t).delete();
    await db()('role_permissions').where(t).delete();
    await db()('users').where(t).delete();
    await db()('roles').where(t).delete();
    await db()('properties').where(t).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  it('A: check-in vs archive of the same clean room — exactly one wins, and a guest never ends up in an archived room', async () => {
    const typeId = await createType('RACE-A');
    // Spare capacity, so the archive is never blocked by capacity — only by occupancy.
    for (let i = 0; i < 4; i += 1) await createRoom(typeId, 'SPARE');

    for (let round = 0; round < OFFSETS.length; round += 1) {
      const roomId = await createRoom(typeId, 'TARGET');
      const reservation = await book(typeId, `2031-${String((round % 12) + 1).padStart(2, '0')}-${String(10 + Math.floor(round / 12))}`);

      const [checkIn, archive] = await raceWithOffset(
        () => post(`/reservations/${reservation.id}/check-in`, { room_id: String(roomId) }),
        () => post(`/rooms/${roomId}/archive`, { reason: 'race' }),
        OFFSETS[round]
      );

      // Never a 500 (a deadlock or a swallowed lock error), and never both.
      expect([checkIn.status, archive.status].every((status) => status < 500)).toBe(true);
      const room = await roomRow(roomId);
      const openStay = await db()('reservation_rooms').where({ room_id: roomId, effective_to: null }).first();

      if (checkIn.status === 200) {
        expect(archive.status).toBe(409);
        expect(archive.body.error.code).toBe('CONFLICT_ROOM_CHANGE_BLOCKED');
        expect(room.status).toBe('active');
        expect(room.front_desk_status).toBe('occupied');
        expect(openStay).toBeDefined();
      } else {
        expect(archive.status).toBe(200);
        expect(checkIn.status).toBe(422);
        expect(checkIn.body.error.code).toBe('BUSINESS_RULE_ROOM_NOT_ACTIVE');
        expect(room.status).toBe('archived');
        expect(room.front_desk_status).toBe('vacant');
        expect(openStay).toBeUndefined();
      }
    }
  });

  it('B: a booking vs moving a room out of the same type — the accepted bookings always still fit', async () => {
    for (let round = 0; round < 6; round += 1) {
      const date = `2032-0${round + 1}-10`;
      const fromType = await createType('RACE-B');
      const toType = await createType('RACE-B-TO');
      const roomA = await createRoom(fromType, 'B1');
      await createRoom(fromType, 'B2');
      await book(fromType, date); // one of two rooms sold that night

      const [booking, change] = await Promise.all([
        post('/reservations', {
          guest_id: String(guestId),
          room_type_id: String(fromType),
          rate_code_id: String(rateCodeId),
          arrival_date: date,
          departure_date: `2032-0${round + 1}-11`,
        }),
        post(`/rooms/${roomA}/change-type`, { room_type_id: String(toType) }),
      ]);

      expect([booking.status, change.status].every((status) => status < 500)).toBe(true);
      // Exactly one of them lands: with two rooms, one already sold, either a
      // second booking fits or a room can leave — never both.
      expect([booking.status === 201, change.status === 200].filter(Boolean)).toHaveLength(1);
      if (booking.status === 201) {
        expect(change.status).toBe(409);
        expect(change.body.error.details.blocked[0].reasons.map((r) => r.code)).toContain('WOULD_OVERBOOK');
      } else {
        expect(booking.status).toBe(422);
        expect(booking.body.error.code).toBe('BUSINESS_RULE_OVERBOOKING_THRESHOLD_EXCEEDED');
      }

      // The invariant itself: nights sold never exceed the rooms left in the type.
      const inventory = await db()('room_type_inventory').where({ room_type_id: fromType, stay_date: date }).first();
      const roomsLeft = await db()('rooms').where({ room_type_id: fromType, status: 'active' }).count({ n: '*' }).first();
      expect(inventory.rooms_sold).toBeLessThanOrEqual(Number(roomsLeft.n));
    }
  });

  it('C: cancelling a reservation vs moving its preferred room — no deadlock, both complete', async () => {
    for (let round = 0; round < OFFSETS.length; round += 1) {
      const fromType = await createType('RACE-C');
      const toType = await createType('RACE-C-TO');
      const preferred = await createRoom(fromType, 'C1');
      await createRoom(fromType, 'C2');
      await createRoom(fromType, 'C3');
      const reservation = await book(fromType, `2033-${String((round % 12) + 1).padStart(2, '0')}-1${Math.floor(round / 12)}`, { preferredRoomId: preferred });

      const [cancel, change] = await raceWithOffset(
        () => post(`/reservations/${reservation.id}/cancel`, { reason: 'race' }),
        () => post(`/rooms/${preferred}/change-type`, { room_type_id: String(toType) }),
        OFFSETS[round]
      );

      expect(cancel.status).toBe(200);
      expect(change.status).toBe(200);
      // Either order is legitimate: the move ran while the reservation was still open (preference cleared), or the cancel committed first (a cancelled reservation keeps its historical preference).
      const stored = await db()('reservations').where({ id: reservation.id }).first();
      expect(stored.status).toBe('cancelled');
      expect([null, String(preferred)]).toContain(stored.preferred_room_id === null ? null : String(stored.preferred_room_id));
      expect(change.body.data.cleared_preferences.length === 1).toBe(stored.preferred_room_id === null);
    }
  });

  it('D: two identical change-type requests — one changes the room, the other finds it already changed', async () => {
    const fromType = await createType('RACE-D');
    const toType = await createType('RACE-D-TO');
    const room = await createRoom(fromType, 'D1');
    await createRoom(fromType, 'D2');

    const [first, second] = await Promise.all([
      post(`/rooms/${room}/change-type`, { room_type_id: String(toType) }),
      post(`/rooms/${room}/change-type`, { room_type_id: String(toType) }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data.changed.length + second.body.data.changed.length).toBe(1);
    expect(first.body.data.unchanged.length + second.body.data.unchanged.length).toBe(1);
    expect(String((await roomRow(room)).room_type_id)).toBe(String(toType));
  });
});
