'use strict';

/**
 * A generic Redis-backed rate limiter factory — ARCHITECTURE.md §15's rule
 * ("Redis-backed, never in-memory... three tiers, deliberately different
 * shapes"). Promoted out of `qr-ordering/ip-rate-limit.js` (Phase 6's own
 * first real caller of `express-rate-limit`/`rate-limit-redis`) once a
 * second, unrelated set of callers — signup, staff/guest/platform auth, and
 * anonymous portal booking — needed the identical shape: a Redis-backed
 * counter, a `429 RATE_LIMITED` envelope, and a real `Retry-After` header
 * (set automatically by `express-rate-limit` regardless of
 * `standardHeaders`).
 *
 * Every caller shares the SAME `rateLimitRedisConnection()` singleton
 * (`rate-limit-redis-connection.js`) — a genuinely different Redis consumer
 * from BullMQ's own connection, per that file's own header — but each gets
 * its own `prefix`, so one limiter's counter can never bleed into another's
 * budget.
 *
 * Security-review finding (2026-09): public signup, password-reset, portal
 * booking, and several QR routes had no consistent rate limit at all —
 * `src/auth/lockout.js`'s own header already named this exact gap
 * ("distinct from the 429 RATE_LIMITED traffic-shaping tier ... which is
 * not wired up in this pass"). This file is that tier, finally wired up;
 * `lockout.js`'s durable 423 LOCKED_ACCOUNT control is unchanged and stays
 * layered underneath it, not replaced by it.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { rateLimitRedisConnection } = require('./rate-limit-redis-connection');
const { fail } = require('./response');

/**
 * Real bug found while wiring this up, fixed here rather than repeated a
 * third time: `express-rate-limit`'s own exported `ipKeyGenerator` takes an
 * IP STRING (`ipKeyGenerator(req.ip, subnet)` — it IPv6-subnet-groups an
 * address, it does not read a request), not a `(req, res) => key`
 * middleware-shaped function. Passing the bare export as `keyGenerator`
 * (the pre-existing `qr-ordering/ip-rate-limit.js` did exactly this before
 * this file existed) makes every request collapse onto the literal key
 * `"[object Object]"` — confirmed live against real Redis (`KEYS
 * signup:ip:*` showed exactly that string) — so the per-IP dimension never
 * actually distinguished callers at all; it degraded into one shared,
 * global counter. `defaultIpKeyGenerator` below is the correct call shape.
 */
function defaultIpKeyGenerator(req) {
  return ipKeyGenerator(req.ip);
}

/**
 * `keyGenerator` defaults to per-IP (IPv6-safe via `ipKeyGenerator`, called
 * correctly — see the bug note above). Pass a different one (see
 * `accountKeyGenerator` below) to key on something else.
 */
function redisRateLimiter({ windowMs, limit, prefix, message, keyGenerator = defaultIpKeyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    store: new RedisStore({
      prefix,
      sendCommand: (...args) => rateLimitRedisConnection().call(...args),
    }),
    handler: (req, res) => {
      res.status(429).json(fail('RATE_LIMITED', message));
    },
  });
}

/**
 * Keys on a request-body field (trimmed, lowercased) scoped by `req.tenantId`
 * when present — the "per-account" half of ARCHITECTURE.md §15's auth tier
 * ("per-account AND per-IP ... both dimensions required, not either",
 * mirroring `lockout.js`'s own two-dimension shape for the 423 tier).
 * Works for an email field (login, password-reset) or a token field
 * (mfa/verify's `challenge_token`, enrollment's `enrollment_token`) equally
 * — either way it is "the thing identifying which single account/attempt
 * is being targeted," independent of which IP the request comes from.
 *
 * A request missing the field (should not normally happen — the
 * controller's own `require_()` rejects it before this ever matters for a
 * real attempt) falls back to a per-IP key, prefixed so it can never
 * collide with a real field-based key in the same limiter's key space.
 */
function accountKeyGenerator(fieldName) {
  return (req) => {
    const raw = req.body?.[fieldName];
    if (typeof raw !== 'string' || raw.trim() === '') {
      return `ip-fallback:${defaultIpKeyGenerator(req)}`;
    }
    const tenantScope = req.tenantId ?? 'no-tenant';
    return `acct:${tenantScope}:${raw.trim().toLowerCase()}`;
  };
}

/**
 * Builds the two independent limiters ARCHITECTURE.md §15's auth tier
 * requires — per-IP (loose, guards a shared terminal/NAT) and per-account
 * (tight, guards one targeted email/token) — as an array ready to spread
 * into a route's middleware list. Either one tripping is enough to reject
 * the request; they are not combined into a single counter.
 */
function ipAndAccountRateLimiters({ prefix, message, ipWindowMs, ipLimit, accountWindowMs, accountLimit, accountField }) {
  return [
    redisRateLimiter({ windowMs: ipWindowMs, limit: ipLimit, prefix: `${prefix}ip:`, message }),
    redisRateLimiter({
      windowMs: accountWindowMs,
      limit: accountLimit,
      prefix: `${prefix}acct:`,
      message,
      keyGenerator: accountKeyGenerator(accountField),
    }),
  ];
}

module.exports = { redisRateLimiter, accountKeyGenerator, ipAndAccountRateLimiters, defaultIpKeyGenerator };
