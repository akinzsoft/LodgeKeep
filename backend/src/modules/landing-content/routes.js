'use strict';

/**
 * Two routers. `publicLandingContentRouter` is the landing page's read: no
 * login, no tenant (the page is served on the bare host, where no tenant
 * exists), mounted directly in `src/app.js` like signup, and rate limited per
 * IP. `landingContentConsoleRouter` is mounted inside the platform console, so
 * `authenticate('platform')` already guards it; writing needs the `admin` tier,
 * reading is open to both tiers.
 */

const { Router } = require('express');
const controller = require('./controller');
const { redisRateLimiter } = require('../../shared/rate-limit');
const { requirePlatformRole } = require('../../auth');

function publicLandingContentRouter() {
  const router = Router();
  router.get(
    '/public/landing-content',
    redisRateLimiter({
      prefix: 'landing-content:ip:',
      windowMs: 60_000,
      limit: 120,
      message: 'Too many requests — please wait a moment.',
    }),
    controller.getPublic
  );
  return router;
}

function landingContentConsoleRouter() {
  const router = Router();
  router.get('/landing-content', controller.getConsole);
  router.put('/landing-content', requirePlatformRole('admin'), controller.save);
  router.post('/landing-content/reset', requirePlatformRole('admin'), controller.reset);
  router.post('/landing-content/versions/:id/restore', requirePlatformRole('admin'), controller.restore);
  return router;
}

module.exports = { publicLandingContentRouter, landingContentConsoleRouter };
