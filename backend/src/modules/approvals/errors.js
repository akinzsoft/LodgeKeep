'use strict';

/**
 * Manager approval errors (API.md §3). None uses the `AUTH_` prefix: the
 * frontend client treats any `AUTH_*` error as a dead session and signs the
 * user out, which a missing or wrong PIN must never do.
 */

const { AppError } = require('../../shared/errors');

/** The action needs a manager's approval and the request carried none. */
class ManagerApprovalRequiredError extends AppError {
  constructor(action) {
    super('FORBIDDEN_MANAGER_APPROVAL_REQUIRED', 'A manager must approve this with their PIN.', 403, { action });
  }
}

/** The approval sent is unknown, already used, expired, or for another action, record or person. */
class ApprovalInvalidError extends AppError {
  constructor(action) {
    super('VALIDATION_APPROVAL_INVALID', 'That manager approval is no longer valid. Ask the manager to approve again.', 422, { action });
  }
}

class ApprovalPinIncorrectError extends AppError {
  constructor(attemptsLeft) {
    super('VALIDATION_APPROVAL_PIN_INCORRECT', 'That PIN is not correct.', 422, { attemptsLeft });
  }
}

class ApprovalPinNotSetError extends AppError {
  constructor() {
    super('BUSINESS_RULE_APPROVAL_PIN_NOT_SET', 'This manager has not set an approval PIN yet. They can set one under My Profile → Approval PIN.', 422);
  }
}

class ApprovalPinLockedError extends AppError {
  constructor(lockedUntil) {
    super('LOCKED_APPROVAL_PIN', 'Too many wrong PINs. This manager cannot approve for 15 minutes.', 423, { lockedUntil });
  }
}

/** The chosen person may not approve this action here (no such user, inactive, or no permission at this property). */
class ApproverNotEligibleError extends AppError {
  constructor(action) {
    super('FORBIDDEN_APPROVER_NOT_ELIGIBLE', 'That person cannot approve this here.', 403, { action });
  }
}

module.exports = {
  ManagerApprovalRequiredError,
  ApprovalInvalidError,
  ApprovalPinIncorrectError,
  ApprovalPinNotSetError,
  ApprovalPinLockedError,
  ApproverNotEligibleError,
};
