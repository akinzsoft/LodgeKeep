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

/**
 * Gap closure: a `housekeeping.operate`-only caller (no `.manage`) may
 * change the STATUS of an assignment (start cleaning / mark complete) but
 * only their own — `housekeeping.manage` is the one that can act on
 * anyone's. A permission key alone can't express "only your own row"; this
 * is the ownership check, not a role check, hence its own `FORBIDDEN_`
 * code distinct from `FORBIDDEN_PERMISSION`.
 */
class AssignmentNotYoursError extends AppError {
  constructor(id) {
    super('FORBIDDEN_NOT_YOUR_ASSIGNMENT', `Assignment ${id} is not assigned to you.`, 403, { assignmentId: id });
  }
}

/**
 * Gap closure: the equivalent ownership check for `reportRoomStatus` —
 * a `housekeeping.operate`-only caller may report a room's status only
 * when a real, current assignment for that room names them as the
 * attendant; `housekeeping.manage` bypasses this (a supervisor's own
 * spot-check needs no assignment at all).
 */
class RoomNotAssignedToYouError extends AppError {
  constructor(roomId) {
    super('FORBIDDEN_ROOM_NOT_ASSIGNED_TO_YOU', `Room ${roomId} is not assigned to you today.`, 403, { roomId });
  }
}

module.exports = {
  AssignmentAlreadyExistsError,
  InvalidAssignmentTransitionError,
  DiscrepancyAlreadyResolvedError,
  AssignmentNotYoursError,
  RoomNotAssignedToYouError,
};
