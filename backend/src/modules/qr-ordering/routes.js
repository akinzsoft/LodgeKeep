'use strict';

/**
 * Route wiring for QR self-ordering — PLAN.md Phase 6.
 *
 * `qrOrderPublicRouter` is mounted as its own tree in `src/app.js`
 * (`/api/v1/qr-order`), fully anonymous — no `authenticate()` of any
 * audience at all, the same "public, pre-auth" shape
 * `portalPublicRouter` already established, since a guest scanning a
 * physical QR sticker has no account and no session. `resolveTenant` and
 * `resolveQrOrderToken` are applied per-route, mirroring
 * `portalPublicRouter`'s own reasoning for why neither is router-wide.
 *
 * `qrOrderStaffRouter` is mounted inside `buildStaffRouter()`, next to
 * `posRouter()`, gated on the SAME two keys that module's own routes
 * already use — `pos.operate` (run the register: view/action the guest
 * queue) and `pos.manage` (outlet/token configuration — SECURITY.md §5's
 * "Manager overrides" cell, the same reasoning `pos/routes.js`'s own
 * header already gives for outlet/terminal/menu CRUD).
 */

const { Router } = require('express');
const controller = require('./controller');
const staffController = require('./staff-controller');
const { resolveQrOrderToken } = require('./middleware');
const { qrOrderIpRateLimiter } = require('./ip-rate-limit');
const { requirePermission } = require('../../auth');

// Code-review fix (IMPORTANT) — dedicated per-IP counters for the
// room-charge OTP flow, separate from order-creation's own
// (`qr-order-ip-rl:`) so spamming OTP requests/verifies can never ride on
// a token's still-unspent order-creation budget, and vice versa. See
// `rate-limit.js`'s own per-token counterparts for why request-otp's
// ceiling is the tighter of the two (it emails the current in-house guest
// on every call) and verify's is looser (no email; must tolerate a
// genuine two-connection concurrent-verify race,
// `tests/qr-ordering/concurrency.test.js`).
const qrOrderOtpRequestIpRateLimiter = qrOrderIpRateLimiter({ limit: 20, prefix: 'qr-otp-request-ip-rl:' });
const qrOrderOtpVerifyIpRateLimiter = qrOrderIpRateLimiter({ limit: 30, prefix: 'qr-otp-verify-ip-rl:' });

function qrOrderPublicRouter({ resolveTenant }) {
  const router = Router();
  const withToken = [resolveTenant, resolveQrOrderToken()];

  router.get('/:token/menu', ...withToken, controller.getMenu);
  // Mirrors `portalPublicRouter`'s own `/properties/branding` exactly —
  // same underlying query (`portalService.getPropertyBranding`), just
  // reached by a scanned token instead of a property slug, so the guest
  // frontend's shared branding component has one real endpoint per app,
  // never a fabricated/empty one.
  router.get('/:token/branding', ...withToken, controller.getBranding);
  router.post('/:token/orders', ...withToken, qrOrderIpRateLimiter(), controller.createOrder);
  router.get('/:token/orders/:id', ...withToken, controller.getOrderStatus);
  router.post('/:token/orders/:id/retry-checkout', ...withToken, controller.retryCheckout);
  router.post('/:token/orders/:id/confirm-payment', ...withToken, controller.confirmCardPayment);
  router.get('/:token/orders/:id/room-charge/confirm-name', ...withToken, controller.confirmName);
  router.post('/:token/orders/:id/room-charge/request-otp', ...withToken, qrOrderOtpRequestIpRateLimiter, controller.requestOtp);
  router.post('/:token/orders/:id/room-charge/verify', ...withToken, qrOrderOtpVerifyIpRateLimiter, controller.verifyOtp);

  return router;
}

function qrOrderStaffRouter() {
  const router = Router();

  router.get('/pos/qr-tokens', requirePermission('pos.manage'), staffController.listTokens);
  router.post('/pos/qr-tokens', requirePermission('pos.manage'), staffController.createToken);
  router.post('/pos/qr-tokens/:id/regenerate', requirePermission('pos.manage'), staffController.regenerateToken);
  router.post('/pos/qr-tokens/:id/deactivate', requirePermission('pos.manage'), staffController.deactivateToken);
  router.post('/pos/qr-tokens/:id/reactivate', requirePermission('pos.manage'), staffController.reactivateToken);

  router.post('/pos/outlets/:id/toggle-guest-ordering', requirePermission('pos.manage'), staffController.toggleGuestOrdering);
  router.patch('/pos/outlets/:id/guest-order-policy', requirePermission('pos.manage'), staffController.updateGuestOrderPolicy);

  router.get('/pos/guest-orders', requirePermission('pos.operate'), staffController.listGuestOrders);
  router.get('/pos/guest-orders/:id', requirePermission('pos.operate'), staffController.getGuestOrder);
  router.post('/pos/guest-orders/:id/accept', requirePermission('pos.operate'), staffController.acceptGuestOrder);
  router.post('/pos/guest-orders/:id/mark-on-the-way', requirePermission('pos.operate'), staffController.markOnTheWay);
  router.post('/pos/guest-orders/:id/reject', requirePermission('pos.operate'), staffController.rejectGuestOrder);

  return router;
}

module.exports = { qrOrderPublicRouter, qrOrderStaffRouter };
