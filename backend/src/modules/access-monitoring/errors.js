'use strict';

/**
 * Door access monitoring error types — API.md §3.
 */

const { AppError } = require('../../shared/errors');

/** An import was attempted while the property's lock adapter is still `none`. */
class LockSystemNotConfiguredError extends AppError {
  constructor() {
    super(
      'BUSINESS_RULE_LOCK_SYSTEM_NOT_CONFIGURED',
      'Choose this property\'s lock system in Door Access settings before importing a lock audit trail.',
      422
    );
  }
}

/** The multipart request carried no `file` part. */
class MissingLockFileError extends AppError {
  constructor() {
    super('VALIDATION_DOOR_ACCESS_FILE_MISSING', 'Attach the lock audit-trail file exported from the lock software.', 400);
  }
}

/** open → acknowledged → resolved only; a resolved alert is final. */
class InvalidAlertTransitionError extends AppError {
  constructor(id, from, to) {
    super('CONFLICT_ACCESS_ALERT_TRANSITION', `Alert ${id} cannot move from "${from}" to "${to}".`, 409, { id, from, to });
  }
}

module.exports = { LockSystemNotConfiguredError, MissingLockFileError, InvalidAlertTransitionError };
