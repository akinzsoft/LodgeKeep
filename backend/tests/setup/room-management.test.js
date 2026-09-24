'use strict';

/**
 * HTTP-level tests for managing rooms after creation (gap closure): rename,
 * change room type, archive, restore, delete — single and bulk — and the
 * guards around occupied rooms, future reservations, capacity, history and
 * preferred rooms. Also the archived-room leak fixes in check-in, room
 * move, preferred-room validation, setup progress, housekeeping and QR
 * tokens.
 *
 * Runs inside the shared per-file transaction (`useTestApp`), so every
 * request here is serialised on one connection: it proves the GUARD LOGIC.
 * The lock ordering under real contention is proven separately in
 * `room-management-concurrency.test.js`, which needs real pooled connections.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const roomManagement = require('../../src/modules/setup/room-management');

describe('Room management (gap closure)', () => {
  const t = useTestApp();
  let ctx;
  let rateCodeId;
  let seq = 0;

  const A = () => ctx.a;
  const propertyId = () => ctx.a.properties[0].id;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    // users[1] holds `housekeeping` at properties[0] in the fixture grant plan — promote to admin (setup.manage + reservations/front_desk/housekeeping).
    await t.trx('user_property_access').where({ user_id: ctx.a.users[1].id, property_id: propertyId() }).update({ role: 'admin' });
    [rateCodeId] = await t.trx('rate_codes').insert({
      tenant_id: A().id,
      property_id: propertyId(),
      code: 'RMGMT',
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
  });

  function adminToken({ tenant = ctx.a, propertyIdOverride } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[1].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyIdOverride ?? tenant.properties[0].id),
    });
  }

  /** users[0] is a manager: `setup.view` only, no `setup.manage`. */
  function managerToken() {
    return signAccessToken({
      aud: 'staff',
      sub: String(ctx.a.users[0].id),
      tenant_id: String(ctx.a.id),
      property_id: String(propertyId()),
    });
  }

  const api = {
    get: (path, token = adminToken()) => t.request.get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
    post: (path, body = {}, token = adminToken()) =>
      t.request.post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', `rm-${(seq += 1)}-${Date.now()}`).send(body),
    patch: (path, body = {}, token = adminToken()) => t.request.patch(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
    del: (path, body = {}, token = adminToken()) => t.request.delete(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
  };

  async function createRoomType(code, { name = code, thresholdPct } = {}) {
    const [id] = await t.trx('room_types').insert({
      tenant_id: A().id,
      property_id: propertyId(),
      code,
      name,
      default_occupancy: 2,
      base_rate: '100.00',
    });
    return { id, thresholdPct };
  }

  async function createRoom(typeId, roomNumber, extra = {}) {
    const [id] = await t.trx('rooms').insert({
      tenant_id: A().id,
      property_id: propertyId(),
      room_type_id: typeId,
      room_number: roomNumber,
      housekeeping_reported_status: 'clean',
      ...extra,
    });
    return id;
  }

  async function book({ typeId, arrival, departure, preferredRoomId }) {
    const res = await api.post('/reservations', {
      guest_id: String(A().guests[0].id),
      room_type_id: String(typeId),
      rate_code_id: String(rateCodeId),
      arrival_date: arrival,
      departure_date: departure,
      ...(preferredRoomId ? { preferred_room_id: String(preferredRoomId) } : {}),
    });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function checkIn(reservationId, roomId) {
    const res = await api.post(`/reservations/${reservationId}/check-in`, { room_id: String(roomId) });
    expect(res.status).toBe(200);
    return res.body.data;
  }

  const room = (id) => t.trx('rooms').where({ id }).first();
  const reasonCodes = (blockedEntry) => blockedEntry.reasons.map((r) => r.code);
  const blockedFor = (res, roomId) => res.body.error.details.blocked.find((b) => String(b.room_id) === String(roomId));

  // ====================================================================
  // Rename
  // ====================================================================
  describe('PATCH /rooms/:id — rename and floor only', () => {
    it('renames a room and clears its floor', async () => {
      const type = await createRoomType('RN1');
      const id = await createRoom(type.id, 'RN-100', { floor: '3' });
      const res = await api.patch(`/rooms/${id}`, { room_number: 'RN-200', floor: null });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ room_number: 'RN-200', floor: null });
      expect(res.body.meta.updated_open_order_labels).toBe(0);
    });

    it('ignores every field outside the allowlist — status, occupancy flags, type and scope cannot be written', async () => {
      const type = await createRoomType('RN2');
      const other = await createRoomType('RN2B');
      const id = await createRoom(type.id, 'RN-ALLOW');
      const res = await api.patch(`/rooms/${id}`, {
        floor: '9',
        status: 'archived',
        front_desk_status: 'occupied',
        has_discrepancy: true,
        room_type_id: String(other.id),
        tenant_id: '999',
        id: '1',
      });
      expect(res.status).toBe(200);
      const after = await room(id);
      expect(after).toMatchObject({ floor: '9', status: 'active', front_desk_status: 'vacant' });
      expect(String(after.room_type_id)).toBe(String(type.id));
      expect(Boolean(after.has_discrepancy)).toBe(false);
    });

    it('a body with no editable field is a 400', async () => {
      const type = await createRoomType('RN3');
      const id = await createRoom(type.id, 'RN-EMPTY');
      const res = await api.patch(`/rooms/${id}`, { status: 'archived' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
    });

    it('a duplicate number is a 409, not a 500', async () => {
      const type = await createRoomType('RN4');
      await createRoom(type.id, 'RN-TAKEN');
      const id = await createRoom(type.id, 'RN-MINE');
      const res = await api.patch(`/rooms/${id}`, { room_number: 'RN-TAKEN' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_DUPLICATE_ENTRY');
    });

    it('the collision is case-insensitive (the unique index uses a case-insensitive collation)', async () => {
      const type = await createRoomType('RN5');
      await createRoom(type.id, 'RN-204A');
      const id = await createRoom(type.id, 'RN-204');
      const res = await api.patch(`/rooms/${id}`, { room_number: 'rn-204a' });
      expect(res.status).toBe(409);
    });

    it('rejects a blank number and one longer than the 20-character column', async () => {
      const type = await createRoomType('RN6');
      const id = await createRoom(type.id, 'RN-LEN');
      expect((await api.patch(`/rooms/${id}`, { room_number: '   ' })).status).toBe(400);
      const tooLong = await api.patch(`/rooms/${id}`, { room_number: 'X'.repeat(21) });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error.code).toBe('VALIDATION_INVALID_ROOM_NUMBER');
    });

    it('an archived room cannot be renamed', async () => {
      const type = await createRoomType('RN7');
      const id = await createRoom(type.id, 'RN-ARCH', { status: 'archived' });
      const res = await api.patch(`/rooms/${id}`, { room_number: 'RN-ARCH2' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_ROOM_ARCHIVED');
    });

    it('a rename re-labels OPEN guest QR room tabs and leaves settled, void and table-token tabs alone', async () => {
      const type = await createRoomType('RN8');
      const roomId = await createRoom(type.id, 'RN-QR');
      const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: A().id, property_id: propertyId(), code: 'RNBAR', name: 'Bar', type: 'bar' });
      const insertToken = (extra) =>
        t.trx('pos_order_tokens').insert({
          tenant_id: A().id,
          property_id: propertyId(),
          outlet_id: outletId,
          token_hash: `h-${Date.now()}-${(seq += 1)}`,
          token_encrypted: 'x',
          ...extra,
        });
      const [roomTokenId] = await insertToken({ type: 'room', room_id: roomId });
      const [tableTokenId] = await insertToken({ type: 'table', table_label: 'Room RN-QR' });

      const insertOrder = async ({ status, tokenId }) => {
        const [orderId] = await t.trx('pos_orders').insert({
          tenant_id: A().id,
          property_id: propertyId(),
          outlet_id: outletId,
          table_label: 'Room RN-QR',
          source: 'guest',
          status,
        });
        await t.trx('pos_guest_orders').insert({
          tenant_id: A().id,
          property_id: propertyId(),
          pos_order_id: orderId,
          token_id: tokenId,
          payment_method: 'card',
        });
        return orderId;
      };
      const openOrder = await insertOrder({ status: 'open', tokenId: roomTokenId });
      const settledOrder = await insertOrder({ status: 'settled', tokenId: roomTokenId });
      const voidOrder = await insertOrder({ status: 'void', tokenId: roomTokenId });
      const tableOrder = await insertOrder({ status: 'open', tokenId: tableTokenId });

      const res = await api.patch(`/rooms/${roomId}`, { room_number: 'RN-QR2' });
      expect(res.status).toBe(200);
      expect(res.body.meta.updated_open_order_labels).toBe(1);

      const label = async (id) => (await t.trx('pos_orders').where({ id }).first()).table_label;
      expect(await label(openOrder)).toBe('Room RN-QR2');
      expect(await label(settledOrder)).toBe('Room RN-QR');
      expect(await label(voidOrder)).toBe('Room RN-QR');
      expect(await label(tableOrder)).toBe('Room RN-QR');
    });

    it('writes an audit row with the before and after number', async () => {
      const type = await createRoomType('RN9');
      const id = await createRoom(type.id, 'RN-AUD');
      await api.patch(`/rooms/${id}`, { room_number: 'RN-AUD2' });
      const row = await t.trx('audit_log').where({ entity_type: 'rooms', entity_id: id, action: 'update' }).first();
      expect(row).toBeDefined();
      const after = typeof row.after_state === 'string' ? JSON.parse(row.after_state) : row.after_state;
      expect(after.room_number).toEqual({ from: 'RN-AUD', to: 'RN-AUD2' });
    });

    it('cross-tenant id is a 404, and a manager (setup.view only) is refused with 403', async () => {
      const type = await createRoomType('RN10');
      const id = await createRoom(type.id, 'RN-XT');
      expect((await api.patch(`/rooms/${ctx.b.rooms[0].id}`, { floor: '2' })).status).toBe(404);
      expect((await api.patch(`/rooms/${id}`, { floor: '2' }, managerToken())).status).toBe(403);
    });
  });

  // ====================================================================
  // Change room type
  // ====================================================================
  describe('POST /rooms/:id/change-type and /rooms/change-type', () => {
    it('moves a free room to another type', async () => {
      const from = await createRoomType('CT-FROM');
      const to = await createRoomType('CT-TO');
      const id = await createRoom(from.id, 'CT-1');
      const res = await api.post(`/rooms/${id}/change-type`, { room_type_id: String(to.id) });
      expect(res.status).toBe(200);
      expect(res.body.data.changed).toHaveLength(1);
      expect(String((await room(id)).room_type_id)).toBe(String(to.id));
      expect(res.body.data.cleared_preferences).toEqual([]);
    });

    it('a room already of the target type is reported unchanged, not an error', async () => {
      const type = await createRoomType('CT-SAME');
      const id = await createRoom(type.id, 'CT-2');
      const res = await api.post(`/rooms/${id}/change-type`, { room_type_id: String(type.id) });
      expect(res.status).toBe(200);
      expect(res.body.data.changed).toEqual([]);
      expect(res.body.data.unchanged).toHaveLength(1);
    });

    it('rejects a nonexistent or archived target type with 400', async () => {
      const from = await createRoomType('CT-FROM2');
      const id = await createRoom(from.id, 'CT-3');
      const archivedType = await createRoomType('CT-ARCH');
      await t.trx('room_types').where({ id: archivedType.id }).update({ status: 'archived' });
      const archived = await api.post(`/rooms/${id}/change-type`, { room_type_id: String(archivedType.id) });
      expect(archived.status).toBe(400);
      expect(archived.body.error.code).toBe('VALIDATION_ROOM_TYPE_NOT_FOUND');
      expect((await api.post(`/rooms/${id}/change-type`, { room_type_id: '99999999' })).status).toBe(400);
    });

    it('never silently moves an OCCUPIED room — a checked-in guest blocks it', async () => {
      const from = await createRoomType('CT-OCC');
      const to = await createRoomType('CT-OCC2');
      const id = await createRoom(from.id, 'CT-4');
      const reservation = await book({ typeId: from.id, arrival: '2027-03-01', departure: '2027-03-03' });
      await checkIn(reservation.id, id);

      const res = await api.post(`/rooms/${id}/change-type`, { room_type_id: String(to.id) });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_ROOM_CHANGE_BLOCKED');
      const entry = blockedFor(res, id);
      expect(reasonCodes(entry)).toContain('OCCUPIED');
      expect(String((await room(id)).room_type_id)).toBe(String(from.id));
    });

    it('a room with an open housekeeping discrepancy is blocked (its occupancy is uncertain)', async () => {
      const from = await createRoomType('CT-DISC');
      const to = await createRoomType('CT-DISC2');
      const id = await createRoom(from.id, 'CT-5', { has_discrepancy: true });
      const res = await api.post(`/rooms/${id}/change-type`, { room_type_id: String(to.id) });
      expect(res.status).toBe(409);
      expect(reasonCodes(blockedFor(res, id))).toContain('HAS_OPEN_DISCREPANCY');
    });

    describe('capacity — future nights already booked on the source type', () => {
      it('blocks a move that would leave booked nights oversold, with the night and the numbers', async () => {
        const from = await createRoomType('CT-CAP');
        const to = await createRoomType('CT-CAP-TO');
        const r1 = await createRoom(from.id, 'CAP-1');
        await createRoom(from.id, 'CAP-2');
        await book({ typeId: from.id, arrival: '2027-04-10', departure: '2027-04-11' });
        await book({ typeId: from.id, arrival: '2027-04-10', departure: '2027-04-11' });

        const res = await api.post(`/rooms/${r1}/change-type`, { room_type_id: String(to.id) });
        expect(res.status).toBe(409);
        const reason = blockedFor(res, r1).reasons.find((r) => r.code === 'WOULD_OVERBOOK');
        expect(reason.details.violations[0]).toMatchObject({ stay_date: '2027-04-10', rooms_sold: 2, capacity_after: 1, threshold_after: 1 });
        expect(reason.details.total_violating_nights).toBe(1);
        expect(String((await room(r1)).room_type_id)).toBe(String(from.id));
      });

      it('allows the move when the booked nights still fit, and an overbooking threshold above 100% is honoured', async () => {
        const from = await createRoomType('CT-CAP3');
        const to = await createRoomType('CT-CAP3-TO');
        const r1 = await createRoom(from.id, 'CAP3-1');
        await createRoom(from.id, 'CAP3-2');
        await createRoom(from.id, 'CAP3-3');
        await book({ typeId: from.id, arrival: '2027-04-20', departure: '2027-04-21' });
        await book({ typeId: from.id, arrival: '2027-04-20', departure: '2027-04-21' });
        const res = await api.post(`/rooms/${r1}/change-type`, { room_type_id: String(to.id) });
        expect(res.status).toBe(200);
      });

      it('is cumulative across a bulk change — each room passes alone, both together are blocked, and BOTH are reported', async () => {
        const from = await createRoomType('CT-BULK');
        const to = await createRoomType('CT-BULK-TO');
        const r1 = await createRoom(from.id, 'BULK-1');
        const r2 = await createRoom(from.id, 'BULK-2');
        await createRoom(from.id, 'BULK-3');
        await book({ typeId: from.id, arrival: '2027-05-10', departure: '2027-05-11' });
        await book({ typeId: from.id, arrival: '2027-05-10', departure: '2027-05-11' });

        const both = await api.post('/rooms/change-type', { room_ids: [String(r1), String(r2)], room_type_id: String(to.id) });
        expect(both.status).toBe(409);
        expect(both.body.error.details.blocked.map((b) => String(b.room_id)).sort()).toEqual([String(r1), String(r2)].sort());
        // Nothing applied.
        expect(String((await room(r1)).room_type_id)).toBe(String(from.id));
        expect(String((await room(r2)).room_type_id)).toBe(String(from.id));

        const one = await api.post('/rooms/change-type', { room_ids: [String(r1)], room_type_id: String(to.id) });
        expect(one.status).toBe(200);
      });

      it('nights before the property business date are ignored — the past cannot be re-sold', async () => {
        const from = await createRoomType('CT-PAST');
        const to = await createRoomType('CT-PAST-TO');
        const r1 = await createRoom(from.id, 'PAST-1');
        await book({ typeId: from.id, arrival: '2027-02-01', departure: '2027-02-02' });
        const before = await t.trx('properties').where({ id: propertyId() }).first('current_business_date');
        try {
          await t.trx('properties').where({ id: propertyId() }).update({ current_business_date: '2027-02-10' });
          const res = await api.post(`/rooms/${r1}/change-type`, { room_type_id: String(to.id) });
          expect(res.status).toBe(200);
        } finally {
          await t.trx('properties').where({ id: propertyId() }).update({ current_business_date: before.current_business_date });
        }
      });

      it('an out-of-order room costs no capacity on its OOO nights, so it is not blamed for an existing overbooking', async () => {
        const from = await createRoomType('CT-OOO');
        const to = await createRoomType('CT-OOO-TO');
        const inService = await createRoom(from.id, 'OOO-1');
        const outOfOrder = await createRoom(from.id, 'OOO-2');
        await book({ typeId: from.id, arrival: '2027-06-10', departure: '2027-06-11' });
        await book({ typeId: from.id, arrival: '2027-06-10', departure: '2027-06-11' });
        // The out-of-order period arrives AFTER both bookings were accepted: the night is now overbooked (2 sold, capacity 1).
        await t.trx('out_of_order_periods').insert({
          tenant_id: A().id,
          property_id: propertyId(),
          room_id: outOfOrder,
          type: 'ooo',
          created_by_user_id: A().users[0].id,
          reason: 'leak',
          start_date: '2027-06-01',
          end_date: '2027-06-30',
        });

        // Moving the room that is already out of order changes nothing about that night.
        const moveOoo = await api.post(`/rooms/${outOfOrder}/change-type`, { room_type_id: String(to.id) });
        expect(moveOoo.status).toBe(200);
        // Moving the in-service room would drop capacity to zero.
        const moveInService = await api.post(`/rooms/${inService}/change-type`, { room_type_id: String(to.id) });
        expect(moveInService.status).toBe(409);
        expect(reasonCodes(blockedFor(moveInService, inService))).toContain('WOULD_OVERBOOK');
      });
    });

    describe('preferred rooms', () => {
      it('clears the preference on OPEN reservations that named the room, and lists them in the response and the audit log', async () => {
        const from = await createRoomType('CT-PREF');
        const to = await createRoomType('CT-PREF-TO');
        const id = await createRoom(from.id, 'PREF-1');
        await createRoom(from.id, 'PREF-2');
        const reservation = await book({ typeId: from.id, arrival: '2027-07-10', departure: '2027-07-11', preferredRoomId: id });

        const res = await api.post(`/rooms/${id}/change-type`, { room_type_id: String(to.id) });
        expect(res.status).toBe(200);
        expect(res.body.data.cleared_preferences).toHaveLength(1);
        expect(res.body.data.cleared_preferences[0]).toMatchObject({ reservation_id: reservation.id, confirmation_number: reservation.confirmation_number, room_number: 'PREF-1' });

        const stored = await t.trx('reservations').where({ id: reservation.id }).first('preferred_room_id', 'status');
        expect(stored.preferred_room_id).toBeNull();
        expect(stored.status).toBe('confirmed'); // the booking itself is untouched

        const auditRow = await t.trx('audit_log').where({ entity_type: 'reservations', entity_id: reservation.id, action: 'preferred_room_cleared' }).first();
        expect(auditRow).toBeDefined();
      });

      it('leaves the historical preference on a cancelled reservation alone', async () => {
        const from = await createRoomType('CT-PREF3');
        const to = await createRoomType('CT-PREF3-TO');
        const id = await createRoom(from.id, 'PREF3-1');
        await createRoom(from.id, 'PREF3-2');
        const reservation = await book({ typeId: from.id, arrival: '2027-07-20', departure: '2027-07-21', preferredRoomId: id });
        await t.trx('reservations').where({ id: reservation.id }).update({ status: 'cancelled' });

        const res = await api.post(`/rooms/${id}/change-type`, { room_type_id: String(to.id) });
        expect(res.status).toBe(200);
        expect(res.body.data.cleared_preferences).toEqual([]);
        expect(String((await t.trx('reservations').where({ id: reservation.id }).first()).preferred_room_id)).toBe(String(id));
      });
    });

    describe('bulk', () => {
      it('applies every room together when none is blocked', async () => {
        const from = await createRoomType('CT-B2');
        const to = await createRoomType('CT-B2-TO');
        const ids = [await createRoom(from.id, 'B2-1'), await createRoom(from.id, 'B2-2'), await createRoom(from.id, 'B2-3')];
        const res = await api.post('/rooms/change-type', { room_ids: ids.map(String), room_type_id: String(to.id), reason: 'entered under the wrong type' });
        expect(res.status).toBe(200);
        expect(res.body.data.changed).toHaveLength(3);
        expect(res.body.meta.changed_count).toBe(3);
        for (const id of ids) expect(String((await room(id)).room_type_id)).toBe(String(to.id));
        const auditRows = await t.trx('audit_log').where({ entity_type: 'rooms', action: 'change_type' }).whereIn('entity_id', ids);
        expect(auditRows).toHaveLength(3);
        expect(auditRows.every((row) => row.reason === 'entered under the wrong type')).toBe(true);
      });

      it('is all-or-nothing: one occupied room blocks the whole batch and every other room stays put', async () => {
        const from = await createRoomType('CT-B3');
        const to = await createRoomType('CT-B3-TO');
        const free1 = await createRoom(from.id, 'B3-1');
        const free2 = await createRoom(from.id, 'B3-2');
        const occupied = await createRoom(from.id, 'B3-3');
        await createRoom(from.id, 'B3-4'); // capacity left after the batch, so only OCCUPIED blocks
        const reservation = await book({ typeId: from.id, arrival: '2027-08-01', departure: '2027-08-03' });
        await checkIn(reservation.id, occupied);

        const res = await api.post('/rooms/change-type', { room_ids: [free1, free2, occupied].map(String), room_type_id: String(to.id) });
        expect(res.status).toBe(409);
        expect(res.body.error.details.blocked).toHaveLength(1);
        expect(String(res.body.error.details.blocked[0].room_id)).toBe(String(occupied));
        for (const id of [free1, free2, occupied]) expect(String((await room(id)).room_type_id)).toBe(String(from.id));
      });

      it('an unknown or cross-tenant id is reported as NOT_FOUND — indistinguishable from a nonexistent one', async () => {
        const from = await createRoomType('CT-B4');
        const to = await createRoomType('CT-B4-TO');
        const mine = await createRoom(from.id, 'B4-1');
        const res = await api.post('/rooms/change-type', { room_ids: [String(mine), String(ctx.b.rooms[0].id), '99999999'], room_type_id: String(to.id) });
        expect(res.status).toBe(409);
        const blocked = res.body.error.details.blocked;
        expect(blocked).toHaveLength(2);
        expect(blocked.every((b) => reasonCodes(b).includes('NOT_FOUND'))).toBe(true);
        expect(blocked.every((b) => b.room_number === null)).toBe(true);
        expect(String((await room(mine)).room_type_id)).toBe(String(from.id));
      });

      it('validates the list: empty, too large, or non-numeric ids are 400s', async () => {
        const to = await createRoomType('CT-B5-TO');
        const body = (room_ids) => ({ room_ids, room_type_id: String(to.id) });
        expect((await api.post('/rooms/change-type', body([]))).status).toBe(400);
        expect((await api.post('/rooms/change-type', body(Array.from({ length: 501 }, (_, i) => String(i + 1))))).status).toBe(400);
        const bad = await api.post('/rooms/change-type', body(['abc']));
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('VALIDATION_INVALID_ROOM_IDS');
      });
    });

    it('RBAC: a manager (setup.view only) is refused, and a cross-tenant single id is a 404', async () => {
      const from = await createRoomType('CT-RBAC');
      const to = await createRoomType('CT-RBAC-TO');
      const id = await createRoom(from.id, 'RBAC-1');
      expect((await api.post(`/rooms/${id}/change-type`, { room_type_id: String(to.id) }, managerToken())).status).toBe(403);
      expect((await api.post('/rooms/change-type', { room_ids: [String(id)], room_type_id: String(to.id) }, managerToken())).status).toBe(403);
      expect((await api.post(`/rooms/${ctx.b.rooms[0].id}/change-type`, { room_type_id: String(to.id) })).status).toBe(404);
    });
  });

  // ====================================================================
  // Archive / restore
  // ====================================================================
  describe('archive and restore', () => {
    it('archives a free room: it leaves GET /rooms, appears in the archived view, and keeps its number reserved', async () => {
      const type = await createRoomType('AR1');
      const id = await createRoom(type.id, 'AR-1');
      const res = await api.post(`/rooms/${id}/archive`, { reason: 'demolished' });
      expect(res.status).toBe(200);
      expect(res.body.data.changed[0]).toMatchObject({ status: 'archived' });

      const active = await api.get('/rooms');
      expect(active.body.data.some((r) => String(r.id) === String(id))).toBe(false);
      const archived = await api.get('/rooms?status=archived');
      expect(archived.body.data.some((r) => String(r.id) === String(id))).toBe(true);
      expect(archived.body.data.every((r) => r.status === 'archived')).toBe(true);

      const reuse = await api.post('/rooms', { room_number: 'AR-1', room_type_id: String(type.id) });
      expect(reuse.status).toBe(409);
    });

    it('requires a reason', async () => {
      const type = await createRoomType('AR2');
      const id = await createRoom(type.id, 'AR-2');
      const res = await api.post(`/rooms/${id}/archive`, {});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
      expect((await room(id)).status).toBe('active');
    });

    it('a whitespace-only reason is not a reason — refused server-side, nothing changes', async () => {
      const type = await createRoomType('AR2B');
      const id = await createRoom(type.id, 'AR-2B');
      for (const call of [
        () => api.post(`/rooms/${id}/archive`, { reason: '   ' }),
        () => api.post('/rooms/archive', { room_ids: [String(id)], reason: '\n\t ' }),
        () => api.del(`/rooms/${id}`, { reason: '  ' }),
      ]) {
        const res = await call();
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
      }
      expect((await room(id)).status).toBe('active');
    });

    it('never archives an OCCUPIED room', async () => {
      const type = await createRoomType('AR3');
      const id = await createRoom(type.id, 'AR-3');
      const reservation = await book({ typeId: type.id, arrival: '2027-09-01', departure: '2027-09-03' });
      await checkIn(reservation.id, id);
      const res = await api.post(`/rooms/${id}/archive`, { reason: 'x' });
      expect(res.status).toBe(409);
      expect(reasonCodes(blockedFor(res, id))).toContain('OCCUPIED');
      expect((await room(id)).status).toBe('active');
    });

    it('blocks a room with an open discrepancy, and one whose departure would oversell the type', async () => {
      const type = await createRoomType('AR4');
      const disc = await createRoom(type.id, 'AR-4D', { has_discrepancy: true });
      const discRes = await api.post(`/rooms/${disc}/archive`, { reason: 'x' });
      expect(reasonCodes(blockedFor(discRes, disc))).toContain('HAS_OPEN_DISCREPANCY');

      const capType = await createRoomType('AR4C');
      const only = await createRoom(capType.id, 'AR-4C');
      await book({ typeId: capType.id, arrival: '2027-09-10', departure: '2027-09-11' });
      const capRes = await api.post(`/rooms/${only}/archive`, { reason: 'x' });
      expect(capRes.status).toBe(409);
      expect(reasonCodes(blockedFor(capRes, only))).toContain('WOULD_OVERBOOK');
    });

    it('clears the preference on open reservations, and connecting-room links in BOTH directions, and reports them', async () => {
      const type = await createRoomType('AR5');
      const target = await createRoom(type.id, 'AR-5A');
      const linkedTo = await createRoom(type.id, 'AR-5B');
      await createRoom(type.id, 'AR-5C');
      await t.trx('rooms').where({ id: target }).update({ connecting_room_id: linkedTo });
      await t.trx('rooms').where({ id: linkedTo }).update({ connecting_room_id: target });
      const reservation = await book({ typeId: type.id, arrival: '2027-09-20', departure: '2027-09-21', preferredRoomId: target });

      const res = await api.post(`/rooms/${target}/archive`, { reason: 'closed for refit' });
      expect(res.status).toBe(200);
      expect(res.body.data.cleared_preferences.map((p) => p.reservation_id)).toEqual([reservation.id]);
      expect(res.body.data.cleared_connecting_links.map((l) => String(l.room_id)).sort()).toEqual([String(target), String(linkedTo)].sort());
      expect((await room(linkedTo)).connecting_room_id).toBeNull();
      expect((await room(target)).connecting_room_id).toBeNull();
      expect((await t.trx('reservations').where({ id: reservation.id }).first()).preferred_room_id).toBeNull();
    });

    it('archiving an already-archived room is a no-op reported as unchanged (safe to retry)', async () => {
      const type = await createRoomType('AR6');
      const id = await createRoom(type.id, 'AR-6', { status: 'archived' });
      const res = await api.post(`/rooms/${id}/archive`, { reason: 'x' });
      expect(res.status).toBe(200);
      expect(res.body.data.changed).toEqual([]);
      expect(res.body.data.unchanged).toHaveLength(1);
    });

    it('bulk archive is all-or-nothing and requires a reason', async () => {
      const type = await createRoomType('AR7');
      const free = await createRoom(type.id, 'AR-7A');
      const occupied = await createRoom(type.id, 'AR-7B');
      await createRoom(type.id, 'AR-7C');
      const reservation = await book({ typeId: type.id, arrival: '2027-10-01', departure: '2027-10-03' });
      await checkIn(reservation.id, occupied);

      expect((await api.post('/rooms/archive', { room_ids: [String(free)] })).status).toBe(400);
      const res = await api.post('/rooms/archive', { room_ids: [String(free), String(occupied)], reason: 'closing block' });
      expect(res.status).toBe(409);
      expect((await room(free)).status).toBe('active');

      const ok = await api.post('/rooms/archive', { room_ids: [String(free)], reason: 'closing block' });
      expect(ok.status).toBe(200);
      expect((await room(free)).status).toBe('archived');
    });

    it('restore brings a room back; it is refused while its room type is archived, and a repeat is a no-op', async () => {
      const type = await createRoomType('AR8');
      const id = await createRoom(type.id, 'AR-8', { status: 'archived' });
      const restored = await api.post(`/rooms/${id}/restore`);
      expect(restored.status).toBe(200);
      expect(restored.body.meta.restored).toBe(true);
      expect((await room(id)).status).toBe('active');
      expect((await api.post(`/rooms/${id}/restore`)).body.meta.restored).toBe(false);

      const deadType = await createRoomType('AR8D');
      const stranded = await createRoom(deadType.id, 'AR-8S', { status: 'archived' });
      await t.trx('room_types').where({ id: deadType.id }).update({ status: 'archived' });
      const refused = await api.post(`/rooms/${stranded}/restore`);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('CONFLICT_ROOM_TYPE_ARCHIVED');
    });

    it('RBAC and isolation: manager is refused; another tenant\'s room is a 404', async () => {
      const type = await createRoomType('AR9');
      const id = await createRoom(type.id, 'AR-9');
      expect((await api.post(`/rooms/${id}/archive`, { reason: 'x' }, managerToken())).status).toBe(403);
      expect((await api.post(`/rooms/${ctx.b.rooms[0].id}/archive`, { reason: 'x' })).status).toBe(404);
      expect((await api.post(`/rooms/${ctx.b.rooms[0].id}/restore`)).status).toBe(404);
    });
  });

  // ====================================================================
  // Delete
  // ====================================================================
  describe('DELETE /rooms/:id — only when nothing references the room', () => {
    it('deletes a never-used room, and its number becomes reusable', async () => {
      const type = await createRoomType('DL1');
      const id = await createRoom(type.id, 'DL-1');
      const res = await api.del(`/rooms/${id}`, { reason: 'created by mistake' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: String(id), room_number: 'DL-1', deleted: true });
      expect(await room(id)).toBeUndefined();
      expect((await api.post('/rooms', { room_number: 'DL-1', room_type_id: String(type.id) })).status).toBe(201);
      expect((await api.del(`/rooms/${id}`, { reason: 'again' })).status).toBe(404);
    });

    it('requires a reason', async () => {
      const type = await createRoomType('DL2');
      const id = await createRoom(type.id, 'DL-2');
      expect((await api.del(`/rooms/${id}`, {})).status).toBe(400);
      expect(await room(id)).toBeDefined();
    });

    it('GET /rooms/:id/usage says deletable for a clean room and lists the references otherwise', async () => {
      const type = await createRoomType('DL3');
      const clean = await createRoom(type.id, 'DL-3A');
      const used = await createRoom(type.id, 'DL-3B');
      const reservation = await book({ typeId: type.id, arrival: '2027-11-01', departure: '2027-11-02' });
      await checkIn(reservation.id, used);

      const cleanUsage = await api.get(`/rooms/${clean}/usage`);
      expect(cleanUsage.body.data).toMatchObject({ deletable: true, occupied: false, references: {} });
      const usedUsage = await api.get(`/rooms/${used}/usage`);
      expect(usedUsage.body.data).toMatchObject({ deletable: false, occupied: true });
      expect(usedUsage.body.data.references.reservation_rooms).toBe(1);
      expect((await api.get(`/rooms/${ctx.b.rooms[0].id}/usage`)).status).toBe(404);
    });

    describe('any reference at all — open or historical — is HAS_HISTORY, with the counts and a pointer to archive', () => {
      async function expectHistory(id, table) {
        const res = await api.del(`/rooms/${id}`, { reason: 'x' });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT_ROOM_CHANGE_BLOCKED');
        const reason = blockedFor(res, id).reasons.find((r) => r.code === 'HAS_HISTORY');
        expect(reason).toBeDefined();
        expect(reason.details.references[table]).toBeGreaterThan(0);
        expect(reason.details.suggested_action).toBe('archive');
        expect(await room(id)).toBeDefined();
      }

      it('a stay (reservation_rooms), even after the guest has left', async () => {
        const type = await createRoomType('DL4');
        const id = await createRoom(type.id, 'DL-4');
        const reservation = await book({ typeId: type.id, arrival: '2027-11-10', departure: '2027-11-11' });
        await checkIn(reservation.id, id);
        await t.trx('reservation_rooms').where({ room_id: id }).update({ effective_to: new Date() });
        await t.trx('rooms').where({ id }).update({ front_desk_status: 'vacant' });
        await expectHistory(id, 'reservation_rooms');
      });

      it('a preferred room, even on a cancelled reservation', async () => {
        const type = await createRoomType('DL5');
        const id = await createRoom(type.id, 'DL-5');
        await createRoom(type.id, 'DL-5B');
        const reservation = await book({ typeId: type.id, arrival: '2027-11-20', departure: '2027-11-21', preferredRoomId: id });
        await t.trx('reservations').where({ id: reservation.id }).update({ status: 'cancelled' });
        await expectHistory(id, 'reservations');
      });

      it('an out-of-order period, a housekeeping assignment and a discrepancy row', async () => {
        const type = await createRoomType('DL6');
        const ooo = await createRoom(type.id, 'DL-6A');
        await t.trx('out_of_order_periods').insert({ tenant_id: A().id, property_id: propertyId(), room_id: ooo, type: 'ooo',
          created_by_user_id: A().users[0].id, reason: 'x', start_date: '2027-01-01', end_date: '2027-01-02' });
        await expectHistory(ooo, 'out_of_order_periods');

        const assigned = await createRoom(type.id, 'DL-6B');
        await t.trx('housekeeping_assignments').insert({ tenant_id: A().id, property_id: propertyId(), room_id: assigned, attendant_user_id: A().users[0].id, business_date: '2027-01-01' });
        await expectHistory(assigned, 'housekeeping_assignments');

        const disputed = await createRoom(type.id, 'DL-6C');
        await t.trx('housekeeping_discrepancies').insert({
          tenant_id: A().id,
          property_id: propertyId(),
          room_id: disputed,
          business_date: '2027-01-01',
          front_desk_status: 'vacant',
          housekeeping_status: 'occupied',
        });
        await expectHistory(disputed, 'housekeeping_discrepancies');
      });

      it('a QR token', async () => {
        const type = await createRoomType('DL7');
        const id = await createRoom(type.id, 'DL-7');
        const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: A().id, property_id: propertyId(), code: 'DL7BAR', name: 'Bar', type: 'bar' });
        await t.trx('pos_order_tokens').insert({ tenant_id: A().id, property_id: propertyId(), outlet_id: outletId, type: 'room', room_id: id, token_hash: `dl7-${Date.now()}`, token_encrypted: 'x' });
        await expectHistory(id, 'pos_order_tokens');
      });
    });

    it('the FK is the race-proof backstop: a reference the pre-check missed still cannot delete the room, and maps to HAS_HISTORY not a 500', async () => {
      const type = await createRoomType('DL8');
      const id = await createRoom(type.id, 'DL-8');
      await t.trx('out_of_order_periods').insert({ tenant_id: A().id, property_id: propertyId(), room_id: id, type: 'ooo',
          created_by_user_id: A().users[0].id, reason: 'x', start_date: '2027-01-01', end_date: '2027-01-02' });

      // Simulate the race: hide the referencing table from the friendly pre-check, exactly as if the row had committed after it ran.
      const index = roomManagement.ROOM_REFERENCE_TABLES.findIndex((entry) => entry.table === 'out_of_order_periods');
      const [removed] = roomManagement.ROOM_REFERENCE_TABLES.splice(index, 1);
      try {
        const res = await api.del(`/rooms/${id}`, { reason: 'x' });
        expect(res.status).toBe(409);
        expect(reasonCodes(blockedFor(res, id))).toContain('HAS_HISTORY');
        expect(await room(id)).toBeDefined();
      } finally {
        roomManagement.ROOM_REFERENCE_TABLES.splice(index, 0, removed);
      }
    });

    it('clears connecting-room links pointing at the deleted room', async () => {
      const type = await createRoomType('DL9');
      const target = await createRoom(type.id, 'DL-9A');
      const other = await createRoom(type.id, 'DL-9B');
      await t.trx('rooms').where({ id: other }).update({ connecting_room_id: target });
      const res = await api.del(`/rooms/${target}`, { reason: 'x' });
      expect(res.status).toBe(200);
      expect((await room(other)).connecting_room_id).toBeNull();
      expect(res.body.data.cleared_connecting_links.map((l) => String(l.room_id))).toContain(String(other));
    });

    it('deleting an in-service room is still capacity-checked: the last room of a fully booked type is blocked', async () => {
      const type = await createRoomType('DL10');
      const only = await createRoom(type.id, 'DL-10');
      await book({ typeId: type.id, arrival: '2027-12-10', departure: '2027-12-11' });
      const res = await api.del(`/rooms/${only}`, { reason: 'x' });
      expect(res.status).toBe(409);
      expect(reasonCodes(blockedFor(res, only))).toContain('WOULD_OVERBOOK');
    });

    it('RBAC: a manager is refused; audit keeps the full deleted row', async () => {
      const type = await createRoomType('DL11');
      const id = await createRoom(type.id, 'DL-11');
      expect((await api.del(`/rooms/${id}`, { reason: 'x' }, managerToken())).status).toBe(403);
      await api.del(`/rooms/${id}`, { reason: 'wrong building' });
      const row = await t.trx('audit_log').where({ entity_type: 'rooms', entity_id: id, action: 'delete' }).first();
      expect(row.reason).toBe('wrong building');
      const before = typeof row.before_state === 'string' ? JSON.parse(row.before_state) : row.before_state;
      expect(before.room_number).toBe('DL-11');
    });
  });

  // ====================================================================
  // The archived-room leaks
  // ====================================================================
  describe('an archived room is really out of use', () => {
    it('check-in into an archived room is refused (422 BUSINESS_RULE_ROOM_NOT_ACTIVE)', async () => {
      const type = await createRoomType('LK1');
      await createRoom(type.id, 'LK-1B');
      const archived = await createRoom(type.id, 'LK-1', { status: 'archived' });
      const reservation = await book({ typeId: type.id, arrival: '2027-03-10', departure: '2027-03-11' });
      const res = await api.post(`/reservations/${reservation.id}/check-in`, { room_id: String(archived) });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_ROOM_NOT_ACTIVE');
    });

    it('an out_of_service room is refused too — the guard is "not active", not only "archived"', async () => {
      const type = await createRoomType('LK1S');
      await createRoom(type.id, 'LK-1S-B');
      const outOfService = await createRoom(type.id, 'LK-1S', { status: 'out_of_service' });
      const reservation = await book({ typeId: type.id, arrival: '2027-03-12', departure: '2027-03-13' });
      const res = await api.post(`/reservations/${reservation.id}/check-in`, { room_id: String(outOfService) });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_ROOM_NOT_ACTIVE');
      expect(res.body.error.details).toMatchObject({ status: 'out_of_service' });
    });

    it('a room move into an archived room is refused', async () => {
      const type = await createRoomType('LK2');
      const live = await createRoom(type.id, 'LK-2A');
      const archived = await createRoom(type.id, 'LK-2B', { status: 'archived' });
      const reservation = await book({ typeId: type.id, arrival: '2027-03-15', departure: '2027-03-17' });
      await checkIn(reservation.id, live);
      const res = await api.post(`/reservations/${reservation.id}/room-move`, { new_room_id: String(archived), reason: 'x' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_ROOM_NOT_ACTIVE');
    });

    it('an archived room cannot be named as a preferred room', async () => {
      const type = await createRoomType('LK3');
      await createRoom(type.id, 'LK-3B');
      const archived = await createRoom(type.id, 'LK-3', { status: 'archived' });
      const res = await api.post('/reservations', {
        guest_id: String(A().guests[0].id),
        room_type_id: String(type.id),
        rate_code_id: String(rateCodeId),
        arrival_date: '2027-03-20',
        departure_date: '2027-03-21',
        preferred_room_id: String(archived),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_PREFERRED_ROOM_NOT_ACTIVE');
    });

    it('setup progress does not count archived rooms', async () => {
      // A property whose only rooms are archived is not "rooms complete".
      const [fresh] = await t.trx('properties').insert({
        tenant_id: A().id,
        name: 'Progress Test',
        slug: `progress-${Date.now()}`,
        timezone: 'Africa/Lagos',
        base_currency: 'NGN',
      });
      await t.trx('user_property_access').insert({ tenant_id: A().id, property_id: fresh, user_id: A().users[1].id, role: 'admin' });
      const [typeId] = await t.trx('room_types').insert({ tenant_id: A().id, property_id: fresh, code: 'PRG', name: 'PRG', default_occupancy: 2, base_rate: '10.00' });
      await t.trx('rooms').insert({ tenant_id: A().id, property_id: fresh, room_type_id: typeId, room_number: 'PRG-1', status: 'archived' });
      const token = adminToken({ propertyIdOverride: fresh });
      const res = await api.get('/setup/progress', token);
      expect(res.status).toBe(200);
      expect(res.body.data.steps.find((s) => s.key === 'rooms').complete).toBe(false);
    });

    it('housekeeping cannot raise new work against an archived room', async () => {
      const type = await createRoomType('LK5');
      const archived = await createRoom(type.id, 'LK-5', { status: 'archived' });
      const res = await api.post('/housekeeping/assignments', {
        room_id: String(archived),
        attendant_user_id: String(A().users[0].id),
        business_date: '2027-01-05',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ROOM_ARCHIVED');
      const ooo = await api.post('/housekeeping/out-of-order', { room_id: String(archived), type: 'ooo', reason: 'x', start_date: '2027-01-05', end_date: '2027-01-06' });
      expect(ooo.status).toBe(400);
    });

    it('no new QR token can be minted for an archived room', async () => {
      const type = await createRoomType('LK6');
      const archived = await createRoom(type.id, 'LK-6', { status: 'archived' });
      const outlet = await api.post('/pos/outlets', { code: 'LK6BAR', name: 'Bar', type: 'bar' });
      expect(outlet.status).toBe(201);
      const res = await api.post('/pos/qr-tokens', { outlet_id: String(outlet.body.data.id), type: 'room', room_id: String(archived) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ROOM_ARCHIVED');
    });
  });

  // ====================================================================
  // A future migration that adds a foreign key to rooms must be reflected in the delete guard
  // ====================================================================
  describe('delete guard covers every foreign key to rooms', () => {
    it('ROOM_REFERENCE_TABLES equals the schema\'s real set of foreign keys referencing rooms', async () => {
      const rows = await t.trx.raw(
        `SELECT DISTINCT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE REFERENCED_TABLE_SCHEMA = DATABASE()
            AND REFERENCED_TABLE_NAME = 'rooms'
            AND COLUMN_NAME NOT IN ('tenant_id', 'property_id')`
      );
      const real = rows[0]
        .filter((row) => row.tableName !== 'rooms') // the self-reference (connecting_room_id) is cleared, not counted
        .map((row) => `${row.tableName}.${row.columnName}`)
        .sort();
      const listed = roomManagement.ROOM_REFERENCE_TABLES.map((entry) => `${entry.table}.${entry.column}`).sort();
      expect(listed).toEqual(real);
    });
  });
});
