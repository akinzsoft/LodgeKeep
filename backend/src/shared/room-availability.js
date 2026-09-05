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
 */

/**
 * @param {object} params
 * @param {object} params.db  A scoped accessor (read-only; no lock is taken here).
 * @param {string|number} [params.roomTypeId]
 * @param {string} params.stayDate  'YYYY-MM-DD'.
 */
async function livePhysicalCount({ db, roomTypeId, stayDate }) {
  const outOfOrderRoomIds = (
    await db
      .table('out_of_order_periods')
      .where('start_date', '<=', stayDate)
      .where('end_date', '>=', stayDate)
      .select('room_id')
  ).map((row) => row.room_id);

  let query = db.table('rooms').where({ status: 'active', has_discrepancy: false });
  if (roomTypeId) query = query.where({ room_type_id: roomTypeId });
  if (outOfOrderRoomIds.length > 0) query = query.whereNotIn('id', outOfOrderRoomIds);
  return query.count();
}

module.exports = { livePhysicalCount };
