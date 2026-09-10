'use strict';

/**
 * Group Blocks service — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md §3.8.
 * Confirmed decisions this module is designed against (AskUserQuestion,
 * the same discipline AR's own pass used):
 *
 * 1. Tracking-only, never an inventory hold — a block records a negotiated
 *    `rooms_blocked` target per (room type, night) purely for reporting.
 *    Reservations tagged with `group_block_id` book through the existing,
 *    completely unmodified last-room-race mechanism
 *    (`reservations/service.js`'s `reserveInventoryForDates`). Pickup is
 *    always derived live (`pickup.js`'s `computePickupRows`), never a
 *    stored counter.
 * 2. Optional AR sponsorship — `group_blocks.company_profile_id` is
 *    nullable. When set, `billBlockReservationsToSponsor` below reuses
 *    `cashiering.billFolioToCompany` verbatim, per reservation in the
 *    block — zero new billing logic, real credit-limit enforcement via
 *    AR's existing `assertWithinCreditLimit` hook in `postCharge`/
 *    `postAdjustment`. An unsponsored block has no consolidated master
 *    bill; each reservation settles its own folio individually.
 * 3. No separate rooming-list roster table — a "rooming list entry" is
 *    just a reservation created the normal way with `group_block_id` set
 *    (`reservations/service.js`'s `createReservation`). The rooming list
 *    is a filtered view (`listReservations({ groupBlockId })`), not a
 *    resource this module owns.
 * 4. Block-scoped invoicing — `ar/service.js`'s `generateInvoice` gained
 *    an optional `groupBlockId` filter (this same pass), byte-identical
 *    default behaviour when omitted.
 *
 * ── ONE-WAY DEPENDENCY ────────────────────────────────────────────────────
 *
 * This module calls into `ar/service.js` and `cashiering/service.js`,
 * never the other way — the identical "a one-way dependency, no import
 * cycle" shape `cashiering/service.js`'s own header already documents for
 * its own call into `ar/service.js`.
 *
 * ── TWO WRITE SHAPES, DELIBERATELY DIFFERENT ─────────────────────────────
 *
 * Block CRUD and room-allocation upserts are plain, non-idempotency-wrapped
 * writes — matching `reservations/service.js`'s `configureOverbookingThreshold`
 * (a config value set to X is naturally idempotent on retry; setting it to X
 * again has no different effect), not AR's own account CRUD (which IS
 * idempotency-wrapped, because a credit limit is itself money-consequential).
 * `billBlockReservationsToSponsor` is the one function in this module whose
 * caller wraps it in `runIdempotentMutation` — it mutates several folios at
 * once and its side effects (AR credit exposure) are exactly the class of
 * action ARCHITECTURE.md §7 requires an `Idempotency-Key` for.
 */

const { scopedDb } = require('../../db');
const arService = require('../ar/service');
const cashieringService = require('../cashiering/service');
const { ArAccountNotFoundError, CompanyProfileNotFoundError } = require('../ar/errors');
const { GroupBlockNotFoundError, GroupBlockCancelledError, GroupBlockNotSponsoredError } = require('./errors');
const { computePickupRows } = require('./pickup');

// Reservation statuses that genuinely hold a room — excludes `waitlisted`
// (holds no inventory, per `reserveInventoryForDates`'s own rule),
// `cancelled`/`no_show`/`expired` (released, nothing to pick up).
const PICKED_UP_STATUSES = ['tentative', 'confirmed', 'checked_in', 'checked_out'];

// ---------------------------------------------------------------------
// Block CRUD — plain accessor, no trx, no idempotency (see file header)
// ---------------------------------------------------------------------

async function createGroupBlock({ context, blockName, companyProfileId, startDate, endDate, cutoffDate, notes }) {
  const db = scopedDb().for(context);
  if (companyProfileId != null) {
    const company = await db.table('company_profiles').where({ id: companyProfileId }).first();
    if (!company) throw new CompanyProfileNotFoundError();
  }
  const [id] = await db.table('group_blocks').insert({
    company_profile_id: companyProfileId ?? null,
    block_name: blockName,
    start_date: startDate,
    end_date: endDate,
    cutoff_date: cutoffDate ?? null,
    notes: notes ?? null,
  });
  return db.table('group_blocks').where({ id }).first();
}

