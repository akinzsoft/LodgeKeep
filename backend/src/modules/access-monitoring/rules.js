'use strict';

/**
 * The door-access rules engine — PRODUCT_REQUIREMENTS.md §3.23 "Detection
 * rules", narrowed to the three confirmed for Phase 7. Classifies ONE stored
 * door event against the PMS's historical occupancy record. It never knows
 * which adapter produced the event (the §3.23 mode-agnostic requirement), so
 * a future webhook adapter or night-audit sweep calls exactly this.
 *
 * Ground truth is `reservation_rooms`: a row per (reservation, room) with
 * real UTC `effective_from`/`effective_to` instants written by check-in,
 * room move and check-out. A room is "occupied at T" iff some row covers T.
 * That is exact for any past instant — which is what a retrospective import
 * three days late needs.
 *
 * One event → at most one outcome (confirmed):
 * 1. A covering assignment exists → the stay's FIRST guest-card use gets a
 *    confirmation; every later use is ordinary guest behaviour, ignored.
 * 2. No covering assignment, and the room's most recent assignment ended in
 *    a real CHECKOUT with no later check-in yet → `post_checkout_access`
 *    (critical), unless within the property's grace window after that
 *    checkout (a guest fetching a forgotten bag), which is ignored outright.
 * 3. Otherwise → `unsold_occupancy` (critical): someone entered a room the
 *    PMS thinks is empty — no history at all, or vacated by a room move.
 *
 * Checkout vs room move is DERIVED, with no schema change to reservations:
 * `roomMove` closes the old assignment and opens a strictly later one for the
 * SAME reservation, and never checks it out; `checkOut` closes the
 * reservation's current (latest) assignment and sets status `checked_out`.
 * So an assignment ended by checkout is exactly one with no later assignment
 * for its reservation whose reservation is `checked_out`. This also holds for
 * every assignment written before this module existed — a new
 * `vacated_reason` column would have been empty for all of them.
 */

const SEVERITY = Object.freeze({ critical: 'critical', warning: 'warning', info: 'info' });
const RULES = Object.freeze({ unsoldOccupancy: 'unsold_occupancy', postCheckoutAccess: 'post_checkout_access' });

async function findCoveringAssignment(db, roomId, openedAt) {
  return db
    .table('reservation_rooms')
    .where({ room_id: roomId })
    .where('effective_from', '<=', openedAt)
    .where((q) => q.whereNull('effective_to').orWhere('effective_to', '>', openedAt))
    .orderBy('effective_from', 'desc')
    .first();
}

async function findLastClosedAssignment(db, roomId, openedAt) {
  return db
    .table('reservation_rooms')
    .where({ room_id: roomId })
    .whereNotNull('effective_to')
    .where('effective_to', '<=', openedAt)
    .orderBy('effective_to', 'desc')
    .orderBy('id', 'desc')
    .first();
}

/** See file header: ended by checkout ⇔ no later assignment for its reservation AND the reservation is checked out. */
async function describeClosure(db, assignment) {
  const reservation = await db.table('reservations').where({ id: assignment.reservation_id }).first();
  const laterAssignment = await db
    .table('reservation_rooms')
    .where({ reservation_id: assignment.reservation_id })
    .where('effective_from', '>', assignment.effective_from)
    .first('id');
  const endedByCheckout = !laterAssignment && reservation?.status === 'checked_out';
  return { reservation, endedBy: endedByCheckout ? 'checkout' : 'room_move' };
}

function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60 * 1000);
}

/**
 * `event` is a stored `door_access_events` row (room_id, card_id, opened_at,
 * is_guest_card, result). Returns one of:
 *   { outcome: 'not_evaluated', reason }            staff/master card or denied open
 *   { outcome: 'confirmation', assignment }          inside a stay (caller dedupes per reservation)
 *   { outcome: 'ignored_within_grace', closure }     just after a checkout
 *   { outcome: 'alert', rule, severity, reservationId, lastClosedAssignmentId, closure }
 */
async function classifyEvent(db, event, { graceMinutes }) {
  if (!event.is_guest_card) return { outcome: 'not_evaluated', reason: 'non_guest_card' };
  if (event.result === 'denied') return { outcome: 'not_evaluated', reason: 'denied' };

  const openedAt = new Date(event.opened_at);

  const covering = await findCoveringAssignment(db, event.room_id, openedAt);
  if (covering) return { outcome: 'confirmation', assignment: covering };

  const lastClosed = await findLastClosedAssignment(db, event.room_id, openedAt);
  if (lastClosed) {
    const closure = { assignment: lastClosed, ...(await describeClosure(db, lastClosed)) };
    if (closure.endedBy === 'checkout') {
      // Inclusive: an open exactly at checkout + grace is still "within grace".
      if (openedAt <= addMinutes(lastClosed.effective_to, graceMinutes)) {
        return { outcome: 'ignored_within_grace', closure };
      }
      return {
        outcome: 'alert',
        rule: RULES.postCheckoutAccess,
        severity: SEVERITY.critical,
        reservationId: lastClosed.reservation_id,
        lastClosedAssignmentId: lastClosed.id,
        closure,
      };
    }
    return {
      outcome: 'alert',
      rule: RULES.unsoldOccupancy,
      severity: SEVERITY.critical,
      reservationId: null,
      lastClosedAssignmentId: lastClosed.id,
      closure,
    };
  }

  return {
    outcome: 'alert',
    rule: RULES.unsoldOccupancy,
    severity: SEVERITY.critical,
    reservationId: null,
    lastClosedAssignmentId: null,
    closure: null,
  };
}

module.exports = { classifyEvent, findCoveringAssignment, findLastClosedAssignment, describeClosure, RULES, SEVERITY };
