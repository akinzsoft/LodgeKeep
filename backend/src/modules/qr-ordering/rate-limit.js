'use strict';

/**
 * The per-token order-creation rate limit — PLAN.md Phase 6,
 * ARCHITECTURE.md §15's public/guest tier ("per-IP AND per-token — the
 * only surface where a hostile actor has no account to lock"). The per-IP
 * half is `express-rate-limit` + `rate-limit-redis` (`ip-rate-limit.js`,
 * a fixed-at-construction-time limit); THIS half is a small, dedicated
 * Redis counter instead, specifically because the cap itself is a
 * per-outlet, DB-configured value (`pos_outlets.guest_order_rate_limit_max`)
 * read fresh at request time — a value a single, statically-configured
 * `express-rate-limit` instance has no way to vary per call.
 *
 * INCR + PEXPIRE NX: the counter increments unconditionally, then every
 * call also attempts to set the window's expiry with the Redis 7 `NX`
 * flag — a no-op once already set, so only the FIRST call in a fresh
 * window actually starts the clock, with no separate "is this the first
 * call" branch needed.
 */

const { rateLimitRedisConnection } = require('../../shared/rate-limit-redis-connection');
const { RateLimitedError } = require('./errors');

const WINDOW_MS = 60_000;

async function checkTokenOrderRateLimit({ tokenHash, max }) {
  const redis = rateLimitRedisConnection();
  const key = `qr-order-rate:${tokenHash}`;
  const count = await redis.incr(key);
  await redis.pexpire(key, WINDOW_MS, 'NX');

  if (count > max) {
    const ttl = await redis.pttl(key);
    throw new RateLimitedError(Math.max(1, Math.ceil((ttl > 0 ? ttl : WINDOW_MS) / 1000)));
  }
}

module.exports = { checkTokenOrderRateLimit, WINDOW_MS };
