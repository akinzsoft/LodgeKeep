'use strict';

/**
 * Setup module — managing physical rooms AFTER creation (gap closure):
 * rename, change room type, archive, restore, and delete — single and bulk.
 *
 * Why this is its own file, not more of `setup/service.js`: changing a
 * room's type or retiring it has to talk to the reservations module (it
 * clears preferences on open reservations, and shares its room-lock and
 * occupancy helpers with check-in), and `reservations/service.js` already
 * requires `setup/service.js` (for `resolveRate`). Nothing in that chain
 * requires THIS file, so it may require `reservations/service` without a
 * cycle — `jobs/data-import.js` already imports the same helpers.
 *
 * What a room is, for these guards (see `shared/room-capacity.js`): a
 * reservation books a room TYPE (`room_type_inventory.rooms_sold`, counted
 * against the type's LIVE physical capacity); a physical room is tied to a
 * stay only at check-in. So "a room with future reservations" really means
 * (a) open reservations that named it as their PREFERRED room — cleared and
 * reported, never blocking — and (b) future nights of its type that would
 * stop fitting once it leaves — blocking (`WOULD_OVERBOOK`). A room a guest
 * is in right now, or with an open housekeeping discrepancy, is never moved
 * or archived.
 *
 * Every lifecycle operation is ONE transaction, and all-or-nothing:
 * a bulk change with any blocked room throws `RoomChangeBlockedError`
 * carrying every blocked room and why, and applies nothing.
 *
 * LOCK ORDER (must stay consistent with `reservations/service.js`, whose
 * cancel/extend/check-in/room-move paths this races):
 *   1. reservations that prefer these rooms (by primary key, ascending) —
 *      `cancel` holds a reservation lock and then wants inventory, so taking
 *      reservations first avoids the cycle;
 *   2. `room_type_inventory` rows of the source types (type, then stay_date
 *      ascending) — the same rows `reserveInventoryForDates` locks before it
 *      increments `rooms_sold`, so a booking and a capacity change serialize;
 *   3. the room rows, ALL in ONE ascending-id `lockRooms` pass: the rooms
 *      being changed, every other room of each source type (whose count
 *      decides capacity), and any room whose `connecting_room_id` points at
 *      one of them — the same lock check-in and room-move take, so a check-in
 *      cannot slip in behind an archive. One monotonic sequence matters: a
 *      front-desk room move locks its two rooms ascending, so reaching back
 *      for a lower-id room later could cycle with it. The cost is that a
 *      change briefly X-locks the whole source type (check-ins into it wait).
 *
 * WHY THE TRANSACTION STARTS WITH NOTHING BUT LOCKING READS: a REPEATABLE READ
 * transaction's snapshot begins at its first PLAIN read, so any plain read
 * taken before the locks would be stale by however long they take to acquire.
 * All discovery therefore happens first, outside the transaction; the
 * transaction takes its locks (locking reads never start a snapshot), and only
 * then reads plainly — a fresh snapshot, so capacity is judged from committed
 * state that nobody can change any more, with no `FOR SHARE` scans (a locking
 * read's plan is chosen by the optimizer and, on a small or oddly-indexed table,
 * can lock every row of a tenant — including a reservation a front-desk move
 * holds while it waits for a room this transaction holds). Whatever discovery
 * found that changed in the meantime is detected under the locks and the whole
 * transaction restarts (`RetryableRoomConflict`), so the retry locks it in order.
 *
 * `jobs/data-import.js` follows the same order (inventory first, then the
 * in-house room), and so does `createReservation`'s preferred-room check.
 * Nothing in the codebase takes a room lock and THEN wants inventory; keep it
 * that way. A deadlock that still happens (a straggler room added to the type
 * mid-change) is retried once here and then answered as a clean 409.
 */

const { scopedDb } = require('../../db');
const { ValidationError, withDuplicateMapping } = require('../../shared/errors');
const { lockInventoryRowsForTypes, findCapacityViolations } = require('../../shared/room-capacity');
const reservations = require('../reservations/service');
const { RoomChangeBlockedError, RoomBusyError, RoomStateError } = require('./errors');

