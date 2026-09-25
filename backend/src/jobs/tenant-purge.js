'use strict';

/**
 * The tenant retention-expiry purge sweep's transport — `src/modules/offboarding/purge.js`
 * holds all the logic (gate, claim, resumable deletion, warnings); this file is only
 * the BullMQ wiring around `runPurgeSweep`, mirroring `door-access-retention.js` /
 * `trial-expiry.js` exactly (`upsertJobScheduler`, never the v4-era
 * `Queue#add({repeat})`, which is a silent no-op on this codebase's BullMQ v6).
 *
 * ── THIS JOB IS DESTRUCTIVE, SO IT IS OFF UNLESS ASKED FOR ───────────────
 *
 * `src/server.js` registers the worker and scheduler ONLY when
 * `TENANT_PURGE_ENABLED` is exactly the string `'true'`. Forgetting to set it
 * means data is kept past its deadline — the safe direction. It stays off in dev and
 * test, so a developer's database with an old offboarded tenant is never wiped.
 * There are NO backups on this stack: do not enable it in production until a
 * verified backup exists.
 *
 * `attempts: 1` and no backoff: the next scheduled tick IS the retry, and every step
 * of the purge is idempotent. `concurrency: 1` and a long `lockDuration` because a
 * tick may run for minutes.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { tenantPurgeQueue, TENANT_PURGE_QUEUE } = require('./queues');
const { runPurgeSweep } = require('../modules/offboarding/purge');

const SWEEP_JOB_NAME = 'sweep';
const SWEEP_INTERVAL_MS = Number(process.env.TENANT_PURGE_SWEEP_INTERVAL_MS || 300_000);
const SWEEP_SCHEDULER_ID = 'tenant-purge-sweep';

/** Whether the destructive job is switched on. Exactly `'true'`, nothing else. */
function isTenantPurgeEnabled() {
  return process.env.TENANT_PURGE_ENABLED === 'true';
}

async function scheduleTenantPurgeSweep() {
  await tenantPurgeQueue().upsertJobScheduler(
    SWEEP_SCHEDULER_ID,
    { every: SWEEP_INTERVAL_MS },
    { name: SWEEP_JOB_NAME, data: {}, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 } }
  );
}

function startTenantPurgeWorker() {
  return new Worker(
    TENANT_PURGE_QUEUE,
    async () => {
      await runPurgeSweep();
    },
    { connection: redisConnection(), concurrency: 1, lockDuration: 300_000 }
  );
}

module.exports = { isTenantPurgeEnabled, scheduleTenantPurgeSweep, startTenantPurgeWorker, SWEEP_SCHEDULER_ID, SWEEP_JOB_NAME };
