'use strict';

/**
 * Platform console module error types — API.md §3, PLAN.md Phase 5.
 * 422, not 400 — the same "a friendly existence check ahead of the real
 * constraint" convention AR's own `ArAccountNotFoundError`/
 * `CompanyProfileNotFoundError` already established: the request is
 * well-formed, the referenced tenant/property simply isn't real (or isn't
 * paired correctly).
 */

const { AppError, ValidationError } = require('../../shared/errors');

class TenantNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_TENANT_NOT_FOUND', 'The specified tenant does not exist.', 422);
  }
}

class PropertyNotInTenantError extends AppError {
  constructor() {
    super('VALIDATION_PROPERTY_NOT_IN_TENANT', 'The specified property does not belong to this tenant.', 422);
  }
}

/**
 * PLAN.md Phase 5's trial/suspend/reactivate lifecycle — `suspendTenant`/
 * `reactivateTenant` each name the only starting statuses their transition
 * accepts; a tenant found in any other status (already in the target
 * state, or `offboarding`, which this pass builds no transition into or
 * out of) gets this real, specific rejection rather than a silent no-op —
 * `422`, matching this module's own existing "well-formed request, the
 * real-world state just doesn't support it" convention.
 */
class InvalidTenantLifecycleTransitionError extends AppError {
  constructor(currentStatus, attemptedTransitionTo) {
    super(
      'VALIDATION_INVALID_TENANT_TRANSITION',
      `Cannot transition a tenant from "${currentStatus}" to "${attemptedTransitionTo}".`,
      422,
      { currentStatus, attemptedTransitionTo }
    );
  }
}

module.exports = { TenantNotFoundError, PropertyNotInTenantError, InvalidTenantLifecycleTransitionError, ValidationError };
