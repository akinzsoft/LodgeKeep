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

module.exports = { DuplicateEntryError, InvalidBulkRangeError, TaxEffectiveDateOverlapError };
