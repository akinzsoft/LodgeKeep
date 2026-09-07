'use strict';

/**
 * Live physical room availability — shared between `src/modules/reservations`
 * (the last-room race, ARCHITECTURE.md §5) and `src/modules/reporting`
 * (occupancy/RevPAR, PLAN.md Phase 3), so "how many rooms actually exist to
 * sell on this date" is computed exactly once rather than drifting between
 * two reimplementations.
 *
 * `rooms.status` is the one live source of truth (no cached count — see the
 * `room_type_inventory` migration's own header for why), extended in Phase 3
 * to also exclude a room with an `out_of_order_periods` row covering the
 * date, and a room with `has_discrepancy = true`
 * (PRODUCT_REQUIREMENTS.md §3.6: "requiring front-desk follow-up before the
 * room can be sold again").
 *
 * `roomTypeId` is optional: reservations always needs one type's count for
 * the inventory lock it is about to take; the reporting module needs a
 * property-wide count across every type for an occupancy figure, so it
 * omits it.
 *
 * `listFreeRoomsNow` (gap closure, Reservations/Front Desk) answers a
 * genuinely different question from `livePhysicalCount`: not "how many
 * rooms of this type exist to sell on a date" (an aggregate, checked against
 * `room_type_inventory.rooms_sold`), but "which specific physical rooms are
 * unoccupied at this exact moment." That second question is only answerable
 * for the property's CURRENT business date — no reservation is tied to a
 * specific room until check-in (Phase 2's confirmed decision: a room is
 * assigned only at check-in, never at booking), so for any future date this
 * codebase has no data structure that knows which physical room a
 * not-yet-arrived guest will occupy. Callers must not pass a future date
 * here; `stayDate` exists only to resolve *today's* out-of-order periods,
 * the same reasoning `livePhysicalCount` already uses it for.
 */

/**
 * @param {object} params
 * @param {object} params.db  A scoped accessor (read-only; no lock is taken here).
 * @param {string} params.stayDate  'YYYY-MM-DD'. Out-of-order periods covering this date are excluded.
 */
async function outOfOrderRoomIds({ db, stayDate }) {
  if (!stayDate) return [];
  return (
    await db
      .table('out_of_order_periods')
      .where('start_date', '<=', stayDate)
      .where('end_date', '>=', stayDate)
      .select('room_id')
  ).map((row) => row.room_id);
}

/**
 * @param {object} params
 * @param {object} params.db  A scoped accessor (read-only; no lock is taken here).
 * @param {string|number} [params.roomTypeId]
 * @param {string} params.stayDate  'YYYY-MM-DD'.
 */
async function livePhysicalCount({ db, roomTypeId, stayDate }) {
  const oooRoomIds = await outOfOrderRoomIds({ db, stayDate });

  let query = db.table('rooms').where({ status: 'active', has_discrepancy: false });
  if (roomTypeId) query = query.where({ room_type_id: roomTypeId });
  if (oooRoomIds.length > 0) query = query.whereNotIn('id', oooRoomIds);
  return query.count();
}

/**
 * @param {object} params
 * @param {object} params.db  A scoped accessor (read-only; no lock is taken here).
 * @param {string|number} [params.roomTypeId]  Omitted for check-in/room-move, which
 *   (PRODUCT_REQUIREMENTS.md §3.3, `checkIn`'s own header) deliberately allow any room
 *   type — an upgrade, not a separate endpoint — so their room picker must not be
 *   filtered to the reservation's own type. Supplied for the availability search,
 *   which is always scoped to one searched type.
 * @param {string} [params.stayDate]  'YYYY-MM-DD' — the property's current business date.
 *   When absent (a property with no business date set yet), out-of-order exclusion is
 *   skipped rather than queried against a null date — the same graceful-degradation
 *   `checkIn`'s own `if (businessDate) { ... }` guard already uses elsewhere.
 */
async function listFreeRoomsNow({ db, roomTypeId, stayDate }) {
  const oooRoomIds = await outOfOrderRoomIds({ db, stayDate });
  const occupiedRoomIds = (
    await db.table('reservation_rooms').whereNull('effective_to').select('room_id')
  ).map((row) => row.room_id);

  let query = db.table('rooms').where({ status: 'active', has_discrepancy: false });
  if (roomTypeId) query = query.where({ room_type_id: roomTypeId });
  if (oooRoomIds.length > 0) query = query.whereNotIn('id', oooRoomIds);
  if (occupiedRoomIds.length > 0) query = query.whereNotIn('id', occupiedRoomIds);
  return query.select('id', 'room_number', 'floor', 'room_type_id', 'housekeeping_reported_status').orderBy('room_number');
}

module.exports = { livePhysicalCount, listFreeRoomsNow, outOfOrderRoomIds };
