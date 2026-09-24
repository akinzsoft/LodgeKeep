'use strict';

/**
 * Reservations + Front Desk module error types — API.md §3, PLAN.md Phase 2.
 *
 * One module, two SECURITY.md §5 permission domains (`reservations.*` and
 * `front_desk.*`) — see `routes.js`'s own header for why this is one
 * backend module rather than two.
 */

const { AppError, ValidationError } = require('../../shared/errors');

/**
 * Booking-time availability check failed: `rooms_sold + 1` would exceed
 * `floor(physical_count * overbooking_threshold_pct / 100)` for at least
 * one night of the requested stay. ARCHITECTURE.md §5's last-room race —
 * this is the business-rule outcome of that check, not the race itself.
 */
class OverbookingThresholdExceededError extends AppError {
  constructor(roomTypeId, stayDate) {
    super(
      'BUSINESS_RULE_OVERBOOKING_THRESHOLD_EXCEEDED',
      `No sellable inventory left for this room type on ${stayDate}.`,
      422,
      { roomTypeId, stayDate }
    );
  }
}

/**
 * A specific PHYSICAL room was requested (check-in, room move) but is
 * already occupied by another live `reservation_rooms` assignment —
 * distinct from `OverbookingThresholdExceededError`: that one is a
 * booking-time inventory/threshold check against a room TYPE, this one is a
 * conflict on one concrete room at the moment of assignment (API.md §3's
 * own named `409 CONFLICT_ROOM_UNAVAILABLE` example).
 */
class RoomUnavailableError extends AppError {
  constructor(roomId) {
    super('CONFLICT_ROOM_UNAVAILABLE', `Room ${roomId} is already occupied by another reservation.`, 409, { roomId });
  }
}

/** ARCHITECTURE.md §11: a status change that the state machine does not allow (e.g. cancelling an already-checked-out reservation). */
class InvalidReservationTransitionError extends AppError {
  constructor(from, to) {
    super(
      'BUSINESS_RULE_INVALID_RESERVATION_TRANSITION',
      `A reservation cannot move from "${from}" to "${to}".`,
      422,
      { from, to }
    );
  }
}

/** API.md §3's own named canonical `VALIDATION_` example. */
class ArrivalAfterDepartureError extends ValidationError {
  constructor() {
    super('ARRIVAL_AFTER_DEPARTURE', 'The departure date must be after the arrival date.');
  }
}

/** TESTING.md FD-2: check-in to a room housekeeping has not marked clean is blocked, not merely warned — the simpler of the two documented options ("blocked or warned per configuration"), since no per-property configuration for this exists yet. */
class RoomNotCleanError extends AppError {
  constructor(roomId) {
    super('BUSINESS_RULE_ROOM_NOT_CLEAN', `Room ${roomId} is not marked clean by housekeeping.`, 422, { roomId });
  }
}

/**
 * PLAN.md Phase 3: a room currently out-of-order/out-of-service
 * (`out_of_order_periods`) or carrying an unresolved housekeeping
 * discrepancy (`rooms.has_discrepancy`) cannot be checked into —
 * PRODUCT_REQUIREMENTS.md §3.6's "requiring front-desk follow-up before the
 * room can be sold again" applies to check-in, the one action that actually
 * puts a guest in the room, not only to the room-type-level inventory count.
 */
class RoomOutOfOrderError extends AppError {
  constructor(roomId) {
    super('BUSINESS_RULE_ROOM_OUT_OF_ORDER', `Room ${roomId} is out of order or has an unresolved discrepancy.`, 422, { roomId });
  }
}

/**
 * Gap closure (room management): an archived (or otherwise non-`active`) room
 * cannot receive a guest — `checkIn` and a `roomMove` destination both
 * refuse it, with no override, for the same reason an out-of-order room
 * has none: the room was deliberately retired, and a checkbox at the
 * moment of check-in is not the place to un-retire it.
 */
class RoomNotActiveError extends AppError {
  constructor(roomId, status) {
    super('BUSINESS_RULE_ROOM_NOT_ACTIVE', `Room ${roomId} is ${status} and cannot be used.`, 422, { roomId, status });
  }
}

/**
 * ARCHITECTURE.md §11: check-out requires every folio the guest owes
 * directly to carry a zero balance. PLAN.md Phase 4 (Accounts Receivable):
 * a folio billed to a company account is exempt — see `checkOut`'s own
 * comment in `service.js` — so this error only ever fires for a folio that
 * genuinely is the guest's own responsibility. `folioId` identifies which
 * of a reservation's (possibly several, split-billed) open folios is owing.
 */
class FolioBalanceOwingError extends AppError {
  constructor(balance, folioId) {
    super('BUSINESS_RULE_FOLIO_BALANCE_OWING', `Cannot check out — folio balance of ${balance} is still owing.`, 422, { balance, folioId });
  }
}

/**
 * Gap closure: a NEW reservation's arrival date must not fall before the
 * property's own current business date (ARCHITECTURE.md §6 — the business
 * date, never the wall clock, is the accounting truth). Enforced in
 * `createReservation` itself, not the controller, so both the staff booking
 * path and the guest portal's own `createBookingWithPayment`
 * (`portal/service.js`, which calls `createReservation` directly) inherit
 * it for free — nothing can bypass it by calling this function a different
 * way. Deliberately a floor, not an exact match: an arrival dated to the
 * still-open CURRENT business date is allowed (a walk-in entered the
 * following morning before Night Audit has rolled the date forward yet is
 * not "backdating" in any meaningful sense — it is `>=`, not `>`).
 * Bulk-imported historical reservations (`src/jobs/data-import.js`'s
 * `commitReservationRow`) insert directly into `reservations` rather than
 * calling this function at all, so they are correctly unaffected by this
 * check — see that function's own header for why a historical row needs no
 * override here.
 */
class ArrivalBeforeBusinessDateError extends AppError {
  constructor(arrivalDate, businessDate) {
    super(
      'BUSINESS_RULE_ARRIVAL_BEFORE_BUSINESS_DATE',
      `Cannot book — arrival date (${arrivalDate}) is before the property's current business date (${businessDate}).`,
      422,
      { arrivalDate, businessDate }
    );
  }
}

/** A waitlisted reservation can't be promoted once its arrival date is behind the property's business date. */
class WaitlistArrivalPassedError extends AppError {
  constructor(arrivalDate, businessDate) {
    super(
      'BUSINESS_RULE_WAITLIST_ARRIVAL_PASSED',
      `Cannot promote — this reservation's arrival date (${arrivalDate}) is before the property's business date (${businessDate}). Cancel it instead.`,
      422,
      { arrivalDate, businessDate }
    );
  }
}

module.exports = {
  OverbookingThresholdExceededError,
  WaitlistArrivalPassedError,
  RoomUnavailableError,
  RoomNotCleanError,
  RoomOutOfOrderError,
  RoomNotActiveError,
  InvalidReservationTransitionError,
  ArrivalAfterDepartureError,
  ArrivalBeforeBusinessDateError,
  FolioBalanceOwingError,
};
