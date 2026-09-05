'use strict';

/**
 * Route wiring for the setup module — PLAN.md Phase 1. Mounted under
 * `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()` are already applied router-wide.
 *
 * ── PROPERTIES ARE THE ONE UNGATED EXCEPTION ────────────────────────────
 *
 * Every route below except `/properties` itself is gated by
 * `requirePermission('setup.view'|'setup.manage')` — the normal SECURITY.md
 * §5 check, re-verified per request against the active property. The
 * `/properties` routes carry no such gate: creating a tenant's very first
 * property happens before any `user_property_access` grant exists to check
 * a role against, which `requirePermission` cannot express (it always
 * checks "at the active property," and there is none yet for a brand-new
 * tenant). See `service.js`'s `createProperty` for the full reasoning and
 * the flagged gap — real tenant/first-admin provisioning is Phase 5 (SaaS
 * platform) territory, not solved here.
 *
 * `/setup/progress` (PLAN.md Phase 1 gap closure, the setup wizard) carries
 * the identical exception, for the identical reason: the wizard's own first
 * step is "no property exists yet," which is exactly the case
 * `requirePermission` cannot express either.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function setupRouter() {
  const router = Router();

  router.post('/properties', controller.createProperty);
  router.get('/properties', controller.listProperties);
  router.get('/properties/:id', controller.getProperty);
  router.patch('/properties/:id', controller.updateProperty);

  router.get('/setup/progress', controller.getSetupProgress);

  router.get('/room-types', requirePermission('setup.view'), controller.listRoomTypes);
  router.post('/room-types', requirePermission('setup.manage'), controller.createRoomType);
  router.patch('/room-types/:id', requirePermission('setup.manage'), controller.updateRoomType);
  router.post('/room-types/:id/archive', requirePermission('setup.manage'), controller.archiveRoomType);

  router.get('/rooms', requirePermission('setup.view'), controller.listRooms);
  router.post('/rooms', requirePermission('setup.manage'), controller.createRoom);
  router.post('/rooms/bulk', requirePermission('setup.manage'), controller.bulkCreateRooms);
  router.patch('/rooms/:id', requirePermission('setup.manage'), controller.updateRoom);

  router.get('/rate-codes', requirePermission('setup.view'), controller.listRateCodes);
  router.post('/rate-codes', requirePermission('setup.manage'), controller.createRateCode);
  router.patch('/rate-codes/:id', requirePermission('setup.manage'), controller.updateRateCode);
  router.post('/rate-codes/:id/archive', requirePermission('setup.manage'), controller.archiveRateCode);

  router.get('/rate-calendar', requirePermission('setup.view'), controller.listRateCalendar);
  router.get('/rate-calendar/resolve', requirePermission('setup.view'), controller.resolveRate);
  router.post('/rate-calendar', requirePermission('setup.manage'), controller.setRateOverride);
  router.delete('/rate-calendar/:id', requirePermission('setup.manage'), controller.deleteRateOverride);

  router.get('/market-segments', requirePermission('setup.view'), controller.listMarketSegments);
  router.post('/market-segments', requirePermission('setup.manage'), controller.createMarketSegment);
  router.patch('/market-segments/:id', requirePermission('setup.manage'), controller.updateMarketSegment);
  router.post('/market-segments/:id/archive', requirePermission('setup.manage'), controller.archiveMarketSegment);

  router.get('/booking-sources', requirePermission('setup.view'), controller.listBookingSources);
  router.post('/booking-sources', requirePermission('setup.manage'), controller.createBookingSource);
  router.patch('/booking-sources/:id', requirePermission('setup.manage'), controller.updateBookingSource);
  router.post('/booking-sources/:id/archive', requirePermission('setup.manage'), controller.archiveBookingSource);

  router.get('/cancellation-policies', requirePermission('setup.view'), controller.listCancellationPolicies);
  router.post('/cancellation-policies', requirePermission('setup.manage'), controller.createCancellationPolicy);
  router.patch('/cancellation-policies/:id', requirePermission('setup.manage'), controller.updateCancellationPolicy);
  router.post('/cancellation-policies/:id/archive', requirePermission('setup.manage'), controller.archiveCancellationPolicy);

  router.get('/taxes', requirePermission('setup.view'), controller.listTaxes);
  router.get('/taxes/resolve', requirePermission('setup.view'), controller.resolveTax);
  router.post('/taxes', requirePermission('setup.manage'), controller.createTaxVersion);

  return router;
}

module.exports = { setupRouter };
