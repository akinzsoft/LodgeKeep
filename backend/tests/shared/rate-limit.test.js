'use strict';

/**
 * Real-Redis round-trip tests for the generic rate limiter factory —
 * `src/shared/rate-limit.js`. Same "test the real infrastructure, not a
 * mock" discipline `tests/qr-ordering/rate-limit.test.js` already
 * established for the per-token counters, applied here to the per-IP/
 * per-account HTTP middleware this file promotes to shared infra.
 *
 * Mounted on a small standalone Express app (not `useTestApp()`'s full
 * app/database wiring — nothing here touches MySQL), with `trust proxy`
 * enabled so each test can drive an independent, fake IP via
 * `X-Forwarded-For` — the real mechanism `src/app.js` itself already
 * configures in production (`app.set('trust proxy', 1)`), not a test-only
 * shortcut. Every test uses its own randomly-suffixed prefix, so no two
 * tests — and nothing the rest of the suite does against real Redis —
 * can ever share a counter.
 */

const express = require('express');
const request = require('supertest');
const { redisRateLimiter, accountKeyGenerator, ipAndAccountRateLimiters } = require('../../src/shared/rate-limit');
const { rateLimitRedisConnection, destroyRateLimitRedisConnection } = require('../../src/shared/rate-limit-redis-connection');

function uniquePrefix(label) {
  return `test-rl-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}:`;
}

function buildApp(...middlewares) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/probe', ...middlewares, (req, res) => res.status(200).json({ ok: true }));
  return app;
}

afterAll(async () => {
  await destroyRateLimitRedisConnection();
});

describe('redisRateLimiter — real Redis (security-review rate-limiting pass)', () => {
  it('a real bug this file itself found and fixed: the bare `ipKeyGenerator` export is not a middleware keyGenerator — confirms the correctly-composed default keys on the real per-request IP, not the literal string "[object Object]"', async () => {
    const prefix = uniquePrefix('ip-key-shape');
    const app = buildApp(redisRateLimiter({ windowMs: 60_000, limit: 5, prefix, message: 'nope' }));

    await request(app).post('/probe').set('X-Forwarded-For', '203.0.113.5').send({});

    const redis = rateLimitRedisConnection();
    const keys = await redis.keys(`${prefix}*`);
    expect(keys).toEqual([`${prefix}203.0.113.5`]);
    await redis.del(...keys);
  });

  it('allows calls up to the configured limit, then genuinely 429s the next one with the RATE_LIMITED envelope and a real Retry-After header', async () => {
    const prefix = uniquePrefix('basic');
    const app = buildApp(redisRateLimiter({ windowMs: 60_000, limit: 3, prefix, message: 'Too many — slow down.' }));

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/probe').set('X-Forwarded-For', '198.51.100.10').send({});
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post('/probe').set('X-Forwarded-For', '198.51.100.10').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.body.error.message).toBe('Too many — slow down.');
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    const redis = rateLimitRedisConnection();
    await redis.del(...(await redis.keys(`${prefix}*`)));
  });

  it('scopes independently by IP — a different caller is never affected by another one being exhausted', async () => {
    const prefix = uniquePrefix('per-ip-scope');
    const app = buildApp(redisRateLimiter({ windowMs: 60_000, limit: 1, prefix, message: 'nope' }));

    const first = await request(app).post('/probe').set('X-Forwarded-For', '192.0.2.1').send({});
    expect(first.status).toBe(200);
    const firstBlocked = await request(app).post('/probe').set('X-Forwarded-For', '192.0.2.1').send({});
    expect(firstBlocked.status).toBe(429);

    const secondCaller = await request(app).post('/probe').set('X-Forwarded-For', '192.0.2.2').send({});
    expect(secondCaller.status).toBe(200);

    const redis = rateLimitRedisConnection();
    await redis.del(...(await redis.keys(`${prefix}*`)));
  });
});

describe('accountKeyGenerator — real Redis', () => {
  it('keys on the normalized (trimmed, lowercased) request-body field, independent of the caller IP', async () => {
    const prefix = uniquePrefix('acct-basic');
    const app = buildApp(
      redisRateLimiter({ windowMs: 60_000, limit: 1, prefix, message: 'nope', keyGenerator: accountKeyGenerator('email') })
    );

    const first = await request(app).post('/probe').set('X-Forwarded-For', '198.51.100.20').send({ email: '  Someone@Example.com  ' });
    expect(first.status).toBe(200);

    // A DIFFERENT IP, same account (mixed case/whitespace) — still blocked,
    // proving the key is the email, not the IP.
    const sameAccountDifferentIp = await request(app)
      .post('/probe')
      .set('X-Forwarded-For', '198.51.100.21')
      .send({ email: 'someone@example.com' });
    expect(sameAccountDifferentIp.status).toBe(429);

    // A different account from the SAME first IP — unaffected.
    const differentAccount = await request(app).post('/probe').set('X-Forwarded-For', '198.51.100.20').send({ email: 'other@example.com' });
    expect(differentAccount.status).toBe(200);

    const redis = rateLimitRedisConnection();
    await redis.del(...(await redis.keys(`${prefix}*`)));
  });

  it('falls back to a distinctly-prefixed per-IP key when the field is missing, rather than colliding across callers', async () => {
    const prefix = uniquePrefix('acct-fallback');
    const app = buildApp(
      redisRateLimiter({ windowMs: 60_000, limit: 5, prefix, message: 'nope', keyGenerator: accountKeyGenerator('email') })
    );

    await request(app).post('/probe').set('X-Forwarded-For', '203.0.113.9').send({});

    const redis = rateLimitRedisConnection();
    const keys = await redis.keys(`${prefix}*`);
    expect(keys).toEqual([`${prefix}ip-fallback:203.0.113.9`]);
    await redis.del(...keys);
  });
});

describe('ipAndAccountRateLimiters — real Redis (ARCHITECTURE.md §15 auth tier)', () => {
  it('rejects once EITHER dimension trips — a tight per-account limit blocks a caller well under the looser per-IP ceiling', async () => {
    const prefix = uniquePrefix('pair');
    const app = buildApp(
      ...ipAndAccountRateLimiters({
        prefix,
        message: 'Too many attempts.',
        ipWindowMs: 60_000,
        ipLimit: 100,
        accountWindowMs: 60_000,
        accountLimit: 2,
        accountField: 'email',
      })
    );

    for (let i = 0; i < 2; i += 1) {
      const res = await request(app).post('/probe').set('X-Forwarded-For', '198.51.100.30').send({ email: 'target@example.com' });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post('/probe').set('X-Forwarded-For', '198.51.100.30').send({ email: 'target@example.com' });
    expect(blocked.status).toBe(429);

    // A DIFFERENT account from the SAME IP is unaffected — the per-IP
    // ceiling (100) is nowhere near tripped, proving the two dimensions
    // are independent counters, not one combined one.
    const otherAccount = await request(app).post('/probe').set('X-Forwarded-For', '198.51.100.30').send({ email: 'someone-else@example.com' });
    expect(otherAccount.status).toBe(200);

    const redis = rateLimitRedisConnection();
    await redis.del(...(await redis.keys(`${prefix}*`)));
  });
});
