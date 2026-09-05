'use strict';

/**
 * Housekeeping module error types — API.md §3, PLAN.md Phase 3.
 */

const { AppError } = require('../../shared/errors');

/** A room is already assigned to a different attendant for the same business date — reassignment goes through the update endpoint, not a second create. */
class AssignmentAlreadyExistsError extends AppError {
  constructor(roomId, businessDate) {
    super(
      'CONFLICT_ASSIGNMENT_ALREADY_EXISTS',
      `Room ${roomId} already has an attendant assigned for ${businessDate}.`,
      409,
      { roomId, businessDate }
    );
  }
}

/** ARCHITECTURE.md §11-style transition guard, applied to housekeeping_assignments.status. */
class InvalidAssignmentTransitionError extends AppError {
  constructor(from, to) {
    super('BUSINESS_RULE_INVALID_ASSIGNMENT_TRANSITION', `An assignment cannot move from "${from}" to "${to}".`, 422, { from, to });
  }
}

/** PRODUCT_REQUIREMENTS.md §3.6: a discrepancy already resolved cannot be resolved again — resolution is a one-time action, not idempotent-by-design like a config write. */
class DiscrepancyAlreadyResolvedError extends AppError {
  constructor(id) {
    super('BUSINESS_RULE_DISCREPANCY_ALREADY_RESOLVED', `Discrepancy ${id} was already resolved.`, 422, { id });
  }
}

module.exports = {
  AssignmentAlreadyExistsError,
  InvalidAssignmentTransitionError,
  DiscrepancyAlreadyResolvedError,
};
