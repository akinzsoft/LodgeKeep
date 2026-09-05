'use strict';

/**
 * Housekeeping service — PLAN.md Phase 3, PRODUCT_REQUIREMENTS.md §3.6.
 * Scope, deliberately narrower than §3.6's full eventual list (room
 * inspections, maintenance requests, lost & found, linen/minibar): exactly
 * PLAN.md Phase 3's own bullet — "attendant assignments, mobile status
 * board, discrepancy detection and report" — plus the out-of-order
 * mechanism its own test gate names ("out-of-order room is excluded from
 * sellable inventory"). The rest is real §3.6 scope for a later pass, not
 * silently dropped — see this module's own `index.js` header.
 *
 * No `withIdempotency` wrapping here, unlike the reservations module:
 * ARCHITECTURE.md §7's idempotency requirement is scoped to financial
 * mutations and reservation state transitions, neither of which any action
 * in this module is — an assignment, a status report, or a discrepancy
 * resolution retried with an identical payload has no different effect the
 * way a double-POST of a payment would.
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { AssignmentAlreadyExistsError, InvalidAssignmentTransitionError, DiscrepancyAlreadyResolvedError } = require('./errors');

const ASSIGNMENT_TRANSITIONS = {
  assigned: new Set(['in_progress', 'completed']),
  in_progress: new Set(['completed']),
  completed: new Set(),
};

function isValidAssignmentTransition(from, to) {
  return Boolean(ASSIGNMENT_TRANSITIONS[from]?.has(to));
}

// ---------------------------------------------------------------------
// Attendant assignments & the status board
// ---------------------------------------------------------------------

async function requireRoom(db, roomId) {
  const room = await db.table('rooms').where({ id: roomId }).first();
  if (!room) throw new ValidationError('ROOM_NOT_FOUND', 'The specified room does not exist at this property.');
  return room;
}

async function requireUser(db, userId) {
  const user = await db.table('users').where({ id: userId }).first();
  if (!user) throw new ValidationError('USER_NOT_FOUND', 'The specified attendant does not exist.');
  return user;
}

async function createAssignment({ context, roomId, attendantUserId, businessDate }) {
  const db = scopedDb().for(context);
  await requireRoom(db, roomId);
  await requireUser(db, attendantUserId);

  try {
    const [id] = await db.table('housekeeping_assignments').insert({
      room_id: roomId,
      attendant_user_id: attendantUserId,
      business_date: businessDate,
      status: 'assigned',
    });
    return db.table('housekeeping_assignments').where({ id }).first();
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') throw new AssignmentAlreadyExistsError(roomId, businessDate);
    throw error;
  }
}

/** Reassigning the attendant is always allowed regardless of status; a status change is validated against the transition graph above. */
async function updateAssignment({ context, id, attendantUserId, status }) {
  const db = scopedDb().for(context);
  const assignment = await db.table('housekeeping_assignments').where({ id }).first();
  if (!assignment) return null;

  const changes = {};
  if (attendantUserId) {
    await requireUser(db, attendantUserId);
    changes.attendant_user_id = attendantUserId;
  }
  if (status) {
    if (!isValidAssignmentTransition(assignment.status, status)) {
      throw new InvalidAssignmentTransitionError(assignment.status, status);
    }
    changes.status = status;
    if (status === 'in_progress') changes.started_at = new Date();
    if (status === 'completed') changes.completed_at = new Date();
  }

  if (Object.keys(changes).length > 0) {
    await db.table('housekeeping_assignments').where({ id }).update(changes);
  }
  return db.table('housekeeping_assignments').where({ id }).first();
}

