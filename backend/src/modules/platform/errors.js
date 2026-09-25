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
 * PLAN.md Phase 5's trial/suspend/reactivate/offboard lifecycle —
 * `suspendTenant`/`reactivateTenant`/`src/modules/offboarding/service.js`'s
 * own transition each name the only starting statuses their transition
 * accepts; a tenant found in any other status gets this real, specific
 * rejection rather than a silent no-op — `422`, matching this module's own
 * existing "well-formed request, the real-world state just doesn't
 * support it" convention. `offboarding` is reachable both ways now
 * (`reactivateTenant` was widened to accept it as a fromStatus, and the
 * offboarding module is the one place that transitions INTO it) — this
 * class stays generic rather than special-casing that status by name.
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

/**
 * The tenant's retention deadline passed and its data is being permanently
 * deleted (`tenants.status = 'purging'`) — or has been (`'purged'`). Both are
 * ONE-WAY: nothing reactivates, suspends, offboards or impersonates such a
 * tenant. A 409 rather than the generic 422 above so the console can say plainly
 * what happened instead of "invalid transition".
 */
class TenantPurgeStartedError extends AppError {
  constructor(status) {
    super(
      status === 'purged' ? 'CONFLICT_TENANT_PURGED' : 'CONFLICT_TENANT_PURGING',
      status === 'purged'
        ? "This tenant's data has been permanently deleted and it cannot be reactivated, suspended, offboarded or impersonated."
        : "This tenant's data is being permanently deleted. It can no longer be reactivated, suspended, offboarded or impersonated.",
      409,
      { status }
    );
  }
}

/** Throws `TenantPurgeStartedError` if `tenant` is purging or purged; a no-op for anything else (including a missing tenant, which callers report as not-found). */
function assertNotPurging(tenant) {
  if (tenant && (tenant.status === 'purging' || tenant.status === 'purged')) throw new TenantPurgeStartedError(tenant.status);
}

/**
 * The lifecycle actions read the tenant BEFORE their conditional UPDATE (for the
 * audit row's before-state), and that plain read fixes the transaction's REPEATABLE
 * READ snapshot — so if the purge claim commits while the UPDATE waits for the
 * row lock, `before.status` still says the old status. When an UPDATE affected
 * nothing, the caller must therefore re-read the CURRENT status with a locking read
 * (which sees the latest committed row) before deciding which error to raise.
 * `readTenant` is `() => query`, so this file stays free of any data-access import.
 */
async function assertNotPurgingFresh(readLockedTenant) {
  assertNotPurging(await readLockedTenant());
}

module.exports = { TenantNotFoundError, PropertyNotInTenantError, InvalidTenantLifecycleTransitionError, TenantPurgeStartedError, assertNotPurging, assertNotPurgingFresh, ValidationError };
