'use strict';

/**
 * A SEPARATE Redis connection from `src/jobs/redis-connection.js`'s BullMQ
 * singleton — PLAN.md Phase 6's QR self-ordering gap closure, the first
 * real use of `express-rate-limit`/`rate-limit-redis` anywhere in this
 * codebase (both have sat in `package.json` unused until this pass).
 *
 * `src/jobs/redis-connection.js`'s own header explains why its connection
 * carries `maxRetriesPerRequest: null` — a BullMQ-specific requirement for
 * any connection handed to a `Worker`/`QueueScheduler`, since ioredis's
 * default retry behaviour can otherwise silently swallow a command BullMQ
 * is blocking on. That requirement does not apply here — `rate-limit-redis`
 * and the small per-token counter below (`qr-ordering/rate-limit.js`) are
 * ordinary request/response Redis calls, not blocking queue operations —
 * so this connection uses ioredis's own sane defaults rather than
 * inheriting a setting written for a different consumer's needs. Kept as
 * its own singleton (not a second call into `redisConnection()`) so
 * ARCHITECTURE.md §14's "one queue/connection per job category" instinct
 * extends naturally to "one connection per genuinely different Redis
 * consumer" — a rate-limit outage must never contend with, or be confused
 * for, a BullMQ outage.
 */

const IORedis = require('ioredis');

let connection = null;

function rateLimitRedisConnection() {
  if (!connection) {
    connection = new IORedis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
    });
  }
  return connection;
}

async function destroyRateLimitRedisConnection() {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

module.exports = { rateLimitRedisConnection, destroyRateLimitRedisConnection };
