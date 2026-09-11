'use strict';

/**
 * The read-only boundary for a trial-expired or suspended tenant — PLAN.md
 * Phase 5, PRODUCT_REQUIREMENTS.md §3.22. Mounted once, in `buildStaffRouter()`
 * (`src/app.js`), right after `rejectMutationDuringImpersonation()` and
 * before every business router — never per-module, the identical shape and
 * placement that guard already established for a different read-only
 * reason. A mutation attempt against a write-blocked tenant is rejected
 * here, structurally, regardless of which module or permission it would
 * otherwise have reached.
 *
 * Ordered AFTER `staffImpersonationRouter()` for the same reason the
 * impersonation guard is: `POST /impersonation/end` must stay reachable
 * regardless of the underlying tenant's lifecycle status, or a platform
 * admin viewing a suspended tenant (read-only anyway, via the OTHER guard)
 * could never exit the session.
 */

const { TenantReadOnlyError } = require('./errors');

const SAFE_METHODS = new Set(['GET', 'HEAD']);

function rejectMutationForTenantLifecycle() {
  return function rejectMutationForTenantLifecycleMiddleware(req, res, next) {
    if (req.context?.tenantWriteBlocked && !SAFE_METHODS.has(req.method)) {
      return next(new TenantReadOnlyError(req.context.tenantStatus));
    }
    next();
  };
}

module.exports = { rejectMutationForTenantLifecycle };
