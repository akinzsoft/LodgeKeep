'use strict';

/**
 * Setup module error types — API.md §3, PLAN.md Phase 1.
 */

const { AppError, ValidationError, DuplicateEntryError } = require('../../shared/errors');

/** Re-exported for existing call sites in this module — moved to shared/errors.js in Phase 2 once the reservations module needed the same mapping (see that file's own note on why). */

/**
 * `POST /rooms/bulk`'s range descriptor did not parse — `from`/`to` were not
 * both whole numbers, or `to` came before `from`.
 */
class InvalidBulkRangeError extends ValidationError {
  constructor(message) {
    super('INVALID_BULK_RANGE', message);
  }
}

/**
 * A new tax version's `effective_from` falls inside an existing version's
 * still-open date range for the same `tax_code` — the service layer's own
 * check, since MySQL has no declarative range-exclusion constraint
 * (see the taxes migration's header).
 */
class TaxEffectiveDateOverlapError extends AppError {
  constructor(taxCode) {
    super(
      'CONFLICT_TAX_EFFECTIVE_DATE_OVERLAP',
      `A version of tax "${taxCode}" already covers this date range.`,
      409,
      { taxCode }
    );
  }
}

/**
 * A real attempt to send through a property's own configured email
 * settings failed — surfaced as its own error rather than a generic 500 so
 * `POST /setup/email-settings/test`'s caller (an admin checking whether
 * their own configuration actually works) sees the real provider error,
 * not just "something went wrong." No `PAYMENT_`/`AUTH_`/etc. namespace
 * fits an external-send failure that isn't a validation problem with the
 * REQUEST itself — modeled as `VALIDATION_` anyway, in the same spirit
 * `TaxEffectiveDateOverlapError` above already flags: the configuration,
 * once actually tried against reality, turned out not to work.
 */
class EmailTestSendFailedError extends ValidationError {
  constructor(reason) {
    super('EMAIL_TEST_SEND_FAILED', `Test email could not be sent: ${reason}`, [{ field: 'email_settings', issue: 'send_failed' }]);
  }
}

/**
 * A room-lifecycle change (change type, archive, delete — single or bulk)
 * was refused by one or more guards. ONE error class for every guard failure
 * so the UI parses a single shape: `details.blocked` is one entry per
 * blocked room, each with the machine-readable `reasons` that blocked it
 * (`OCCUPIED`, `HAS_OPEN_DISCREPANCY`, `WOULD_OVERBOOK`, `HAS_HISTORY`,
 * `ARCHIVED`, `NOT_FOUND`). A bulk change is all-or-nothing: this is thrown
 * INSTEAD of applying anything, so the caller can deselect the blocked rooms
 * and retry. An unknown or cross-tenant id is reported as `NOT_FOUND`, never
 * distinguishable from a nonexistent one.
 */
class RoomChangeBlockedError extends AppError {
  constructor(operation, blocked) {
    const count = blocked.length;
    super(
      'CONFLICT_ROOM_CHANGE_BLOCKED',
      count === 1
        ? `Nothing was changed: room ${blocked[0].room_number ?? blocked[0].room_id} is blocked.`
        : `Nothing was changed: ${count} rooms are blocked.`,
      409,
      { operation, blocked }
    );
  }
}

/** Two attempts at a room-lifecycle transaction both lost a lock race (`ER_LOCK_DEADLOCK`) — rare, safe to retry, so it is a clean 409 rather than a bare 500. */
class RoomBusyError extends AppError {
  constructor() {
    super('CONFLICT_ROOM_BUSY', 'The room is being changed by another request. Please try again.', 409);
  }
}

/** A rename or restore was attempted on a room whose state does not allow it. */
class RoomStateError extends AppError {
  constructor(code, message, details) {
    super(code, message, 409, details);
  }
}

module.exports = {
  DuplicateEntryError,
  InvalidBulkRangeError,
  TaxEffectiveDateOverlapError,
  EmailTestSendFailedError,
  RoomChangeBlockedError,
  RoomBusyError,
  RoomStateError,
};
