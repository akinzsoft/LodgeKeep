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
const { redisRateLimiter } = require('../../shared/rate-limit');

/**
 * Security-review finding (2026-09): every route in `portalPublicRouter` is
 * fully anonymous by design (no account exists yet to key a limiter on the
 * way `auth/routes.js`'s pair does), and none of them had ANY rate limit —
 * a real availability/cost-attack surface (`GET /availability` walks real
 * inventory/rate-calendar queries) and a real booking/inventory-spam
 * surface (`POST /bookings` holds real room-type inventory per PLAN.md's
 * last-room-race mechanism). Per-IP only, matching ARCHITECTURE.md §15's
 * "public/guest" tier shape (`qr-ordering`'s own precedent for the
 * identical "no account, IP is the only real dimension" situation).
 */
const availabilityIpRateLimiter = redisRateLimiter({
  windowMs: 60_000,
  limit: 60,
  prefix: 'portal-availability-ip:',
  message: 'Too many requests — please wait a moment and try again.',
});
const bookingIpRateLimiter = redisRateLimiter({
  windowMs: 60_000,
  limit: 10,
  prefix: 'portal-booking-ip:',
  message: 'Too many booking attempts from this network — please wait a moment and try again.',
});
const bookingActionIpRateLimiter = redisRateLimiter({
  windowMs: 60_000,
  limit: 20,
  prefix: 'portal-booking-action-ip:',
  message: 'Too many attempts — please wait a moment and try again.',
});

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
  router.get('/availability', ...public_, availabilityIpRateLimiter, controller.checkAvailability);
  router.post('/bookings', ...public_, bookingIpRateLimiter, controller.createAnonymousBooking);
  router.get('/bookings/:confirmationNumber', ...public_, controller.getBookingByConfirmation);
  router.post('/bookings/:confirmationNumber/start-checkout', ...public_, bookingActionIpRateLimiter, controller.retryStartCheckout);
  router.post('/bookings/:confirmationNumber/confirm', ...public_, bookingActionIpRateLimiter, controller.confirmBookingPayment);

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
