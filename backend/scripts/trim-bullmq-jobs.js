'use strict';

/**
 * Trims old finished BullMQ jobs out of Redis (production incident: queues without retention kept every
 * completed sweep job, Redis hit maxmemory and refused writes).
 *
 * Removes ONLY:
 *   - completed jobs older than the queue's completed retention (src/jobs/job-retention.js, 1 hour), and
 *   - failed jobs older than the queue's failed retention (14 days, payment-webhooks 30 days).
 * It NEVER touches waiting, active, delayed, paused, prioritized or waiting-children jobs, nor repeatable job
 * schedulers: it only calls BullMQ's `clean()` for the 'completed' and 'failed' states, and the dry run only
 * counts those two sorted sets (ZCOUNT, read-only).
 *
 * Dry run by default; --apply removes. Prints Redis used_memory before and after. The Redis password comes from
 * REDIS_PASSWORD (the backend container already has it) and is never printed. Run in the backend container:
 *
 *   docker compose --env-file .env.production -f docker-compose.prod.yml exec -T backend node scripts/trim-bullmq-jobs.js
 *   ... same command with --apply to remove ...
 *
 * Freed memory shows in used_memory once Redis releases it; if it lags, `MEMORY PURGE` or a Redis restart
 * (appendonly is on) reclaims fragmentation.
 */

const BATCH = 5000;

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fmtAge(seconds) {
  if (seconds >= 86400) return `${seconds / 86400}d`;
  if (seconds >= 3600) return `${seconds / 3600}h`;
  return `${seconds}s`;
}

async function usedMemory(redis) {
  const text = await redis.info('memory');
  const match = /^used_memory:(\d+)/m.exec(text);
  return match ? Number(match[1]) : NaN;
}

/**
 * @param {{ redis: import('ioredis').Redis, argv: string[], out: (line: string) => void,
 *           queueNames?: string[], retentionFor?: Function, makeQueue?: Function }} deps
 * @returns {Promise<number>} exit code
 */
async function main({ redis, argv, out, queueNames, retentionFor, makeQueue }) {
  const { Queue } = require('bullmq');
  const queues = require('../src/jobs/queues');
  const retention = require('../src/jobs/job-retention');
  queueNames = queueNames ?? queues.ALL_QUEUE_NAMES;
  retentionFor = retentionFor ?? retention.retentionFor;
  makeQueue = makeQueue ?? ((name) => new Queue(name, { connection: redis }));

  const unknown = argv.filter((a) => a !== '--apply');
  if (unknown.length) {
    out(`Unknown option: ${unknown[0]}. Only --apply is accepted (default is a dry run).`);
    return 1;
  }
  const apply = argv.includes('--apply');
  out(apply ? 'APPLY: removing old completed/failed BullMQ jobs.' : 'DRY RUN: nothing will be removed. Re-run with --apply.');
  const before = await usedMemory(redis);
  out(`Redis used_memory before: ${mb(before)}`);

  // BullMQ's clean() measures age against the real clock, so the dry run does too (they must agree).
  const now = Date.now();
  let totalRemoved = 0;
  for (const name of queueNames) {
    const { removeOnComplete, removeOnFail } = retentionFor(name);
    const completedCutoff = now - removeOnComplete.age * 1000;
    const failedCutoff = now - removeOnFail.age * 1000;
    // Completed/failed sets are scored by finishedOn (ms).
    const completedOld = await redis.zcount(`bull:${name}:completed`, '-inf', `(${completedCutoff}`);
    const failedOld = await redis.zcount(`bull:${name}:failed`, '-inf', `(${failedCutoff}`);
    let removed = '';
    if (apply && (completedOld || failedOld)) {
      const queue = makeQueue(name);
      try {
        const done = await cleanAll(queue, removeOnComplete.age * 1000, 'completed');
        const failed = await cleanAll(queue, removeOnFail.age * 1000, 'failed');
        totalRemoved += done + failed;
        removed = ` -> removed completed ${done}, failed ${failed}`;
      } finally {
        await queue.close();
      }
    }
    out(`${name}: ${completedOld} completed older than ${fmtAge(removeOnComplete.age)}, ${failedOld} failed older than ${fmtAge(removeOnFail.age)}${removed}`);
  }

  const after = await usedMemory(redis);
  out(`Redis used_memory after: ${mb(after)}${apply ? ` (${totalRemoved} jobs removed)` : ' (unchanged, dry run)'}`);
  return 0;
}

async function cleanAll(queue, graceMs, state) {
  let total = 0;
  for (;;) {
    const ids = await queue.clean(graceMs, BATCH, state);
    total += ids.length;
    if (ids.length < BATCH) return total;
  }
}

module.exports = { main, usedMemory };

if (require.main === module) {
  require('dotenv').config();
  const IORedis = require('ioredis');
  const redis = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  });
  main({ redis, argv: process.argv.slice(2), out: (line) => console.log(line) })
    .then((code) => redis.quit().then(() => process.exit(code)))
    .catch((error) => {
      console.error('trim failed:', error.message);
      process.exit(1);
    });
}
