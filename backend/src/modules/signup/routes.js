'use strict';

/**
 * PLAN.md Phase 5 — self-service tenant signup. Deliberately public: no
 * `authenticate(...)` of any kind, because no tenant, user, or session
 * exists yet — that's the entire point (PRODUCT_REQUIREMENTS.md §3.22, "no
 * engineer in the loop"). Mounted directly in `src/app.js`, not nested
 * inside `buildStaffRouter()`, so it never passes through Host-header
 * tenant resolution or `authenticate('staff')`, both of which presuppose a
 * tenant already exists.
 */

const { Router } = require('express');
const controller = require('./controller');
const { ipAndAccountRateLimiters } = require('../../shared/rate-limit');
const { requireCaptcha } = require('../../shared/captcha-middleware');

/**
 * Security-review finding (2026-09): a fully public, fully unthrottled
 * endpoint that creates a real tenant + property + admin user per call is
 * a genuine account/tenant-spam vector — nothing here previously bounded
 * how many a single caller could create. Redis-backed per-IP AND
 * per-email limiting (ARCHITECTURE.md §15's "auth" shape, reused here even
 * though signup itself predates any account existing) closes the request-
 * volume half of that gap.
 *
 * Follow-up (2026-09): real bot/CAPTCHA screening — the rate limiter alone
 * doesn't stop a distributed bot spreading requests across many IPs, which
 * this file's own earlier comment already flagged as the real gap a pure
 * request-volume ceiling can't close. `requireCaptcha()` (Cloudflare
 * Turnstile, `shared/captcha-verify.js`) runs AFTER the rate limiters —
 * rate limiting is a cheap Redis INCR, captcha verification is a real
 * outbound HTTP call to Cloudflare, so a flood of bad attempts gets
 * throttled before spending that call on each one.
 */
function signupRouter() {
  const router = Router();
  router.post(
    '/signup',
    ...ipAndAccountRateLimiters({
      prefix: 'signup:',
      message: 'Too many signup attempts — please wait a moment and try again.',
      ipWindowMs: 60 * 60_000,
      ipLimit: 20,
      accountWindowMs: 60 * 60_000,
      accountLimit: 5,
      accountField: 'admin_email',
    }),
    requireCaptcha(),
    controller.signup
  );
  return router;
}

module.exports = { signupRouter };
