'use strict';

/**
 * The per-IP order-creation rate limit — PLAN.md Phase 6, the first real
 * use of `express-rate-limit`/`rate-limit-redis` anywhere in this
 * codebase (both have sat in `package.json` unused since they were added
 * ahead of a real caller). Redis-backed, per ARCHITECTURE.md §15's own
 * rule — an in-memory store resets on every deploy and stops working at
 * all once more than one backend instance runs behind a load balancer.
 *
 * A generous ceiling, not a strict one: a shared property WiFi/NAT can
 * legitimately put many genuine guests behind one IP address at once —
 * this guards against a runaway or hostile client, not ordinary multi-
 * guest traffic from the same network. The per-TOKEN limit
 * (`rate-limit.js`) is the tighter, more meaningful guard against any one
 * table/room's own QR code being spammed.
 *
 * Uses the SAME dedicated `rateLimitRedisConnection()` singleton the
 * per-token counter uses — a genuinely different Redis consumer from
 * BullMQ's own connection (see that file's own header).
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { rateLimitRedisConnection } = require('../../shared/rate-limit-redis-connection');
const { fail } = require('../../shared/response');

/**
 * `limit`/`prefix` are overridable (code-review fix, IMPORTANT) so a
 * SEPARATE instance — its own Redis-backed counter, never sharing order
 * creation's own budget — can guard the OTP request/verify routes too
 * (`routes.js`), each with its own appropriately-scoped ceiling.
 */
function qrOrderIpRateLimiter({ limit = 30, prefix = 'qr-order-ip-rl:' } = {}) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKeyGenerator,
    store: new RedisStore({
      prefix,
      sendCommand: (...args) => rateLimitRedisConnection().call(...args),
    }),
    handler: (req, res) => {
      res.status(429).json(fail('RATE_LIMITED', 'Too many requests from this network — please wait a moment and try again.'));
    },
  });
}

module.exports = { qrOrderIpRateLimiter };