/** Allowlist mirrors `pickArAccountChanges`/`pickRoomTypeChanges`. */
function pickGroupBlockChanges(body) {
  const changes = {};
  if (body?.block_name !== undefined) changes.block_name = body.block_name;
  if (body?.company_profile_id !== undefined) changes.company_profile_id = body.company_profile_id;
  if (body?.start_date !== undefined) changes.start_date = body.start_date;
  if (body?.end_date !== undefined) changes.end_date = body.end_date;
  if (body?.cutoff_date !== undefined) changes.cutoff_date = body.cutoff_date;
  if (body?.notes !== undefined) changes.notes = body.notes;
  if (body?.status !== undefined) changes.status = body.status;
  return changes;
}

async function updateGroupBlock({ context, id, changes }) {
  const db = scopedDb().for(context);
  if (Object.prototype.hasOwnProperty.call(changes, 'company_profile_id') && changes.company_profile_id != null) {
    const company = await db.table('company_profiles').where({ id: changes.company_profile_id }).first();
    if (!company) throw new CompanyProfileNotFoundError();
  }
  await db.table('group_blocks').where({ id }).update(changes);
  return db.table('group_blocks').where({ id }).first();
}

async function getGroupBlock({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('group_blocks').where({ id }).first();
}

async function listGroupBlocks({ context, status }) {
  const db = scopedDb().for(context);
  let query = db.table('group_blocks');
  if (status) query = query.where({ status });
  return query.orderBy('start_date', 'desc');
}

// ---------------------------------------------------------------------
// Room allocations — plain accessor, no locking (decision #1: this table
// never gates a booking, so there is no last-room-race concern here)
// ---------------------------------------------------------------------

/**
 * Bulk-sets one room type's target across a list of nights — one upsert per
 * night (insert, catch ER_DUP_ENTRY, update instead), the exact idiom
 * `configureOverbookingThreshold` already established for the identical
 * per-date-row shape, applied to a different resource. `stayDates` is
 * already resolved by the caller (`controller.js` — a single `stay_date`
 * becomes a one-element array; a `start_date`/`end_date` range is expanded
 * via `expandStayDates`, the same arrival-inclusive/departure-exclusive
 * semantics a reservation's own date range already uses).
 */
async function upsertGroupBlockRoomAllocation({ context, groupBlockId, roomTypeId, stayDates, roomsBlocked }) {
  const db = scopedDb().for(context);
  const block = await db.table('group_blocks').where({ id: groupBlockId }).first();
  if (!block) throw new GroupBlockNotFoundError();
  if (block.status === 'cancelled') throw new GroupBlockCancelledError();

  for (const stayDate of stayDates) {
    try {
      await db.table('group_block_rooms').insert({
        group_block_id: groupBlockId,
        room_type_id: roomTypeId,
        stay_date: stayDate,
        rooms_blocked: roomsBlocked,
      });
    } catch (error) {
      if (!(error && error.code === 'ER_DUP_ENTRY')) throw error;
      await db
        .table('group_block_rooms')
        .where({ group_block_id: groupBlockId, room_type_id: roomTypeId, stay_date: stayDate })
        .update({ rooms_blocked: roomsBlocked });
    }
  }

  return db
    .table('group_block_rooms')
    .where({ group_block_id: groupBlockId, room_type_id: roomTypeId })
    .whereIn('stay_date', stayDates)
    .orderBy('stay_date');
}

async function listGroupBlockRoomAllocations({ context, groupBlockId }) {
  const db = scopedDb().for(context);
  return db
    .table('group_block_rooms')
    .where({ group_block_id: groupBlockId })
    .joinScoped('room_types', (join) => join.on('room_types.id', '=', 'group_block_rooms.room_type_id'))
    .select(
      'group_block_rooms.*',
      'room_types.code as room_type_code',
      'room_types.name as room_type_name'
    )
    .orderBy(['group_block_rooms.room_type_id', 'group_block_rooms.stay_date']);
}

// ---------------------------------------------------------------------
// Pickup — read-only, derived (decision #1)
// ---------------------------------------------------------------------

/**
 * The module's centerpiece read. "Picked up" = a reservation tagged with
 * this block's id, in a status that genuinely holds a room, decomposed to
 * one row per night via its `reservation_daily_rates` rows (mirroring how
 * every other per-night comparison in this codebase — `reserveInventoryForDates`
 * itself included — already works against that same table).
 */
async function getBlockPickupSummary({ context, groupBlockId }) {
  const db = scopedDb().for(context);
  const block = await db.table('group_blocks').where({ id: groupBlockId }).first();
  if (!block) return null;

  const allocations = await db
    .table('group_block_rooms')
    .where({ group_block_id: groupBlockId })
    .orderBy(['room_type_id', 'stay_date']);

  const pickedUpNights = await db
    .table('reservation_daily_rates')
    .joinScoped('reservations', (join) => join.on('reservations.id', '=', 'reservation_daily_rates.reservation_id'))
    .where('reservations.group_block_id', groupBlockId)
    .whereIn('reservations.status', PICKED_UP_STATUSES)
    .select('reservations.room_type_id', 'reservation_daily_rates.stay_date');

  const { rows, totalRoomsBlocked, totalRoomsPickedUp } = computePickupRows({ allocations, pickedUpNights });

  return {
    groupBlockId: block.id,
    blockName: block.block_name,
    startDate: block.start_date,
    endDate: block.end_date,
    rows,
    totalRoomsBlocked,
    totalRoomsPickedUp,
  };
}

// ---------------------------------------------------------------------
// Group billing — the one function needing trx + idempotency (file header)
// ---------------------------------------------------------------------

/**
 * Bills every eligible open, not-yet-billed folio among the block's own
 * rooming-list reservations to the block's sponsoring company, one
 * `cashieringService.billFolioToCompany` call per folio, inside the
 * caller's transaction — atomic across the whole rooming list. Never
 * silent: every reservation not billed is reported with a reason, not
 * just dropped.
 */
async function billBlockReservationsToSponsor({ trx, groupBlockId }) {
  const block = await trx.table('group_blocks').where({ id: groupBlockId }).first();
  if (!block) throw new GroupBlockNotFoundError();
  if (block.status === 'cancelled') throw new GroupBlockCancelledError();
  if (!block.company_profile_id) throw new GroupBlockNotSponsoredError();

  // Fails fast with AR's own, already-tested message — a UX nicety, not a
  // correctness requirement (the loop below would fail identically on its
  // first billFolioToCompany call and roll back the whole transaction
  // either way), stated explicitly so this isn't read as redundant
  // defensive duplication.
  const account = await arService.getActiveAccountForCompanyAtProperty({ trx, companyProfileId: block.company_profile_id });
  if (!account) throw new ArAccountNotFoundError();

  const reservations = await trx
    .table('reservations')
    .where({ group_block_id: groupBlockId })
    .whereIn('status', PICKED_UP_STATUSES);

  const billed = [];
  const skipped = [];

  for (const reservation of reservations) {
    const folios = await trx.table('folios').where({ reservation_id: reservation.id });
    if (folios.length === 0) {
      skipped.push({ reservationId: reservation.id, folioId: null, reason: 'no_open_folio' });
      continue;
    }
    for (const folio of folios) {
      if (folio.status !== 'open') {
        skipped.push({ reservationId: reservation.id, folioId: folio.id, reason: 'folio_not_open' });
        continue;
      }
      if (folio.company_profile_id === block.company_profile_id) {
        skipped.push({ reservationId: reservation.id, folioId: folio.id, reason: 'already_billed' });
        continue;
      }
      if (folio.company_profile_id != null) {
        skipped.push({ reservationId: reservation.id, folioId: folio.id, reason: 'already_billed_elsewhere' });
        continue;
      }
      await cashieringService.billFolioToCompany({ trx, folioId: folio.id, companyProfileId: block.company_profile_id });
      billed.push(folio.id);
    }
  }

  return { groupBlockId, companyProfileId: block.company_profile_id, billed, skipped };
}

module.exports = {
  createGroupBlock,
  updateGroupBlock,
  pickGroupBlockChanges,
  getGroupBlock,
  listGroupBlocks,
  upsertGroupBlockRoomAllocation,
  listGroupBlockRoomAllocations,
  getBlockPickupSummary,
  billBlockReservationsToSponsor,
};
