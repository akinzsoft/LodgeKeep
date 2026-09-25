'use strict';

/**
 * Door-access retention sweep's transport — PLAN.md Phase 7 gap closure,
 * PRODUCT_REQUIREMENTS.md §3.23's legal/privacy note. Mirrors
 * `src/jobs/trial-expiry.js`/`src/jobs/notifications-sweep.js` exactly: the
 * sweep LOGIC (`access-monitoring/service.js`'s `purgeExpiredEvents`) is
 * fully testable against real MySQL with no live queue; this file is only
 * the BullMQ wiring around it — `upsertJobScheduler`, not `Queue#add({repeat})`,
 * which is a silent no-op against this codebase's installed BullMQ v6.
 *
 * "Which properties" is a bootstrapping question with no tenant context yet
 * to ask it through — reads `properties`/`tenants`/`lock_system_config`
 * directly via `knex()`, the same exception `trial-expiry.js`'s own header
 * already documents.
 *
 * A property with no `lock_system_config.retention_days` set (the default)
 * is excluded from the query entirely — this sweep never even considers a
 * property that hasn't opted into automatic purging.
 *
 * One audit_log row per property per sweep tick, but ONLY when something
 * was actually deleted — a "0 deleted, nothing to do" row every day for
 * every configured property would be pure noise, the same
 * `if (affected > 0)` discipline `trial-expiry.js`'s own sweep already
 * uses. A failure at one property is logged and never stops the rest.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { doorAccessRetentionQueue, DOOR_ACCESS_RETENTION_QUEUE } = require('./queues');
const { knex, scopedDb } = require('../db');
const { INACTIVE_SWEEP_STATUSES } = require('../shared/tenant-lifecycle');
const { workerContext } = require('../modules/tenancy');
const { recordAuditEntry } = require('../audit');
const { purgeExpiredEvents } = require('../modules/access-monitoring/service');

const SWEEP_JOB_NAME = 'sweep';
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const SWEEP_SCHEDULER_ID = 'door-access-retention-sweep';

/**
 * One pass over every active property whose lock config has a real
 * `retention_days` set. Returns the total number of `door_access_events`
 * rows deleted across all of them.
 */
async function runDoorAccessRetentionSweep() {
  const properties = await knex()('properties')
    .join('tenants', 'tenants.id', 'properties.tenant_id')
    .join('lock_system_config', function joinConfig() {
      this.on('lock_system_config.tenant_id', '=', 'properties.tenant_id').andOn(
        'lock_system_config.property_id',
        '=',
        'properties.id'
      );
    })
    .where('properties.status', 'active')
    .whereNotIn('tenants.status', INACTIVE_SWEEP_STATUSES)
    .whereNotNull('lock_system_config.retention_days')
    .select('properties.id as id', 'properties.tenant_id as tenant_id');

  let totalDeleted = 0;
  for (const property of properties) {
    try {
      const context = workerContext({ tenantId: property.tenant_id, propertyId: property.id });
      const result = await purgeExpiredEvents({ context });
      if (result.deleted > 0) {
        totalDeleted += result.deleted;
        const db = scopedDb().for(context);
        await recordAuditEntry(db, {
          propertyId: property.id,
          entityType: 'lock_system_config',
          entityId: result.configId,
          action: 'door_access_retention_purge',
          source: 'job',
          afterState: {
            deletedCount: result.deleted,
            retentionDays: result.retentionDays,
            cutoff: result.cutoff,
          },
        });
      }
    } catch (error) {
      console.error(`Door access retention sweep failed for property ${property.id}:`, error);
    }
  }
  return totalDeleted;
}

/**
 * Registers the repeatable sweep job — call once at process startup.
 * `upsertJobScheduler` is itself idempotent by id, so calling this once per
 * server restart (unchanged call-site behaviour) is correct and safe to
 * repeat.
 */
async function scheduleDoorAccessRetentionSweep() {
  await doorAccessRetentionQueue().upsertJobScheduler(
    SWEEP_SCHEDULER_ID,
    { every: SWEEP_INTERVAL_MS },
    { name: SWEEP_JOB_NAME, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } }
  );
}

function startDoorAccessRetentionWorker() {
  return new Worker(
    DOOR_ACCESS_RETENTION_QUEUE,
    async () => {
      await runDoorAccessRetentionSweep();
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  runDoorAccessRetentionSweep,
  scheduleDoorAccessRetentionSweep,
  startDoorAccessRetentionWorker,
  SWEEP_SCHEDULER_ID,
  SWEEP_JOB_NAME,
};
