'use strict';

/**
 * Route wiring for tenant self-service offboarding — PLAN.md Phase 5.
 * Mounted in `src/app.js`'s `buildStaffRouter()`, but BEFORE
 * `rejectMutationForTenantLifecycle()` — deliberately, the identical
 * placement reasoning `staffImpersonationRouter()` already established for
 * "the one mutation that must survive the very read-only state it's
 * about." Every route here is meant to keep working once a tenant is
 * already `offboarding` (read status, retry a failed export, download a
 * completed one) — without this carve-out, entering the state this
 * module exists to manage would make its own screen unreachable, exactly
 * the trap `tenant-resolution.js`'s own header already flags for the
 * analogous case. Still mounted AFTER `rejectMutationDuringImpersonation()`
 * — a platform admin impersonating a tenant should never be able to
 * trigger a real offboarding request "as" that tenant; that's what
 * `platform/service.js`'s own `offboardTenant` (a real, audited platform
 * action) exists for instead.
 *
 * `offboarding.manage` is the one permission key this module needs —
 * see `20260925092000_seed_offboarding_permissions.js`'s own header for
 * why this is a single key, not a view/manage split.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function offboardingRouter() {
  const router = Router();

  router.post('/offboarding/request', requirePermission('offboarding.manage'), controller.requestOffboarding);
  router.get('/offboarding/status', requirePermission('offboarding.manage'), controller.getStatus);
  router.post('/offboarding/exports/:exportId/retry', requirePermission('offboarding.manage'), controller.retryExport);
  router.get('/offboarding/exports/:exportId/download', requirePermission('offboarding.manage'), controller.downloadExport);

  return router;
}

module.exports = { offboardingRouter };
