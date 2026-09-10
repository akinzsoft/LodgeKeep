'use strict';

/**
 * Pickup computation — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md §3.8's
 * "pickup progress bar (rooms picked up vs blocked)." Pure, no database —
 * the same "pull business logic into a directly unit-testable function"
 * discipline `ar/ageing.js`'s `computeAgeingBuckets` already established,
 * built and proven at every boundary BEFORE `service.js`'s
 * `getBlockPickupSummary` ever touches the database.
 *
 * Pickup is always derived from real, currently-booked reservations — see
 * `group_block_rooms`' own migration header for why no stored counter
 * exists to feed this instead.
 */

function rowKey(roomTypeId, stayDate) {
  return `${roomTypeId}|${stayDate}`;
}

/**
 * @param {object} params
 * @param {{room_type_id: number|string, stay_date: string, rooms_blocked: number}[]} params.allocations
 *   The block's `group_block_rooms` target rows.
 * @param {{room_type_id: number|string, stay_date: string}[]} params.pickedUpNights
 *   One row per picked-up room-night — a reservation's `reservation_daily_rates`
 *   row, already filtered by the caller to this block's id and to statuses
 *   that genuinely hold a room (see `service.js`'s own `getBlockPickupSummary`
 *   for the exact status filter and its reasoning). Counted here, not summed
 *   by the caller — the aggregation itself lives in this pure function too.
 * @returns {{rows: Array, totalRoomsBlocked: number, totalRoomsPickedUp: number}}
 *   `rows` is sorted by (room_type_id, stay_date) and unions both sides — a
 *   picked-up night with no matching allocation still appears, with
 *   `roomsBlocked: 0`, surfacing genuine over-pickup rather than hiding it
 *   (this session's confirmed decision: a block is tracking-only, never a
 *   hard availability lock).
 */
function computePickupRows({ allocations, pickedUpNights }) {
  const pickupCounts = new Map();
  for (const night of pickedUpNights) {
    const key = rowKey(night.room_type_id, night.stay_date);
    pickupCounts.set(key, (pickupCounts.get(key) ?? 0) + 1);
  }

  const rowsByKey = new Map();
  for (const allocation of allocations) {
    const key = rowKey(allocation.room_type_id, allocation.stay_date);
    rowsByKey.set(key, {
      roomTypeId: allocation.room_type_id,
      stayDate: allocation.stay_date,
      roomsBlocked: allocation.rooms_blocked,
      roomsPickedUp: pickupCounts.get(key) ?? 0,
    });
  }
  for (const [key, roomsPickedUp] of pickupCounts) {
    if (rowsByKey.has(key)) continue;
    const [roomTypeId, stayDate] = key.split('|');
    rowsByKey.set(key, { roomTypeId, stayDate, roomsBlocked: 0, roomsPickedUp });
  }

  const rows = [...rowsByKey.values()].sort((a, b) => {
    if (String(a.roomTypeId) !== String(b.roomTypeId)) return String(a.roomTypeId) < String(b.roomTypeId) ? -1 : 1;
    return a.stayDate < b.stayDate ? -1 : a.stayDate > b.stayDate ? 1 : 0;
  });

  const totalRoomsBlocked = rows.reduce((sum, row) => sum + row.roomsBlocked, 0);
  const totalRoomsPickedUp = rows.reduce((sum, row) => sum + row.roomsPickedUp, 0);

  return { rows, totalRoomsBlocked, totalRoomsPickedUp };
}

module.exports = { computePickupRows };
