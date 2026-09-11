'use strict';

/**
 * Route wiring for all three identity populations (API.md §4).
 *
 * `resolveTenant` is passed in and applied per-route, only to the endpoints
 * that genuinely run before — or without needing — a verified `req.context`
 * from `authenticate()`: login, refresh, the two password-reset steps, and
 * (gap closure — see `service.js`'s own `staffLogout` header) logout. Not
 * `/switch-property`, which genuinely needs the authenticated context's
 * `userId` to look up `user_property_access`, and would otherwise fail a
 * legitimate authenticated request the instant the Host header didn't happen
 * to resolve (a stripped header behind some proxy, a client that only sends
 * `Authorization`).
 *
 * Every other route under a tree runs `authenticate(audience)` first, mounted
 * here per-route rather than router-wide, so `resolveTenant` and
 * `authenticate` are each attached to exactly the routes that need them.
 */

const { Router } = require('express');
const controller = require('./controller');
const { authenticate } = require('./middleware');

function staffAuthRouter({ resolveTenant }) {
  const router = Router();
  // Public, tenant resolved from the Host header (or the dev override).
  router.post('/login', resolveTenant, controller.staffLogin);
  router.post('/refresh', resolveTenant, controller.staffRefresh);
  router.post('/password/forgot', resolveTenant, controller.requestPasswordReset);
  router.post('/password/reset', resolveTenant, controller.completePasswordReset);
  // Public, same reasoning as the password-reset pair above — an invitee
  // holds a token, not a session, so this must run before authenticate().
  router.post('/invitations/accept', resolveTenant, controller.acceptInvitation);
  // Part of the login flow itself — a caller holds a short-lived challenge
  // token from staffLogin, not a full access token yet, so this cannot sit
  // behind authenticate('staff'), and needs no tenant resolution either (the
  // challenge token itself, once real, carries what verification needs).
  router.post('/mfa/verify', controller.verifyMfa);
  // Gap closure: public + cookie-gated, same shape as /refresh — see
  // service.js's own staffLogout header for why this moved off
  // authenticate('staff'). Revoking a session needs only the refresh
  // cookie itself, never a fresh access token.
  router.post('/logout', resolveTenant, controller.staffLogout);

  // Authenticated — tenant comes from the verified token, not the Host header.
  router.post('/switch-property', authenticate('staff'), controller.switchProperty);

  return router;
}

function portalAuthRouter({ resolveTenant }) {
  const router = Router();
  router.post('/register', resolveTenant, controller.guestRegister);
  router.post('/login', resolveTenant, controller.guestLogin);
  // Gap closure (feature-dev): guest password-reset. Public, same reasoning
  // as staff's own password-reset pair above — a guest requesting or
  // completing a reset holds no session yet.
  router.post('/password/forgot', resolveTenant, controller.requestGuestPasswordReset);
  router.post('/password/reset', resolveTenant, controller.completeGuestPasswordReset);
  return router;
}

function platformAuthRouter() {
  const router = Router();
  // No resolveTenant: platform_users belong to no tenant (SECURITY.md §2).
  router.post('/login', controller.platformLogin);
  // PLAN.md Phase 5 (Platform Foundation): platform now has its own real
  // MFA implementation (TOTP, not staff's emailed code) — genuinely
  // separate controller functions from here on, not the shared `verifyMfa`
  // this route used before either audience had real verification.
  router.post('/mfa/enroll/confirm', controller.platformMfaEnrollConfirm);
  router.post('/mfa/verify', controller.verifyPlatformMfa);
  return router;
}

module.exports = { staffAuthRouter, portalAuthRouter, platformAuthRouter };
