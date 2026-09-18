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

/**
 * Security-review finding (2026-09): a fully public, fully unthrottled
 * endpoint that creates a real tenant + property + admin user per call is
 * a genuine account/tenant-spam vector — nothing here previously bounded
 * how many a single caller could create. Redis-backed per-IP AND
 * per-email limiting (ARCHITECTURE.md §15's "auth" shape, reused here even
 * though signup itself predates any account existing) closes the request-
 * volume half of that gap.
 *
 * NOT closed by this pass, and flagged rather than faked: real bot/CAPTCHA
 * screening (hCaptcha/Turnstile or similar) needs a third-party service
 * this environment has no credentials for — the same "flagged stub, not
 * invented behaviour" precedent this codebase already applies to Paystack
 * and SMTP. A generous-but-real request-volume ceiling is genuine
 * mitigation on its own; it is not a substitute for that missing piece.
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
    controller.signup
  );
  return router;
}

module.exports = { signupRouter };
