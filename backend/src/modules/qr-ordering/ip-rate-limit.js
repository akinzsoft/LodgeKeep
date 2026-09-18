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
 * A thin wrapper over `shared/rate-limit.js`'s `redisRateLimiter` — this
 * was the first real caller (hence the QR-specific defaults/wording below),
 * promoted to shared infra once auth/signup/portal-booking needed the same
 * shape (that file's own header has the full reasoning).
 */

const { redisRateLimiter } = require('../../shared/rate-limit');

/**
 * `limit`/`prefix` are overridable (code-review fix, IMPORTANT) so a
 * SEPARATE instance — its own Redis-backed counter, never sharing order
 * creation's own budget — can guard the OTP request/verify routes too
 * (`routes.js`), each with its own appropriately-scoped ceiling.
 */
function qrOrderIpRateLimiter({ limit = 30, prefix = 'qr-order-ip-rl:' } = {}) {
  return redisRateLimiter({
    windowMs: 60_000,
    limit,
    prefix,
    message: 'Too many requests from this network — please wait a moment and try again.',
  });
}

module.exports = { qrOrderIpRateLimiter };
