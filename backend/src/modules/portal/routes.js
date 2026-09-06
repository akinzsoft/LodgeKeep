'use strict';

/**
 * Route wiring for the guest booking portal — PLAN.md Phase 4. Mounted
 * under `/api/v1/portal` in `src/app.js`. Two router builders, mirroring
 * the two tiers `buildPortalRouter()` needs around `authenticate('guest')`
 * — see that function's own comment for the exact mount order.
 */

const { Router } = require('express');
const controller = require('./controller');
const { resolvePortalProperty } = require('./middleware');

/**
 * Public — reachable with no bearer token at all. `resolveTenant` is
 * applied per-route here, exactly like `staffAuthRouter`/`portalAuthRouter`
 * (`src/auth/routes.js`) already apply it only to the specific endpoints
 * that genuinely run before authentication — never router-wide, since a
 * router-wide mount would also run it in front of the authenticated tier
 * below and 404 every request whose caller has no reason to send a Host
 * header or `X-Tenant-Slug` matching a tenant at all (a bearer token
 * already carries `tenant_id`; `authenticate('guest')` resolves it from
 * there). `resolvePortalProperty` then resolves the property within that
 * tenant and builds this request's anonymous guest context — see that
 * middleware's own header.
 */
function portalPublicRouter({ resolveTenant }) {
  const router = Router();
  const withProperty = resolvePortalProperty();
  const public_ = [resolveTenant, withProperty];

  router.get('/properties/branding', ...public_, controller.getPropertyBranding);
  router.get('/room-types', ...public_, controller.listRoomTypes);
  router.get('/rate-codes', ...public_, controller.listRateCodes);
  router.get('/availability', ...public_, controller.checkAvailability);
  router.post('/bookings', ...public_, controller.createAnonymousBooking);
  router.get('/bookings/:confirmationNumber', ...public_, controller.getBookingByConfirmation);
  router.post('/bookings/:confirmationNumber/start-checkout', ...public_, controller.retryStartCheckout);
  router.post('/bookings/:confirmationNumber/confirm', ...public_, controller.confirmBookingPayment);

  return router;
}

/**
 * Authenticated — mounted after `authenticate('guest')`, which supplies a
 * real, account-bound `req.context`. No `requirePermission` anywhere here:
 * guests hold no role/permission grant at all (SECURITY.md §4's RBAC is a
 * staff-only concept) — ownership (`service.js`'s `getOwnGuestAccount`,
 * checked before every read/write below) is this tier's entire
 * authorization model, a deliberately different shape from staff RBAC.
 */
function portalAccountRouter() {
  const router = Router();

  router.post('/account/bookings', controller.createAccountBooking);
  router.get('/account/bookings', controller.listMyBookings);
  router.get('/account/bookings/:id', controller.getMyBooking);

  return router;
}

module.exports = { portalPublicRouter, portalAccountRouter };
