'use strict';

/**
 * Shared test helper for the Redis-backed rate limiters in
 * `src/shared/rate-limit.js` — generalizes the flush-before-run idiom
 * `tests/qr-ordering/qr-ordering.test.js` already established for its own
 * per-IP order-creation/OTP counters ("this file's own call volume would
 * otherwise collide with the real per-IP rate limiter's own window —
 * genuine production behaviour, but real Redis state that persists across
 * repeated runs of this same file within that window").
 *
 * A file that drives real HTTP traffic through a rate-limited route calls
 * `flushRateLimitPrefixes([...])` in its own `beforeAll`, naming every
 * prefix its own tests exercise. This resets that file's OWN counters to
 * zero at the start of its OWN run regardless of what any other file did
 * earlier in the same `--runInBand` process, and regardless of how many
 * times this exact file has been re-run within the same real-Redis window
 * during local iteration.
 */

const { rateLimitRedisConnection } = require('../../src/shared/rate-limit-redis-connection');

async function flushRateLimitPrefixes(prefixes) {
  const redis = rateLimitRedisConnection();
  const keyLists = await Promise.all(prefixes.map((prefix) => redis.keys(`${prefix}*`)));
  const all = keyLists.flat();
  if (all.length) await redis.del(...all);
}

module.exports = { flushRateLimitPrefixes };
