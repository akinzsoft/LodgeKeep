'use strict';

/**
 * Route wiring for all three identity populations (API.md §4).
 *
 * `resolveTenant` is passed in and applied per-route, only to the endpoints
 * that genuinely run before — or without needing — a verified `req.context`
 * from `authenticate()`: login, refresh, the request-a-reset-code step, and
 * (gap closure — see `service.js`'s own `staffLogout` header) logout. The
 * staff reset-completion step below does NOT use it — gap closure: since
 * that flow moved to a numeric code, `tenantId` comes from decoding the
 * `reset_token` itself, the same shape `/mfa/verify` already uses, not the
 * Host header. Not `/switch-property`, which genuinely needs the authenticated context's
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
const { redisRateLimiter, ipAndAccountRateLimiters } = require('../shared/rate-limit');
const { requireSameOrigin } = require('./same-origin-guard');

/**
 * Security-review finding (2026-09): every public route below had no
 * request-level throttling at all — `lockout.js`'s own 423 LOCKED_ACCOUNT
 * control counts only *failures* and only for login, so it never bounded
 * a scripted flood of otherwise-well-formed requests (a password-reset
 * spammed at one victim's inbox, or a login/mfa-verify loop re-triggering
 * fresh attempt budgets — see this session's own MFA gap-closure note on
 * exactly that residual risk). `ipAndAccountRateLimiters` gives every
 * login/reset-style action ARCHITECTURE.md §15's documented "auth" shape —
 * per-IP (loose, a shared front-desk terminal/NAT must not lock out) AND
 * per-account/token (tight, the thing actually being targeted) — as two
 * independent 429 counters layered in FRONT of the existing 423 tier, not
 * replacing it.
 *
 * A token-based endpoint (password/reset completion, invitation accept)
 * has no natural "account" field distinct from its own single-use token —
 * a real per-IP limiter alone is the meaningful guard there; the token's
 * own single-use/expiry is what stands in for the account dimension.
 */
const AUTH_RATE_LIMIT_MESSAGE = 'Too many attempts — please wait a moment and try again.';

const loginRateLimiters = (prefix) =>
  ipAndAccountRateLimiters({
    prefix,
    message: AUTH_RATE_LIMIT_MESSAGE,
    ipWindowMs: 60_000,
    ipLimit: 60,
    accountWindowMs: 15 * 60_000,
    accountLimit: 30,
    accountField: 'email',
  });

const passwordResetRequestRateLimiters = (prefix) =>
  ipAndAccountRateLimiters({
    prefix,
    message: AUTH_RATE_LIMIT_MESSAGE,
    ipWindowMs: 15 * 60_000,
    ipLimit: 20,
    accountWindowMs: 15 * 60_000,
    accountLimit: 8,
    accountField: 'email',
  });

const mfaVerifyRateLimiters = (prefix) =>
  ipAndAccountRateLimiters({
    prefix,
    message: AUTH_RATE_LIMIT_MESSAGE,
    ipWindowMs: 60_000,
    ipLimit: 60,
    accountWindowMs: 15 * 60_000,
    accountLimit: 30,
    accountField: 'challenge_token',
  });

/**
 * Gap closure (user-reported): the forgot-password flow now checks a
 * 6-digit CODE, not an opaque 256-bit token — `tokenActionIpRateLimiter`'s
 * own "the token IS its own account-equivalent, IP-alone is enough"
 * reasoning no longer holds (an attacker can rotate IPs to grind a single
 * still-valid `reset_token`'s much smaller code space). Modeled on
 * `mfaVerifyRateLimiters` instead — the identical shape for the identical
 * problem — keyed on `reset_token`, the body field a caller presents here.
 */
const passwordResetVerifyRateLimiters = (prefix) =>
  ipAndAccountRateLimiters({
    prefix,
    message: AUTH_RATE_LIMIT_MESSAGE,
    ipWindowMs: 60_000,
    ipLimit: 60,
    accountWindowMs: 15 * 60_000,
    accountLimit: 30,
    accountField: 'reset_token',
  });

const tokenActionIpRateLimiter = (prefix) =>
  redisRateLimiter({ windowMs: 15 * 60_000, limit: 20, prefix, message: AUTH_RATE_LIMIT_MESSAGE });

