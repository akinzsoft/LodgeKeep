'use strict';

/**
 * The shared Redis connection for BullMQ — ARCHITECTURE.md §14: "Redis is
 * infrastructure, never a source of truth." One connection per process,
 * built lazily, the same singleton shape `src/db/index.js`'s `knex()` uses
 * for the MySQL connection.
 *
 * `maxRetriesPerRequest: null` is a BullMQ requirement for any connection
 * given to a `Worker`/`QueueScheduler` (documented in BullMQ's own docs) —
 * without it, ioredis's default retry behaviour can silently swallow a
 * command BullMQ was blocking on.
 */

const IORedis = require('ioredis');

let connection = null;

function redisConnection() {
  if (!connection) {
    connection = new IORedis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

async function destroyRedisConnection() {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

module.exports = { redisConnection, destroyRedisConnection };
