'use strict';

/**
 * Route wiring for all three identity populations (API.md §4).
 *
 * `resolveTenant` is passed in and applied per-route, only to the endpoints
 * that genuinely run before authentication (login, refresh, the two password-
 * reset steps) — not to `/logout` or `/switch-property`, which already carry a
 * verified `req.context` from `authenticate()` and would otherwise fail a
 * legitimate authenticated request the instant the Host header didn't happen
 * to resolve (a stripped header behind some proxy, a client that only sends
 * `Authorization`), for a tenant lookup those handlers never use.
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
  // Part of the login flow itself — a caller holds a short-lived challenge
  // token from staffLogin, not a full access token yet, so this cannot sit
  // behind authenticate('staff'), and needs no tenant resolution either (the
  // challenge token itself, once real, carries what verification needs).
  router.post('/mfa/verify', controller.verifyMfa);

  // Authenticated — tenant comes from the verified token, not the Host header.
  router.post('/logout', authenticate('staff'), controller.staffLogout);
  router.post('/switch-property', authenticate('staff'), controller.switchProperty);

  return router;
}

function portalAuthRouter({ resolveTenant }) {
  const router = Router();
  router.post('/login', resolveTenant, controller.guestLogin);
  return router;
}

function platformAuthRouter() {
  const router = Router();
  // No resolveTenant: platform_users belong to no tenant (SECURITY.md §2).
  router.post('/login', controller.platformLogin);
  router.post('/mfa/verify', controller.verifyMfa);
  return router;
}

module.exports = { staffAuthRouter, portalAuthRouter, platformAuthRouter };
