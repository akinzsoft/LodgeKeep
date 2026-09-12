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

/** The shared INCR + PEXPIRE NX mechanism (see this file's own header) — every per-token counter in this module is a thin, differently-keyed wrapper around this one. */
async function checkTokenRateLimit({ keyPrefix, tokenHash, max, windowMs = WINDOW_MS }) {
  const redis = rateLimitRedisConnection();
  const key = `${keyPrefix}:${tokenHash}`;
  const count = await redis.incr(key);
  await redis.pexpire(key, windowMs, 'NX');

  if (count > max) {
    const ttl = await redis.pttl(key);
    throw new RateLimitedError(Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000)));
  }
}

async function checkTokenOrderRateLimit({ tokenHash, max }) {
  return checkTokenRateLimit({ keyPrefix: 'qr-order-rate', tokenHash, max });
}

/**
 * Code-review fix (IMPORTANT) — a room's QR token is a semi-permanent
 * physical fixture, never rotated per guest (`pos_order_tokens`' own
 * migration header), so anyone who has ever had access to it can request
 * a room-charge order against it and spam this endpoint, which emails the
 * CURRENT in-house guest's real inbox on every single call
 * (`requestRoomChargeOtp`) — an anonymous email-bombing vector with no
 * cooldown at all before this fix. A SEPARATE counter/key from order
 * creation's own (`qr-order-rate`), never sharing its budget — spamming
 * OTP requests must not be free just because a token hasn't yet spent its
 * order-creation allowance, and vice versa.
 *
 * A deliberately tight ceiling relative to order-creation's own default
 * fallback (`?? 5` per minute, `controller.js`'s `createOrder`) — a guest
 * legitimately requests a fresh code at most once or twice per real
 * charge attempt (a typo, a slow inbox), never dozens of times a minute —
 * but set with enough headroom (15) that this codebase's own test suite,
 * which legitimately drives several sequential room-charge flows through
 * ONE shared test token, is never mistaken for the abuse this exists to
 * catch.
 */
async function checkTokenOtpRequestRateLimit({ tokenHash }) {
  return checkTokenRateLimit({ keyPrefix: 'qr-otp-request-rate', tokenHash, max: 15 });
}

/**
 * Code-review fix (IMPORTANT) — the `verify` counterpart, applied for the
 * same reason: a hammering script gains nothing by calling `verify`
 * directly instead of `request-otp` (each code is already single-use,
 * attempt-capped at 5, and expires — `otp.js` — but nothing previously
 * stopped an unbounded number of DISTINCT codes from being requested and
 * tried in sequence without this and the request-side limiter together).
 * A looser ceiling than request-otp's own — verify sends no email, and a
 * genuine two-connection concurrent-verify race
 * (`tests/qr-ordering/concurrency.test.js`) must never be mistaken for
 * abuse.
 */
async function checkTokenOtpVerifyRateLimit({ tokenHash }) {
  return checkTokenRateLimit({ keyPrefix: 'qr-otp-verify-rate', tokenHash, max: 25 });
}

module.exports = { checkTokenOrderRateLimit, checkTokenOtpRequestRateLimit, checkTokenOtpVerifyRateLimit, WINDOW_MS };
