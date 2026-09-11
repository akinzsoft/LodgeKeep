'use strict';

/**
 * Route wiring for the platform console — PLAN.md Phase 5 (Platform
 * Foundation). Two separate routers, mounted on two different trees:
 *
 *   platformConsoleRouter()     /api/v1/platform/* — authenticate('platform')
 *   staffImpersonationRouter()  /api/v1/*          — authenticate('staff')
 *
 * `staffImpersonationRouter()` is mounted in `src/app.js`'s `buildStaffRouter()`
 * BEFORE `rejectMutationDuringImpersonation()` — deliberately: "end my own
 * impersonation grant" is the one mutating action an impersonation-derived
 * token IS allowed to take, since it is what SECURITY.md §2's own exit
 * action needs, and it is gated by the token's own identity (it can only
 * ever end the session it was minted from), not a business permission.
 * `GET /impersonation-sessions` (tenant-side visibility) sits on the same
 * router for locality but needs no such carve-out — it's a plain read,
 * reusing `setup.view` (no new permission key — this is exactly the same
 * "admin can see, nothing to configure" tier every other Setup-filed read
 * already sits at).
 *
 * PLAN.md Phase 5's platform-staff tiering (SECURITY.md §2, revisited once
 * self-service signup meant real customer data sat behind these routes):
 * `requirePlatformRole('admin')` gates exactly the actions that reach or
 * change a tenant's real state — impersonate, suspend, reactivate, and
 * (PLAN.md Phase 5 offboarding) offboard. The tenant roster and
 * impersonation-history reads stay open to both
 * tiers (`support` and `admin`) — a support account can still see account
 * info for triage without being able to act on it.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission, requirePlatformRole } = require('../../auth');

function platformConsoleRouter() {
  const router = Router();

  // No leading "/platform" here — this router is mounted under
  // `app.use('/api/v1/platform', buildPlatformRouter())` in `src/app.js`,
  // which already supplies that prefix.
  router.get('/tenants', controller.listTenants);
  router.get('/tenants/:id', controller.getTenant);
  router.get('/tenants/:id/impersonation-sessions', controller.listImpersonationSessionsForPlatform);
  router.post('/tenants/:id/impersonate', requirePlatformRole('admin'), controller.startImpersonation);
  router.post('/tenants/:id/suspend', requirePlatformRole('admin'), controller.suspendTenant);
  router.post('/tenants/:id/reactivate', requirePlatformRole('admin'), controller.reactivateTenant);
  router.post('/tenants/:id/offboard', requirePlatformRole('admin'), controller.offboardTenant);

  return router;
}

function staffImpersonationRouter() {
  const router = Router();

  router.post('/impersonation/end', controller.endImpersonation);
  router.get('/impersonation-sessions', requirePermission('setup.view'), controller.listImpersonationSessionsForTenant);

  return router;
}

module.exports = { platformConsoleRouter, staffImpersonationRouter };
