'use strict';

/**
 * Route wiring for Profiles (Guest CRM) — PLAN.md Phase 2 gap closure.
 * Mounted under `/api/v1` in `src/app.js`, after `authenticate('staff')`
 * and `attachAudit()` are already applied router-wide, alongside every
 * other business router.
 *
 * Reuses `reservations.view` rather than a new permission domain — `guests`
 * itself is still routed from `src/modules/reservations` (`GET /guests`,
 * `POST /guests`), and SECURITY.md §5's matrix has no separate Profiles row
 * to gate against yet (a real, flagged gap, not invented past here).
 *
 * `/guests/search` is registered before `/guests/:id` — Express matches
 * routes in registration order, and a request for `/guests/search` must
 * not be swallowed by `:id` capturing the literal word "search".
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function profilesRouter() {
  const router = Router();

  // Gap closure (user-reported): the active/inactive customer summary —
  // see controller.getGuestActivitySummary's own header. Static path,
  // registered before /guests/:id for the same reason /guests/search is.
  router.get('/guests/activity-summary', requirePermission('reservations.view'), controller.getGuestActivitySummary);
  router.get('/guests/search', requirePermission('reservations.view'), controller.searchGuests);
  router.get('/guests/:id/stay-history', requirePermission('reservations.view'), controller.getGuestStayHistory);
  router.get('/guests/:id', requirePermission('reservations.view'), controller.getGuest);

  // PLAN.md Phase 4 (Accounts Receivable). Reads reuse `reservations.view`,
  // matching every other Profiles read above — writes require `ar.manage`,
  // not a Profiles-only key: even though this table lives in the Profiles
  // module (DATABASE.md's own filing), its fields exist primarily to serve
  // AR risk decisions (credit terms, billing contact), so write access
  // follows AR's own permission domain. See SECURITY.md §5's AR section.
  router.get('/companies', requirePermission('reservations.view'), controller.listCompanyProfiles);
  router.post('/companies', requirePermission('ar.manage'), controller.createCompanyProfile);
  router.get('/companies/:id', requirePermission('reservations.view'), controller.getCompanyProfile);
  router.patch('/companies/:id', requirePermission('ar.manage'), controller.updateCompanyProfile);
  router.post('/companies/:id/archive', requirePermission('ar.manage'), controller.archiveCompanyProfile);

  return router;
}

module.exports = { profilesRouter };
