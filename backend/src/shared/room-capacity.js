'use strict';

/**
 * Capacity arithmetic for changing which physical rooms count toward a room
 * type — shared infrastructure, sitting next to `room-availability.js`, so
 * "does a room count toward a type's sellable capacity on a date" is defined
 * in one place (`roomCountsTowardCapacity`, whose parity with
 * `livePhysicalCount` is pinned by a test) rather than reimplemented in
 * whichever module needs to ask the question next.
 *
 * Why this exists (room-management gap closure): reservations book a room
 * TYPE, and `room_type_inventory.rooms_sold` counts bookings against that
 * type. Physical capacity is computed LIVE from the rooms currently
 * belonging to the type. Moving a room out of a type, archiving it or
 * deleting it therefore silently lowers that type's capacity — and nothing
 * revalidates the bookings already accepted. `reserveInventoryForDates`
 * only ever guards a NEW booking. `findCapacityViolations` answers the
 * question that guard cannot: "if these rooms stop counting toward their
 * type, does any night that already has bookings stop fitting?"
 */

/**
 * The same predicate `livePhysicalCount` expresses in SQL: an `active` room
 * with no open discrepancy, not covered by an out-of-order period on the
 * date. `oooPeriods` is the room's own periods (`{start_date, end_date}`,
 * 'YYYY-MM-DD' strings — `dateStrings: ['DATE']` in knexfile).
 */
function roomCountsTowardCapacity(room, stayDate, oooPeriods = []) {
  if (room.status !== 'active') return false;
  if (Boolean(room.has_discrepancy)) return false;
  return !oooPeriods.some((period) => period.start_date <= stayDate && period.end_date >= stayDate);
}

/**
 * Locks every `room_type_inventory` row of the given types on or after
 * `fromDate` (`FOR UPDATE`), in `(room_type_id, stay_date)` ascending order —
 * the order of the table's `(property_id, room_type_id, stay_date)` unique
 * index, so the scan order equals the lock order. The lock is what makes the
 * check race-proof: `reserveInventoryForDates` takes the same row lock before
 * it increments `rooms_sold`, so a booking and a capacity change serialize
 * here, and whichever goes second sees the other's committed result. The
 * range scan also gap-locks nights that have no row yet, so a racing
 * insert-if-missing waits too.
 *
 * `fromDate` is null when the property has no business date yet — no lower
 * bound then, the safe direction (more nights checked, never fewer).
 */
async function lockInventoryRowsForTypes({ trx, roomTypeIds, fromDate }) {
  const ids = [...new Set(roomTypeIds.map(String))].sort((a, b) => Number(a) - Number(b));
  if (ids.length === 0) return [];
  let query = trx.table('room_type_inventory').whereIn('room_type_id', ids);
  if (fromDate) query = query.where('stay_date', '>=', fromDate);
  return query.orderBy('room_type_id').orderBy('stay_date').forUpdate();
}

/**
 * The cumulative check. `movedRoomsByType` maps a SOURCE room type id to the
 * rooms (rows as returned by `lockRooms`) about to stop counting toward it —
 * ALL of them at once, which is what makes a bulk change cumulative: moving
 * two rooms is judged as "capacity minus two", never as two independent
 * "capacity minus one" checks that would each pass.
 *
 * A night is a violation when it has bookings that would no longer fit:
 * `rooms_sold > floor(capacityAfter * threshold_pct / 100)` — the same
 * formula `reserveInventoryForDates` applies to a new booking, read as the
 * invariant "a booking that was accepted must still fit." Two deliberate
 * exclusions:
 *   - a night on which the moved rooms contribute nothing anyway (all
 *     out of order, or already discrepant) has `capacityAfter ===
 *     capacityBefore` and is skipped, so a change is never blamed for an
 *     overbooking that already existed (e.g. an import that used
 *     `bypassThreshold`);
 *   - nights before `fromDate` (the property's business date) are ignored —
 *     the past cannot be re-sold. Tonight is included.
 *
 * Returns `Map<sourceTypeId, {violations: [{stay_date, rooms_sold,
 * capacity_after, threshold_after}], totalViolatingNights}>` containing only
 * types that have at least one violation. Reads are plain (the inventory rows
 * arrive already locked from `lockInventoryRowsForTypes`); the rooms of the
 * type that are NOT being moved, and their out-of-order periods, are read
 * plainly and are current only if the CALLER took its locks before its first
 * plain read (see `room-management.js`).
 */
async function findCapacityViolations({ trx, movedRoomsByType, inventoryRows, fromDate }) {
  const result = new Map();

  for (const [typeId, movedRooms] of movedRoomsByType) {
    if (movedRooms.length === 0) continue;
    const movedIds = new Set(movedRooms.map((room) => String(room.id)));

    // Every room currently of this type, active or not — `roomCountsTowardCapacity`
    // decides who counts. The moved rooms' own (locked, fresh) rows win over
    // the snapshot read.
    //
    // Plain reads are correct HERE, and only because of how the caller runs: it
    // takes every lock first (locking reads start no snapshot), so its snapshot
    // begins after them and these reads see committed state nobody can change
    // any more. Every room of the type is X-locked by the caller, and it
    // restarts if one appeared that it did not lock.
    const typeRooms = await trx.table('rooms').where({ room_type_id: typeId });
    const roomsById = new Map(typeRooms.map((room) => [String(room.id), room]));
    for (const moved of movedRooms) roomsById.set(String(moved.id), moved);
    const rooms = [...roomsById.values()];

    let oooQuery = trx.table('out_of_order_periods').whereIn('room_id', rooms.map((room) => room.id));
    if (fromDate) oooQuery = oooQuery.where('end_date', '>=', fromDate);
    const oooByRoom = new Map();
    for (const period of await oooQuery) {
      const key = String(period.room_id);
      if (!oooByRoom.has(key)) oooByRoom.set(key, []);
      oooByRoom.get(key).push(period);
    }

    const violations = [];
    for (const row of inventoryRows) {
      if (String(row.room_type_id) !== String(typeId)) continue;
      if (fromDate && row.stay_date < fromDate) continue;

      let current = 0;
      let after = 0;
      for (const room of rooms) {
        if (!roomCountsTowardCapacity(room, row.stay_date, oooByRoom.get(String(room.id)))) continue;
        current += 1;
        if (!movedIds.has(String(room.id))) after += 1;
      }
      if (current === after) continue;

      const threshold = Math.floor((after * Number(row.overbooking_threshold_pct)) / 100);
      if (row.rooms_sold > threshold) {
        violations.push({
          stay_date: row.stay_date,
          rooms_sold: row.rooms_sold,
          capacity_after: after,
          threshold_after: threshold,
        });
      }
    }

    if (violations.length > 0) {
      result.set(String(typeId), { violations, totalViolatingNights: violations.length });
    }
  }

  return result;
}

module.exports = { roomCountsTowardCapacity, lockInventoryRowsForTypes, findCapacityViolations };