/**
 * Every table with a foreign key to `rooms.id` other than `rooms` itself,
 * each with the referencing column. ANY row — open or historical — makes a
 * room undeletable (folios, stays, alerts and door logs must survive), so the
 * guard counts them all. a test in `tests/setup/room-management.test.js` asserts this
 * list equals the schema's real set of FKs to `rooms` (via `information_schema`), so a future migration
 * that adds one fails CI until it is listed here.
 */
const ROOM_REFERENCE_TABLES = [
  { table: 'reservation_rooms', column: 'room_id' },
  { table: 'reservations', column: 'preferred_room_id' },
  { table: 'housekeeping_assignments', column: 'room_id' },
  { table: 'housekeeping_discrepancies', column: 'room_id' },
  { table: 'out_of_order_periods', column: 'room_id' },
  { table: 'door_access_events', column: 'room_id' },
  { table: 'door_access_stay_confirmations', column: 'room_id' },
  { table: 'access_alerts', column: 'room_id' },
  { table: 'pos_order_tokens', column: 'room_id' },
];

const MAX_ROOM_NUMBER_LENGTH = 20;

/** Marker for "the picture changed under me, run the whole transaction again" — retried like a deadlock. */
class RetryableRoomConflict extends Error {}

/**
 * How often a lifecycle transaction had to be re-run. Retries are invisible to
 * the caller by design (they end in success or a clean 409), so without this a
 * deadlock that the retry masks would go unnoticed — tests assert it stays at
 * zero for the interleavings the lock order is meant to make impossible, and
 * it is cheap to expose to monitoring later.
 */
const retryStats = { deadlocks: 0, staleSnapshots: 0 };

/**
 * MySQL aborts one side of a lock cycle with `ER_LOCK_DEADLOCK`. The
 * transaction is safe to run again (everything inside it is derived from
 * locked reads), so retry once, then give the caller a clean, retryable 409.
 */
async function withDeadlockRetry(fn, { attempts = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const retryable = error instanceof RetryableRoomConflict || (error && error.code === 'ER_LOCK_DEADLOCK');
      if (!retryable) throw error;
      if (error instanceof RetryableRoomConflict) retryStats.staleSnapshots += 1;
      else retryStats.deadlocks += 1;
      lastError = error;
    }
  }
  throw new RoomBusyError(lastError);
}

function uniqueSortedIds(roomIds) {
  return [...new Set(roomIds.map(String))].sort((a, b) => Number(a) - Number(b));
}

const noopAudit = async () => {};

// ---------------------------------------------------------------------
// Reference counting (delete guard + the Remove dialog's preflight)
// ---------------------------------------------------------------------

async function countRoomReferences({ trx, roomId }) {
  const references = {};
  for (const { table, column } of ROOM_REFERENCE_TABLES) {
    const count = await trx.table(table).where({ [column]: roomId }).count();
    if (count > 0) references[table] = count;
  }
  return references;
}

