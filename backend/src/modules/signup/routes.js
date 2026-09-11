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

function signupRouter() {
  const router = Router();
  router.post('/signup', controller.signup);
  return router;
}

module.exports = { signupRouter };
