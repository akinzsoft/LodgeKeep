'use strict';

/**
 * Night Audit module error types — API.md §3, PLAN.md Phase 2.5,
 * ARCHITECTURE.md §6.
 */

const { AppError, ValidationError } = require('../../shared/errors');

/** ARCHITECTURE.md §6.1: "A COMPLETED run for a property + business date blocks any further run for that same date" (TESTING.md NA-2). */
class NightAuditAlreadyCompletedError extends AppError {
  constructor(businessDate) {
    super('CONFLICT_NIGHT_AUDIT_ALREADY_RUN', `Night audit has already completed for business date ${businessDate}.`, 409, { businessDate });
  }
}

/** ARCHITECTURE.md §5's night-audit race: "the second run sees the row exists and refuses immediately." */
class NightAuditAlreadyRunningError extends AppError {
  constructor(businessDate) {
    super('CONFLICT_NIGHT_AUDIT_ALREADY_RUNNING', `Night audit is already running for business date ${businessDate}.`, 409, { businessDate });
  }
}

/** ARCHITECTURE.md §6.2 step 3: unresolved blocking conditions before the critical transaction opens. */
class NightAuditBlockingConditionsError extends AppError {
  constructor(conditions) {
    super(
      'BUSINESS_RULE_NIGHT_AUDIT_BLOCKED',
      `Night audit cannot start: ${conditions.length} blocking condition(s) must be resolved first.`,
      422,
      { conditions }
    );
  }
}

/**
 * ARCHITECTURE.md §6.2 step 1: "Validate the property." A property with no
 * `current_business_date` set yet (Phase 1's own default — "not every
 * fixture/property needs one") has no date to audit at all — caught here,
 * cleanly, rather than letting a NULL reach `night_audit_runs.business_date`
 * (NOT NULL) and surface as a raw database constraint error.
 */
class PropertyNotOpenedError extends ValidationError {
  constructor() {
    super('PROPERTY_NOT_OPENED', 'This property has no current business date configured yet — set one before running night audit.');
  }
}

/**
 * Gap closure, user-reported: running night audit while the property's own
 * business date is still real "today" would advance it to a calendar date
 * that, in the property's own local time, hasn't begun yet — every
 * arrival/departure filter that keys off `current_business_date` would then
 * be answering for a day that doesn't exist yet in real life. Night audit
 * for business date D is only allowed once D has genuinely finished — i.e.
 * once the property's own local "today" has moved past D.
 */
class NightAuditPrematureError extends AppError {
  constructor({ businessDate, nextBusinessDate, todayInPropertyTimezone, propertyTimezone }) {
    super(
      'BUSINESS_RULE_NIGHT_AUDIT_PREMATURE',
      `Night audit for ${businessDate} cannot run yet — it would advance the business date to ${nextBusinessDate}, but it is still ${todayInPropertyTimezone} in this property's own local time (${propertyTimezone}). Wait until that calendar day has actually begun.`,
      422,
      { businessDate, nextBusinessDate, todayInPropertyTimezone, propertyTimezone }
    );
  }
}

module.exports = {
  NightAuditAlreadyCompletedError,
  NightAuditAlreadyRunningError,
  NightAuditBlockingConditionsError,
  PropertyNotOpenedError,
  NightAuditPrematureError,
};
