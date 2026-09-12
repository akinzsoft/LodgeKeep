'use strict';

/**
 * Real-Redis round-trip test for the per-token rate limiter — PLAN.md
 * Phase 6, the same "test the real infrastructure, not a mock" discipline
 * `tests/jobs/outbox-dispatcher.test.js` already established for BullMQ.
 * No mock — this genuinely INCRs and PEXPIREs a real key against the same
 * Redis instance the dev/test environment already runs.
 */

const { checkTokenOrderRateLimit, checkTokenOtpRequestRateLimit, checkTokenOtpVerifyRateLimit } = require('../../src/modules/qr-ordering/rate-limit');
const { RateLimitedError } = require('../../src/modules/qr-ordering/errors');
const { rateLimitRedisConnection, destroyRateLimitRedisConnection } = require('../../src/shared/rate-limit-redis-connection');

describe('qr-ordering per-token rate limit — real Redis (PLAN.md Phase 6)', () => {
  const testTokenHash = `test-rate-limit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  afterAll(async () => {
    await rateLimitRedisConnection().del(`qr-order-rate:${testTokenHash}`);
    await destroyRateLimitRedisConnection();
  });

  it('allows calls up to the configured max, then genuinely rejects the next one with a real 429-shaped error', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(checkTokenOrderRateLimit({ tokenHash: testTokenHash, max: 3 })).resolves.toBeUndefined();
    }
    await expect(checkTokenOrderRateLimit({ tokenHash: testTokenHash, max: 3 })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('reports a real, positive retry-after derived from the actual key TTL still in Redis', async () => {
    const hash = `${testTokenHash}-ttl`;
    try {
      for (let i = 0; i < 2; i += 1) {
        await checkTokenOrderRateLimit({ tokenHash: hash, max: 1 });
      }
      throw new Error('expected checkTokenOrderRateLimit to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedError);
      expect(error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    await rateLimitRedisConnection().del(`qr-order-rate:${hash}`);
  });

  it('scopes independently by token — a different token is never affected by another one being exhausted', async () => {
    const otherHash = `${testTokenHash}-other`;
    await expect(checkTokenOrderRateLimit({ tokenHash: otherHash, max: 1 })).resolves.toBeUndefined();
    await rateLimitRedisConnection().del(`qr-order-rate:${otherHash}`);
  });
});

/**
 * Code-review fix (IMPORTANT) — the same real-Redis-round-trip proof as
 * above, for the two dedicated OTP counters (`checkTokenOtpRequestRateLimit`/
 * `checkTokenOtpVerifyRateLimit`) that close the "anyone who's ever had
 * access to a room's QR token can spam request-otp with no cooldown,
 * repeatedly emailing the current in-house guest's real inbox" gap. Each
 * uses its OWN Redis key prefix, never sharing a bucket with order
 * creation's own counter or with each other — proven directly below.
 */
describe('qr-ordering OTP per-token rate limits — real Redis (code-review fix, IMPORTANT)', () => {
  const testTokenHash = `test-otp-rate-limit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  afterAll(async () => {
    const redis = rateLimitRedisConnection();
    await redis.del(`qr-otp-request-rate:${testTokenHash}`, `qr-otp-verify-rate:${testTokenHash}`);
    await destroyRateLimitRedisConnection();
  });

  it('checkTokenOtpRequestRateLimit genuinely rejects once its own real ceiling (15/min) is exceeded', async () => {
    for (let i = 0; i < 15; i += 1) {
      await expect(checkTokenOtpRequestRateLimit({ tokenHash: testTokenHash })).resolves.toBeUndefined();
    }
    await expect(checkTokenOtpRequestRateLimit({ tokenHash: testTokenHash })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('checkTokenOtpVerifyRateLimit uses a genuinely SEPARATE counter — exhausting request-otp above never affects it', async () => {
    // The SAME token hash just exhausted its request-otp budget above —
    // verify must be completely unaffected, proving the two never share a
    // Redis key.
    await expect(checkTokenOtpVerifyRateLimit({ tokenHash: testTokenHash })).resolves.toBeUndefined();
  });

  it('checkTokenOtpVerifyRateLimit genuinely rejects once its own real ceiling (25/min) is exceeded', async () => {
    const hash = `${testTokenHash}-verify`;
    for (let i = 0; i < 25; i += 1) {
      await expect(checkTokenOtpVerifyRateLimit({ tokenHash: hash })).resolves.toBeUndefined();
    }
    await expect(checkTokenOtpVerifyRateLimit({ tokenHash: hash })).rejects.toBeInstanceOf(RateLimitedError);
    await rateLimitRedisConnection().del(`qr-otp-verify-rate:${hash}`);
  });
});