async function getAssignment({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('housekeeping_assignments').where({ id }).first();
}

/**
 * The mobile status board (PRODUCT_REQUIREMENTS.md §3.6: "rooms grouped by
 * attendant assignment") — one row per assignment for a business date, with
 * enough room detail (`room_number`, `floor`) to render without a second
 * fetch. `businessDate` defaults to the property's own current business
 * date (ARCHITECTURE.md §6), never wall-clock, matching every other
 * business-date-filtered board in this codebase (`listArrivals`/
 * `listDepartures`).
 */
async function listBoard({ context, businessDate }) {
  const db = scopedDb().for(context);
  const effectiveDate = businessDate ?? (await db.table('properties').where({ id: context.propertyId }).first())?.current_business_date;

  const assignments = await db
    .table('housekeeping_assignments')
    .where({ business_date: effectiveDate })
    .orderBy('attendant_user_id');
  if (assignments.length === 0) return [];

  const roomIds = [...new Set(assignments.map((a) => a.room_id))];
  const rooms = await db.table('rooms').whereIn('id', roomIds);
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  return assignments.map((a) => ({
    ...a,
    room_number: roomById.get(a.room_id)?.room_number ?? null,
    floor: roomById.get(a.room_id)?.floor ?? null,
    housekeeping_reported_status: roomById.get(a.room_id)?.housekeeping_reported_status ?? null,
    has_discrepancy: roomById.get(a.room_id)?.has_discrepancy ?? false,
  }));
}

// ---------------------------------------------------------------------
// Housekeeping status reports & discrepancy detection
// (PRODUCT_REQUIREMENTS.md §3.6's own discrepancy requirement)
// ---------------------------------------------------------------------

/**
 * The housekeeper reports both dimensions at once — cleanliness (Phase 1's
 * existing `housekeeping_reported_status`) and their own physical occupancy
 * observation (Phase 3's new `housekeeping_occupancy_observed`). The two are
 * written unconditionally; a discrepancy is raised ONLY when the occupancy
 * observation disagrees with `front_desk_status` AND no discrepancy is
 * already open for this room — "not silently overwritten either way"
 * (PLAN.md Phase 3's own test gate) means an existing open discrepancy is
 * left exactly as it is rather than replaced by a second one, and a
 * matching observation does NOT auto-resolve it either; only an explicit
 * `resolveDiscrepancy` call does.
 */
async function reportRoomStatus({ context, roomId, cleanliness, occupancyObserved, userId }) {
  const db = scopedDb().for(context);
  const room = await requireRoom(db, roomId);

  await db.table('rooms').where({ id: roomId }).update({
    housekeeping_reported_status: cleanliness,
    housekeeping_occupancy_observed: occupancyObserved,
  });

  const disagrees = occupancyObserved !== room.front_desk_status;
  if (disagrees && !room.has_discrepancy) {
    const property = await db.table('properties').where({ id: context.propertyId }).first();
    const businessDate = property?.current_business_date;
    if (!businessDate) {
      throw new ValidationError(
        'PROPERTY_NOT_OPENED',
        'This property has no current business date yet — open it (Setup) before reporting a housekeeping status.'
      );
    }

    const [discrepancyId] = await db.table('housekeeping_discrepancies').insert({
      room_id: roomId,
      business_date: businessDate,
      front_desk_status: room.front_desk_status,
      housekeeping_status: occupancyObserved,
    });
    await db.table('rooms').where({ id: roomId }).update({ has_discrepancy: true });

    // The in-app bell (PRODUCT_REQUIREMENTS.md §3.21: "housekeeping
    // discrepancy raised" is explicitly named as a bell event) — written
    // directly, not through the outbox, per that table's own header (an
    // internal DB row, not an external side effect). Every user who holds
    // ANY role at this property is notified; a finer per-permission filter
    // (front desk/manager only) is a real refinement left for a later pass
    // rather than invented here without a spec citation for the exact cut.
    const staffAtProperty = await db.table('user_property_access').select('user_id');
    const uniqueUserIds = [...new Set(staffAtProperty.map((row) => row.user_id))];
    if (uniqueUserIds.length > 0) {
      await db.table('in_app_notifications').insert(
        uniqueUserIds.map((uid) => ({
          user_id: uid,
          type: 'housekeeping.discrepancy_raised',
          payload: JSON.stringify({ roomId, roomNumber: room.room_number, discrepancyId }),
        }))
      );
    }

    return { room: await db.table('rooms').where({ id: roomId }).first(), discrepancyRaised: true, reportedByUserId: userId };
  }

  return { room: await db.table('rooms').where({ id: roomId }).first(), discrepancyRaised: false, reportedByUserId: userId };
}

/** The dedicated discrepancy report (PRODUCT_REQUIREMENTS.md §3.6's own "first-class screen, not buried in a report dropdown"). `resolved` filters open vs resolved; omitted returns both. */
async function listDiscrepancies({ context, resolved }) {
  const db = scopedDb().for(context);
  let query = db.table('housekeeping_discrepancies');
  if (resolved === true) query = query.whereNotNull('resolved_at');
  if (resolved === false) query = query.whereNull('resolved_at');
  return query.orderBy('raised_at', 'desc');
}

async function getDiscrepancy({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('housekeeping_discrepancies').where({ id }).first();
}

/** Clears `rooms.has_discrepancy` too — the fast live flag `reportRoomStatus` set, kept in sync in the same request. */
async function resolveDiscrepancy({ context, id, userId, resolutionNote }) {
  const db = scopedDb().for(context);
  const discrepancy = await db.table('housekeeping_discrepancies').where({ id }).first();
  if (!discrepancy) return null;
  if (discrepancy.resolved_at) throw new DiscrepancyAlreadyResolvedError(id);

  const now = new Date();
  await db.table('housekeeping_discrepancies').where({ id }).update({
    resolved_at: now,
    resolved_by_user_id: userId,
    resolution_note: resolutionNote ?? null,
  });
  await db.table('rooms').where({ id: discrepancy.room_id }).update({ has_discrepancy: false });

  return db.table('housekeeping_discrepancies').where({ id }).first();
}

// ---------------------------------------------------------------------
// Out-of-order / out-of-service periods
// ---------------------------------------------------------------------

async function createOutOfOrderPeriod({ context, roomId, type, reason, startDate, endDate, userId }) {
  const db = scopedDb().for(context);
  await requireRoom(db, roomId);
  if (!(endDate >= startDate)) {
    throw new ValidationError('OOO_END_BEFORE_START', 'The end date must be on or after the start date.');
  }

  const [id] = await db.table('out_of_order_periods').insert({
    room_id: roomId,
    type,
    reason,
    start_date: startDate,
    end_date: endDate,
    created_by_user_id: userId,
  });
  return db.table('out_of_order_periods').where({ id }).first();
}

async function getOutOfOrderPeriod({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('out_of_order_periods').where({ id }).first();
}

/** `activeDate`, when supplied, filters to periods covering that date — the same range check `reservations` service's `livePhysicalCount` uses. */
async function listOutOfOrderPeriods({ context, activeDate }) {
  const db = scopedDb().for(context);
  let query = db.table('out_of_order_periods');
  if (activeDate) query = query.where('start_date', '<=', activeDate).where('end_date', '>=', activeDate);
  return query.orderBy('start_date');
}

/** Closes a period early by moving its end_date up — never delete (this table's own migration header: no history requirement here, but a still-referenced period a report may have already read from should not disappear outright). */
async function closeOutOfOrderPeriod({ context, id, endDate }) {
  const db = scopedDb().for(context);
  const period = await db.table('out_of_order_periods').where({ id }).first();
  if (!period) return null;
  await db.table('out_of_order_periods').where({ id }).update({ end_date: endDate });
  return db.table('out_of_order_periods').where({ id }).first();
}

module.exports = {
  isValidAssignmentTransition,
  createAssignment,
  updateAssignment,
  getAssignment,
  listBoard,
  reportRoomStatus,
  listDiscrepancies,
  getDiscrepancy,
  resolveDiscrepancy,
  createOutOfOrderPeriod,
  getOutOfOrderPeriod,
  listOutOfOrderPeriods,
  closeOutOfOrderPeriod,
};