function describeReferences(references) {
  const parts = Object.entries(references).map(([table, count]) => `${count} in ${table.replace(/_/g, ' ')}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------
// The shared change / archive / delete skeleton
// ---------------------------------------------------------------------

/**
 * @param {object} params
 * @param {object} params.context
 * @param {'change_type'|'archive'|'delete'} params.operation
 * @param {Array<string|number>} params.roomIds
 * @param {string|number} [params.targetTypeId]  change_type only.
 * @param {string} [params.reason]
 * @param {Function} [params.audit]  `(entry, trx) => Promise` — `req.audit`. Runs INSIDE the transaction, so a change can never commit without its audit rows.
 */
async function runRoomLifecycle({ context, operation, roomIds, targetTypeId, reason, audit = noopAudit }) {
  const db = scopedDb().for(context);
  const ids = uniqueSortedIds(roomIds);

  return withDeadlockRetry(async () => {
    // ── DISCOVERY — deliberately OUTSIDE the transaction (autocommit reads). ──
    // Under REPEATABLE READ a transaction's snapshot begins at its FIRST plain
    // read, and everything it reads afterwards is that snapshot — so any plain
    // read taken before the locks below would be stale by however long the
    // locks take to acquire (this is the bug that oversold nights). Reading
    // here, in no transaction, means the transaction itself starts with
    // NOTHING but locking reads; its snapshot begins only after the last lock
    // is granted, so every plain read it does afterwards sees everything that
    // committed before those locks — no `FOR SHARE` scans needed. The sets
    // discovered here can go stale while the locks are awaited, so they are
    // re-derived under the locks and the whole thing restarts if they grew.
    const property = await db.table('properties').where({ id: context.propertyId }).first();
    const fromDate = property?.current_business_date ?? null;
    const preRooms = await db.table('rooms').whereIn('id', ids);
    const sourceTypeIds = [
      ...new Set(
        preRooms
          .filter((room) => room.status !== 'archived')
          .filter((room) => operation !== 'change_type' || String(room.room_type_id) !== String(targetTypeId))
          .map((room) => String(room.room_type_id))
      ),
    ];
    const preferringIds = (await reservations.findOpenReservationsPreferringRooms({ db, roomIds: ids })).map((row) => String(row.id));
    const linkerIds = (await db.table('rooms').whereIn('connecting_room_id', ids).select('id')).map((row) => String(row.id));
    const typeRoomIds =
      sourceTypeIds.length > 0 ? (await db.table('rooms').whereIn('room_type_id', sourceTypeIds).select('id')).map((row) => String(row.id)) : [];
    const roomIdsToLock = [...new Set([...ids, ...linkerIds, ...typeRoomIds])];

    return db.transaction(async (trx) => {
      // ── LOCK PHASE — locking reads only, strictly in the documented order. ──
      // 1. Reservations that prefer these rooms, by primary key (a locking
      //    read on `preferred_room_id` would take gap locks on the FK index —
      //    and, worse, can scan and lock every reservation of the tenant when
      //    the optimizer prefers another index — deadlocking against a check-in
      //    or room move that holds an unrelated reservation).
      if (preferringIds.length > 0) {
        await trx
          .table('reservations')
          .whereIn('id', [...preferringIds].sort((a, b) => Number(a) - Number(b)))
          .orderBy('id')
          .forUpdate()
          .select('id');
      }

      // 2. Inventory rows of the types that LOSE capacity, from the property's
      //    business date on. (`fromDate` was read during discovery: it only
      //    moves at night audit, and a date one day stale merely checks one
      //    extra night — the safe direction.)
      const inventoryRows = await lockInventoryRowsForTypes({ trx, roomTypeIds: sourceTypeIds, fromDate });

      // 3. ONE ascending pass over every room lock: the rooms being changed,
      //    every other room of each source type (capacity is judged from them,
      //    so nobody may change them underneath), and every room connected TO
      //    one of them (its link is cleared when the target leaves service).
      //    A single monotonic sequence matters: a front-desk room move locks
      //    its two rooms ascending, so reaching back for a lower-id room later
      //    could cycle with it.
      const locked = await reservations.lockRooms({ trx, roomIds: roomIdsToLock });

      // ── VERIFY PHASE — from here the snapshot is fresh (see DISCOVERY). ──
      // Whatever the discovery read has grown since (a reservation now
      // preferring one of these rooms, a room that joined a source type, a new
      // connecting link, a room whose type changed) was not locked in the
      // right order — start over rather than judge capacity from rows nobody
      // holds. The retry re-discovers and locks them properly.
      const freshPreferring = await reservations.findOpenReservationsPreferringRooms({ db: trx, roomIds: ids });
      const freshLinkers = await trx.table('rooms').whereIn('connecting_room_id', ids).select('id');
      const freshTypeRooms = sourceTypeIds.length > 0 ? await trx.table('rooms').whereIn('room_type_id', sourceTypeIds).select('id') : [];
      const lockedIds = new Set(roomIdsToLock);
      const preferringSet = new Set(preferringIds);
      if (
        freshPreferring.some((row) => !preferringSet.has(String(row.id))) ||
        [...freshLinkers, ...freshTypeRooms].some((row) => !lockedIds.has(String(row.id)))
      ) {
        throw new RetryableRoomConflict();
      }
      for (const id of ids) {
        const room = locked.get(id);
        if (!room || room.status === 'archived') continue;
        if (operation === 'change_type' && String(room.room_type_id) === String(targetTypeId)) continue;
        if (!sourceTypeIds.includes(String(room.room_type_id))) throw new RetryableRoomConflict();
      }

      let targetType = null;
      if (operation === 'change_type') {
        targetType = await trx.table('room_types').where({ id: targetTypeId, status: 'active' }).first();
        if (!targetType) {
          throw new ValidationError('ROOM_TYPE_NOT_FOUND', 'The target room type does not exist at this property or is archived.');
        }
      }

      // 4. Guards, per locked row.
      const blocked = new Map(); // room id -> { room_id, room_number, reasons[] }
      const block = (room, id, reason_) => {
        const key = String(id);
        if (!blocked.has(key)) blocked.set(key, { room_id: key, room_number: room?.room_number ?? null, reasons: [] });
        blocked.get(key).reasons.push(reason_);
      };
      const unchanged = [];
      const actionable = [];

      for (const id of ids) {
        const room = locked.get(id);
        if (!room) {
          block(null, id, { code: 'NOT_FOUND', message: 'This room does not exist at this property.' });
          continue;
        }
        if (room.status === 'archived' && operation !== 'delete') {
          if (operation === 'archive') unchanged.push(room);
          else block(room, id, { code: 'ARCHIVED', message: `Room ${room.room_number} is archived. Restore it first.` });
          continue;
        }
        if (operation === 'change_type' && String(room.room_type_id) === String(targetTypeId)) {
          unchanged.push(room);
          continue;
        }
        actionable.push(room);

        if (await reservations.isRoomOccupied({ trx, room })) {
          const open = await trx.table('reservation_rooms').where({ room_id: room.id, effective_to: null }).first();
          block(room, id, {
            code: 'OCCUPIED',
            message: `Room ${room.room_number} is occupied by a checked-in guest.`,
            details: open ? { reservation_id: open.reservation_id } : undefined,
          });
        }
        if (operation !== 'delete' && Boolean(room.has_discrepancy)) {
          block(room, id, {
            code: 'HAS_OPEN_DISCREPANCY',
            message: `Room ${room.room_number} has an unresolved housekeeping discrepancy — its occupancy is uncertain. Resolve it first.`,
          });
        }
      }

      // 5. Capacity, cumulative across the whole batch, computed even when
      // other rooms are already blocked so the blocked list is complete.
      const movedRoomsByType = new Map();
      for (const room of actionable) {
        if (room.status === 'archived') continue; // no capacity effect
        const key = String(room.room_type_id);
        if (!movedRoomsByType.has(key)) movedRoomsByType.set(key, []);
        movedRoomsByType.get(key).push(room);
      }
      const violationsByType = await findCapacityViolations({ trx, movedRoomsByType, inventoryRows, fromDate });
      if (violationsByType.size > 0) {
        const typeRows = await trx.table('room_types').whereIn('id', [...violationsByType.keys()]);
        const typeById = new Map(typeRows.map((row) => [String(row.id), row]));
        for (const [typeId, { violations, totalViolatingNights }] of violationsByType) {
          const type = typeById.get(typeId);
          const first = violations[0];
          const more = totalViolatingNights > 1 ? ` (and ${totalViolatingNights - 1} more night${totalViolatingNights > 2 ? 's' : ''})` : '';
          const message =
            `Would leave ${type?.name ?? 'this room type'} oversold on ${first.stay_date}: ` +
            `${first.rooms_sold} booked, ${first.threshold_after} allowed after the change${more}.`;
          for (const room of movedRoomsByType.get(typeId)) {
            block(room, room.id, {
              code: 'WOULD_OVERBOOK',
              message,
              details: {
                room_type_id: typeId,
                room_type_code: type?.code ?? null,
                violations: violations.slice(0, 5),
                total_violating_nights: totalViolatingNights,
              },
            });
          }
        }
      }

      // 6. Delete: any reference at all, open or historical.
      if (operation === 'delete') {
        for (const room of actionable) {
          const references = await countRoomReferences({ trx, roomId: room.id });
          if (Object.keys(references).length > 0) {
            block(room, room.id, {
              code: 'HAS_HISTORY',
              message: `Room ${room.room_number} has history (${describeReferences(references)}) so it cannot be deleted. Archive it instead.`,
              details: { references, suggested_action: 'archive' },
            });
          }
        }
      }

      // 7. All-or-nothing: any blocked room means nothing is applied.
      if (blocked.size > 0) {
        throw new RoomChangeBlockedError(operation, [...blocked.values()]);
      }

      // 8. Apply.
      const actionableIds = actionable.map((room) => room.id);
      const clearedConnectingLinks = [];
      const actionableIdSet = new Set(actionableIds.map(String));
      const clearLinks = async () => {
        // Outbound (the room's own link) and inbound (rooms linked TO it) —
        // a link is configuration, not history, and a retired room cannot connect.
        const linked = [...locked.values()].filter(
          (room) => room.connecting_room_id != null && (actionableIdSet.has(String(room.connecting_room_id)) || actionableIdSet.has(String(room.id)))
        );
        if (linked.length > 0) {
          await trx.table('rooms').whereIn('id', linked.map((room) => room.id)).update({ connecting_room_id: null });
          for (const room of linked) clearedConnectingLinks.push({ room_id: room.id, room_number: room.room_number });
        }
      };

      // Open reservations that named one of these rooms lose that preference (the
      // booking itself is untouched). Every one of them was locked by primary
      // key in the lock phase, and `freshPreferring` was read after the locks, so
      // this needs no further locking read.
      const clearPreferences = async () => {
        const toClear = freshPreferring.filter((row) => actionableIdSet.has(String(row.preferred_room_id)));
        await reservations.clearPreferredRoomForReservations({ trx, reservationIds: toClear.map((row) => row.id) });
        return toClear.map((row) => ({
          reservation_id: row.id,
          confirmation_number: row.confirmation_number,
          status: row.status,
          room_id: row.preferred_room_id,
        }));
      };

      let clearedPreferences = [];
      let changed = [];

      if (operation === 'change_type') {
        if (actionableIds.length > 0) {
          await trx.table('rooms').whereIn('id', actionableIds).update({ room_type_id: targetTypeId });
          clearedPreferences = await clearPreferences();
        }
        changed = actionable;
      } else if (operation === 'archive') {
        if (actionableIds.length > 0) {
          await clearLinks();
          await trx.table('rooms').whereIn('id', actionableIds).update({ status: 'archived', connecting_room_id: null });
          clearedPreferences = await clearPreferences();
        }
        changed = actionable;
      } else {
        await clearLinks();
        try {
          await trx.table('rooms').whereIn('id', actionableIds).delete();
        } catch (error) {
          if (error && (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED')) {
            throw new RoomChangeBlockedError(
              'delete',
              actionable.map((room) => ({
                room_id: String(room.id),
                room_number: room.room_number,
                reasons: [
                  {
                    code: 'HAS_HISTORY',
                    message: `Room ${room.room_number} was referenced by another record while it was being deleted. Archive it instead.`,
                    details: { suggested_action: 'archive' },
                  },
                ],
              }))
            );
          }
          throw error;
        }
        changed = actionable;
      }

      const fresh =
        operation === 'delete' ? [] : await trx.table('rooms').whereIn('id', changed.map((room) => room.id)).orderBy('room_number');

      // 9. Audit, in the same transaction.
      const batchSize = ids.length;
      for (const room of changed) {
        if (operation === 'change_type') {
          await audit(
            {
              entityType: 'rooms',
              entityId: room.id,
              action: 'change_type',
              beforeState: { room_type_id: room.room_type_id },
              afterState: {
                room_type_id: targetTypeId,
                cleared_preferred_reservation_ids: clearedPreferences.filter((row) => String(row.room_id) === String(room.id)).map((row) => row.reservation_id),
                batch_size: batchSize,
              },
              reason: reason ?? undefined,
            },
            trx
          );
        } else if (operation === 'archive') {
          await audit(
            {
              entityType: 'rooms',
              entityId: room.id,
              action: 'archive',
              beforeState: room,
              afterState: {
                status: 'archived',
                cleared_preferred_reservation_ids: clearedPreferences.filter((row) => String(row.room_id) === String(room.id)).map((row) => row.reservation_id),
                cleared_connecting_room_ids: clearedConnectingLinks.map((link) => link.room_id),
                batch_size: batchSize,
              },
              reason,
            },
            trx
          );
        } else {
          await audit(
            {
              entityType: 'rooms',
              entityId: room.id,
              action: 'delete',
              beforeState: room,
              afterState: { deleted: true, cleared_connecting_room_ids: clearedConnectingLinks.map((link) => link.room_id) },
              reason,
            },
            trx
          );
        }
      }
      for (const cleared of clearedPreferences) {
        const room = locked.get(String(cleared.room_id));
        await audit(
          {
            entityType: 'reservations',
            entityId: cleared.reservation_id,
            action: 'preferred_room_cleared',
            beforeState: { preferred_room_id: cleared.room_id },
            afterState: { preferred_room_id: null },
            reason:
              operation === 'change_type'
                ? `Room ${room?.room_number ?? cleared.room_id} moved to room type ${targetType?.code ?? targetTypeId}`
                : `Room ${room?.room_number ?? cleared.room_id} archived`,
          },
          trx
        );
      }

      return {
        changed: fresh,
        deleted: operation === 'delete' ? changed.map((room) => ({ id: room.id, room_number: room.room_number })) : [],
        unchanged: unchanged.map((room) => ({ id: room.id, room_number: room.room_number })),
        cleared_preferences: clearedPreferences.map((row) => ({
          ...row,
          room_number: locked.get(String(row.room_id))?.room_number ?? null,
        })),
        cleared_connecting_links: clearedConnectingLinks,
      };
    });
  });
}

// ---------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------

async function changeRoomsType({ context, roomIds, roomTypeId, reason, audit }) {
  return runRoomLifecycle({ context, operation: 'change_type', roomIds, targetTypeId: roomTypeId, reason, audit });
}

async function archiveRooms({ context, roomIds, reason, audit }) {
  return runRoomLifecycle({ context, operation: 'archive', roomIds, reason, audit });
}

async function deleteRoom({ context, id, reason, audit }) {
  return runRoomLifecycle({ context, operation: 'delete', roomIds: [id], reason, audit });
}

/**
 * Read-only preflight for the Remove dialog: can this room be deleted, or
 * does it have history (so the only option is to archive)? DELETE itself
 * stays the authority — this is a courtesy so the UI can say which applies
 * before the user commits to a reason.
 */
async function getRoomUsage({ context, id }) {
  const db = scopedDb().for(context);
  const room = await db.table('rooms').where({ id }).first();
  if (!room) return null;
  const references = await countRoomReferences({ trx: db, roomId: id });
  const occupied = await reservations.isRoomOccupied({ trx: db, room });
  return {
    room_id: room.id,
    room_number: room.room_number,
    status: room.status,
    occupied,
    references,
    deletable: !occupied && Object.keys(references).length === 0,
  };
}

/**
 * Rename (and floor edit). The number is what every board joins on, so a
 * rename propagates to all live displays by itself; the one stored copy is
 * `pos_orders.table_label` on guest QR room orders, refreshed here for tabs
 * that are still OPEN (settled and void tabs, audit rows, outbox payloads
 * and old bell notifications are history and keep the old number).
 *
 * Accepted tiny race: a guest QR order created in the same instant as the
 * rename can stamp the old label — cosmetic, and the next rename or the
 * order closing ends it.
 */
async function renameRoom({ context, id, changes, audit = noopAudit }) {
  const db = scopedDb().for(context);
  const next = {};
  if (changes.room_number !== undefined) {
    const roomNumber = typeof changes.room_number === 'string' ? changes.room_number.trim() : '';
    if (roomNumber.length === 0 || roomNumber.length > MAX_ROOM_NUMBER_LENGTH) {
      throw new ValidationError(
        'INVALID_ROOM_NUMBER',
        `A room number is required and may be at most ${MAX_ROOM_NUMBER_LENGTH} characters.`,
        [{ field: 'room_number', issue: 'invalid' }]
      );
    }
    next.room_number = roomNumber;
  }
  if (changes.floor !== undefined) {
    const floor = changes.floor === null ? null : String(changes.floor).trim();
    if (floor !== null && floor.length > MAX_ROOM_NUMBER_LENGTH) {
      throw new ValidationError('INVALID_FLOOR', `A floor may be at most ${MAX_ROOM_NUMBER_LENGTH} characters.`, [{ field: 'floor', issue: 'invalid' }]);
    }
    next.floor = floor === '' ? null : floor;
  }

  return db.transaction(async (trx) => {
    const before = await trx.table('rooms').where({ id }).forUpdate().first();
    if (!before) return null;
    if (before.status === 'archived') {
      throw new RoomStateError('CONFLICT_ROOM_ARCHIVED', `Room ${before.room_number} is archived. Restore it before editing.`, { roomId: id });
    }

    if (Object.keys(next).length > 0) {
      await withDuplicateMapping(
        'rooms',
        `Room "${next.room_number}" already exists at this property (numbers are not case-sensitive, and an archived room still holds its number).`,
        () => trx.table('rooms').where({ id }).update(next)
      );
    }

    let relabelled = 0;
    if (next.room_number !== undefined && next.room_number !== before.room_number) {
      const tokens = await trx.table('pos_order_tokens').where({ room_id: id, type: 'room' }).select('id');
      if (tokens.length > 0) {
        const guestOrders = await trx.table('pos_guest_orders').whereIn('token_id', tokens.map((row) => row.id)).select('pos_order_id');
        if (guestOrders.length > 0) {
          relabelled = await trx
            .table('pos_orders')
            .whereIn('id', guestOrders.map((row) => row.pos_order_id))
            .where({ status: 'open', table_label: `Room ${before.room_number}` })
            .update({ table_label: `Room ${next.room_number}` });
        }
      }
    }

    const after = await trx.table('rooms').where({ id }).first();
    await audit(
      {
        entityType: 'rooms',
        entityId: id,
        action: 'update',
        beforeState: before,
        afterState: {
          room_number: { from: before.room_number, to: after.room_number },
          floor: { from: before.floor, to: after.floor },
          updated_open_order_labels: relabelled,
        },
      },
      trx
    );
    return { room: after, updated_open_order_labels: relabelled };
  });
}

/** Brings an archived room back into service. Refused while its room type is archived (it would reappear under a type nobody can pick). */
async function restoreRoom({ context, id, audit = noopAudit }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const before = await trx.table('rooms').where({ id }).forUpdate().first();
    if (!before) return null;
    if (before.status !== 'archived') return { room: before, restored: false };

    const type = await trx.table('room_types').where({ id: before.room_type_id }).first();
    if (!type || type.status !== 'active') {
      throw new RoomStateError(
        'CONFLICT_ROOM_TYPE_ARCHIVED',
        `Room ${before.room_number}'s room type is archived. Move the room to an active type first, or restore the room type.`,
        { roomId: id, roomTypeId: before.room_type_id }
      );
    }

    await trx.table('rooms').where({ id }).update({ status: 'active' });
    const after = await trx.table('rooms').where({ id }).first();
    await audit(
      { entityType: 'rooms', entityId: id, action: 'restore', beforeState: { status: 'archived' }, afterState: { status: 'active' } },
      trx
    );
    return { room: after, restored: true };
  });
}

module.exports = {
  ROOM_REFERENCE_TABLES,
  retryStats,
  changeRoomsType,
  archiveRooms,
  deleteRoom,
  getRoomUsage,
  renameRoom,
  restoreRoom,
};