function staffAuthRouter({ resolveTenant }) {
  const router = Router();
  // Public, tenant resolved from the Host header (or the dev override).
  router.post('/login', resolveTenant, ...loginRateLimiters('auth-staff-login:'), controller.staffLogin);
  // Security-review finding: CSRF defense-in-depth for the one action
  // authenticated by the refresh cookie alone — `same-origin-guard.js`'s
  // own header has the full reasoning (SameSite=Lax is the real, primary
  // defense; this is a second, explicit check on top of it).
  router.post('/refresh', resolveTenant, requireSameOrigin, controller.staffRefresh);
  router.post('/password/forgot', resolveTenant, ...passwordResetRequestRateLimiters('auth-staff-forgot:'), controller.requestPasswordResetCode);
  // No resolveTenant here — mirrors `/mfa/verify` exactly: `tenantId` comes
  // from decoding `reset_token`, not the Host header (see
  // `password-reset-code.js`'s own header for why the token must carry it).
  router.post('/password/reset', ...passwordResetVerifyRateLimiters('auth-staff-reset:'), controller.completePasswordResetWithCode);
  // Public, same reasoning as the password-reset pair above — an invitee
  // holds a token, not a session, so this must run before authenticate().
  router.post('/invitations/accept', resolveTenant, tokenActionIpRateLimiter('auth-staff-invite-accept:'), controller.acceptInvitation);
  // Part of the login flow itself — a caller holds a short-lived challenge
  // token from staffLogin, not a full access token yet, so this cannot sit
  // behind authenticate('staff'), and needs no tenant resolution either (the
  // challenge token itself, once real, carries what verification needs).
  router.post('/mfa/verify', ...mfaVerifyRateLimiters('auth-staff-mfa-verify:'), controller.verifyMfa);
  // Gap closure: public + cookie-gated, same shape as /refresh — see
  // service.js's own staffLogout header for why this moved off
  // authenticate('staff'). Revoking a session needs only the refresh
  // cookie itself, never a fresh access token.
  // Same CSRF defense-in-depth as `/refresh` above.
  router.post('/logout', resolveTenant, requireSameOrigin, controller.staffLogout);

  // Authenticated — tenant comes from the verified token, not the Host header.
  router.post('/switch-property', authenticate('staff'), controller.switchProperty);
  // What this user may do at their active property — drives the role-aware
  // sidebar. Ungated by design: every authenticated staff member may read
  // their own grants; the permission checks on each real route are unchanged.
  router.get('/me/permissions', authenticate('staff'), controller.myPermissions);

  // Self-service "My Profile" screen (user-requested) — the same "every
  // authenticated staff member may act on their OWN record, no permission
  // gate" shape `/me/permissions` above already established. No `:id`
  // anywhere in these routes for a caller to smuggle another user's id
  // through — see `service.js`'s own header for the full reasoning.
  router.get('/me', authenticate('staff'), controller.getMyProfile);
  router.patch('/me', authenticate('staff'), controller.updateMyProfile);
  // A caller holding ANY valid access token could otherwise repeatedly
  // guess this account's own current password with no counter at all
  // (`lockout.js`'s 423 tier only counts `login_failure`, not this route) —
  // the same Redis-backed "auth tier" shape (per-IP loose, per-account
  // tight) `/login` etc. already use, hand-built here (not
  // `ipAndAccountRateLimiters`, whose account key generator only reads
  // `req.body[field]`, never `req.context`) since the account being
  // guarded is the AUTHENTICATED caller, not a body field.
  router.post(
    '/me/password',
    authenticate('staff'),
    redisRateLimiter({ windowMs: 60_000, limit: 30, prefix: 'auth-staff-password-change:ip:', message: AUTH_RATE_LIMIT_MESSAGE }),
    redisRateLimiter({
      windowMs: 15 * 60_000,
      limit: 10,
      prefix: 'auth-staff-password-change:acct:',
      message: AUTH_RATE_LIMIT_MESSAGE,
      keyGenerator: (req) => `acct:${req.context?.tenantId ?? 'no-tenant'}:${req.context?.userId ?? 'unknown'}`,
    }),
    controller.changeMyPassword
  );

  return router;
}

function portalAuthRouter({ resolveTenant }) {
  const router = Router();
  router.post('/register', resolveTenant, ...loginRateLimiters('auth-guest-register:'), controller.guestRegister);
  router.post('/login', resolveTenant, ...loginRateLimiters('auth-guest-login:'), controller.guestLogin);
  // Gap closure (feature-dev): guest password-reset. Public, same reasoning
  // as staff's own password-reset pair above — a guest requesting or
  // completing a reset holds no session yet.
  router.post(
    '/password/forgot',
    resolveTenant,
    ...passwordResetRequestRateLimiters('auth-guest-forgot:'),
    controller.requestGuestPasswordReset
  );
  router.post('/password/reset', resolveTenant, tokenActionIpRateLimiter('auth-guest-reset:'), controller.completeGuestPasswordReset);
  return router;
}

function platformAuthRouter() {
  const router = Router();
  // No resolveTenant: platform_users belong to no tenant (SECURITY.md §2).
  // `accountKeyGenerator`'s own `req.tenantId ?? 'no-tenant'` fallback keeps
  // a platform account's rate-limit bucket distinct from any tenant-scoped
  // staff account that happens to share the same email string.
  router.post('/login', ...loginRateLimiters('auth-platform-login:'), controller.platformLogin);
  // PLAN.md Phase 5 (Platform Foundation): platform now has its own real
  // MFA implementation (TOTP, not staff's emailed code) — genuinely
  // separate controller functions from here on, not the shared `verifyMfa`
  // this route used before either audience had real verification.
  router.post(
    '/mfa/enroll/confirm',
    ...ipAndAccountRateLimiters({
      prefix: 'auth-platform-mfa-enroll:',
      message: AUTH_RATE_LIMIT_MESSAGE,
      ipWindowMs: 60_000,
      ipLimit: 60,
      accountWindowMs: 15 * 60_000,
      accountLimit: 30,
      accountField: 'enrollment_token',
    }),
    controller.platformMfaEnrollConfirm
  );
  router.post('/mfa/verify', ...mfaVerifyRateLimiters('auth-platform-mfa-verify:'), controller.verifyPlatformMfa);
  return router;
}

module.exports = { staffAuthRouter, portalAuthRouter, platformAuthRouter };
