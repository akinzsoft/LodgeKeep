'use strict';

/**
 * Early warning for Redis memory (production incident: Redis hit maxmemory with
 * noeviction and refused every write). Runs inside the payment-webhooks 60 s
 * sweep. Past 80% of `maxmemory` it logs a warning and rings a bell for the
 * super_admins of every active property. The bell's dedup key is per UTC day, so
 * it does not repeat each minute (a still-full Redis reminds once a day).
 * Read-only against Redis (`INFO memory`); never throws into the sweep.
 */

const { redisConnection } = require('./redis-connection');
const { knex, scopedDb } = require('../db');
const { workerContext } = require('../modules/tenancy');
const { notifyStaff } = require('../modules/notifications/staff-notifications');

const WARN_RATIO = 0.8;
const MB = 1024 * 1024;

function parseInfo(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/** Returns { usedBytes, maxBytes } from `INFO memory`; maxBytes 0 means no limit configured. */
async function readRedisMemory(redis = redisConnection()) {
  const info = parseInfo(await redis.info('memory'));
  return { usedBytes: Number(info.used_memory), maxBytes: Number(info.maxmemory) };
}

function isOverThreshold({ usedBytes, maxBytes }) {
  return Number.isFinite(usedBytes) && Number.isFinite(maxBytes) && maxBytes > 0 && usedBytes / maxBytes >= WARN_RATIO;
}

/** @returns {Promise<{checked: boolean, over: boolean, alerted: number}>} */
async function runRedisMemoryCheck({ redis = redisConnection(), now = new Date() } = {}) {
  let memory;
  try {
    memory = await readRedisMemory(redis);
  } catch (error) {
    console.error('redis memory check failed:', error.message);
    return { checked: false, over: false, alerted: 0 };
  }
  if (!isOverThreshold(memory)) return { checked: true, over: false, alerted: 0 };

  const percent = Math.round((memory.usedBytes / memory.maxBytes) * 100);
  const payload = { usedMb: Math.round(memory.usedBytes / MB), maxMb: Math.round(memory.maxBytes / MB), percent };
  console.warn(`WARNING: Redis memory at ${percent}% (${payload.usedMb} MB of ${payload.maxMb} MB, noeviction): trim BullMQ jobs (scripts/trim-bullmq-jobs.js) or raise maxmemory.`);

  const dedupKey = `redis-memory-high:${now.toISOString().slice(0, 10)}`;
  let alerted = 0;
  try {
    const properties = await knex()('properties as p')
      .join('tenants as t', 't.id', 'p.tenant_id')
      .where({ 't.status': 'active', 'p.status': 'active' })
      .select('p.tenant_id', 'p.id as property_id');
    for (const { tenant_id: tenantId, property_id: propertyId } of properties) {
      try {
        alerted += await scopedDb()
          .for(workerContext({ tenantId, propertyId }))
          .transaction((trx) => notifyStaff({ trx, eventType: 'platform.redis_memory_high', payload, dedupKey }));
      } catch (error) {
        console.error(`redis memory bell failed for tenant ${tenantId} property ${propertyId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('redis memory bell lookup failed:', error.message);
  }
  return { checked: true, over: true, alerted };
}

module.exports = { runRedisMemoryCheck, readRedisMemory, isOverThreshold, parseInfo, WARN_RATIO };
