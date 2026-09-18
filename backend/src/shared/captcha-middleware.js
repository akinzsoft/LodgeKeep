'use strict';

/**
 * Express-facing half of CAPTCHA screening — kept separate from
 * `captcha-verify.js` specifically so tests can `jest.mock` the network-
 * calling module and have this file's own `require('./captcha-verify')`
 * transparently pick up the mock, the identical mechanism that already
 * makes mocking `breached-password.js` work transparently through
 * `auth/password.js`.
 *
 * Responds directly from the middleware (never `next(error)`) — the same
 * shape `redisRateLimiter`'s own `handler` already established
 * (`shared/rate-limit.js`) — rather than a new `AppError` subclass routed
 * through `error-handler.js`.
 */

const { verifyTurnstileToken } = require('./captcha-verify');
const { fail } = require('./response');

function requireCaptcha() {
  return async function captchaGuard(req, res, next) {
    const token = req.body?.captcha_token;
    if (typeof token !== 'string' || token.trim() === '') {
      res.status(400).json(fail('VALIDATION_CAPTCHA_TOKEN_REQUIRED', 'A CAPTCHA token is required.'));
      return;
    }

    const verified = await verifyTurnstileToken(token, { remoteIp: req.ip });
    if (!verified) {
      res.status(400).json(fail('VALIDATION_CAPTCHA_FAILED', 'CAPTCHA verification failed — please try again.'));
      return;
    }

    next();
  };
}

module.exports = { requireCaptcha };
