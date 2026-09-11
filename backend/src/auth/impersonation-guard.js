'use strict';

/**
 * The actual read-only boundary for impersonation — PLAN.md Phase 5
 * (Platform Foundation), SECURITY.md §2. Mounted once, in `buildStaffRouter()`
 * (`src/app.js`), immediately after `authenticate('staff')` and before
 * every business router — never per-module. A mutation attempt under an
 * active impersonation grant is rejected here, structurally, regardless of
 * which of the ~15 existing modules the request would otherwise have
 * reached and regardless of what permission it would otherwise have
 * needed — the boundary does not depend on any of them remembering
 * anything.
 */

const { ImpersonationReadOnlyError } = require('./errors');

const SAFE_METHODS = new Set(['GET', 'HEAD']);

function rejectMutationDuringImpersonation() {
  return function rejectMutationDuringImpersonationMiddleware(req, res, next) {
    if (req.context?.isImpersonation && !SAFE_METHODS.has(req.method)) {
      return next(new ImpersonationReadOnlyError());
    }
    next();
  };
}

module.exports = { rejectMutationDuringImpersonation };
