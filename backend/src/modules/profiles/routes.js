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

  router.get('/guests/search', requirePermission('reservations.view'), controller.searchGuests);
  router.get('/guests/:id/stay-history', requirePermission('reservations.view'), controller.getGuestStayHistory);
  router.get('/guests/:id', requirePermission('reservations.view'), controller.getGuest);

  return router;
}

module.exports = { profilesRouter };
