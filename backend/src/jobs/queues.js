'use strict';

/**
 * BullMQ queue definitions — ARCHITECTURE.md §14: "one queue per job
 * category, not one global queue."
 *
 * `outbox-dispatch` and `trial-expiry` exist this pass. ARCHITECTURE.md §14
 * also names `night-audit`, `reports`, `imports`, and `exports` — none of
 * those has a real job category behind it yet (Night Audit runs on-demand
 * via an authenticated request, not a schedule; Reporting exports and Data
 * Migration are later-phase work), so none is created here. Adding an
 * empty queue nothing ever enqueues to is exactly the "not preemptively
 * for everything" case ARCHITECTURE.md §14 itself warns against. `trial-expiry`
 *
 * `night-audit-overdue` (gap closure, user-requested — "if night audit have
 * not been run at the appropriate time it shld send notification including
 * mail") is its OWN queue, deliberately named distinctly from the
 * still-unbuilt `night-audit` category above — running the audit itself
 * remains on-demand, unchanged; this queue only ever checks whether it's
 * overdue and alerts. Its own queue for the same recurring reason every
 * periodic sweep here already gets one: a slow overdue check at one
 * property must never delay the outbox, trial-expiry, or any other sweep's
 * own work.
 * is its own queue, separate from `outbox-dispatch`, for the identical
 * reason `email` is named as its own category there: a stuck/slow sweep in
 * one job class must never back up the other's dispatch work.
 *
 * `subscription-billing` (PLAN.md Phase 5) is a fourth, for the same
 * reason again: a slow real-gateway call while charging one tenant's
 * subscription must never delay the trial-expiry sweep or the outbox's
 * own dispatch work, and vice versa.
 *
 * `tenant-data-export` (PLAN.md Phase 5, tenant offboarding) is a fifth,
 * one-off only — no scheduler ever calls `upsertJobScheduler` against it
 * (`src/jobs/tenant-data-export.js`'s own header), only the reactive
 * `enqueueTenantDataExportJob`. A slow multi-table export bundling a
 * large tenant's whole history must never delay any of the other four
 * queues' own work, and vice versa.
 *
 * `imports` (PLAN.md Phase 5's last unbuilt bullet, data migration,
 * PRODUCT_REQUIREMENTS.md §3.20) is the sixth — ARCHITECTURE.md §14 named
 * this queue from the start; it finally has a real job category behind
 * it. One-off/reactive only, the same shape `tenant-data-export` already
 * established (no scheduler, only `enqueueDataImportJob` right after an
 * operator confirms commit) — a slow row-by-row import committing
 * thousands of historical reservations must never delay any other queue's
 * work, and vice versa.
 *
 * `door-access-retention` (PLAN.md Phase 7 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.23's legal/privacy note) is its own queue for the same recurring
 * reason every periodic sweep above already gets one — a slow purge pass
 * at one property must never delay the outbox, trial-expiry, or any other
 * sweep's own work. Runs once daily (`src/jobs/door-access-retention.js`),
 * far coarser than every other periodic sweep here — an age-based PII
 * purge has no user waiting on it the way a billing charge or a bell
 * notification does; daily is standard practice for this class of job and
 * there is no correctness reason to run it more often.
 *
 * `expense-schedules` (expense tracking, greenfield feature) is its own
 * eighth queue for the identical reason — a slow recurring-expense
 * auto-post pass at one property must never delay any other queue's own
 * work, and vice versa. Runs once daily (`src/jobs/expense-schedules.js`):
 * no user is waiting on a rent/salary auto-post the way they wait on a
 * bell notification.
 */

const { Queue } = require('bullmq');
const { redisConnection } = require('./redis-connection');

const OUTBOX_DISPATCH_QUEUE = 'outbox-dispatch';
const TRIAL_EXPIRY_QUEUE = 'trial-expiry';
const SUBSCRIPTION_BILLING_QUEUE = 'subscription-billing';
const TENANT_DATA_EXPORT_QUEUE = 'tenant-data-export';
const DATA_IMPORT_QUEUE = 'imports';
const NOTIFICATIONS_SWEEP_QUEUE = 'notifications-sweep';
const DOOR_ACCESS_RETENTION_QUEUE = 'door-access-retention';
const EXPENSE_SCHEDULES_QUEUE = 'expense-schedules';
const NIGHT_AUDIT_OVERDUE_QUEUE = 'night-audit-overdue';

let queue = null;
let trialExpiryQueueInstance = null;
let subscriptionBillingQueueInstance = null;
let tenantDataExportQueueInstance = null;
let dataImportQueueInstance = null;
let notificationsSweepQueueInstance = null;
let doorAccessRetentionQueueInstance = null;
let expenseSchedulesQueueInstance = null;
let nightAuditOverdueQueueInstance = null;

function outboxDispatchQueue() {
  if (!queue) {
    queue = new Queue(OUTBOX_DISPATCH_QUEUE, { connection: redisConnection() });
  }
  return queue;
}

function trialExpiryQueue() {
  if (!trialExpiryQueueInstance) {
    trialExpiryQueueInstance = new Queue(TRIAL_EXPIRY_QUEUE, { connection: redisConnection() });
  }
  return trialExpiryQueueInstance;
}

function subscriptionBillingQueue() {
  if (!subscriptionBillingQueueInstance) {
    subscriptionBillingQueueInstance = new Queue(SUBSCRIPTION_BILLING_QUEUE, { connection: redisConnection() });
  }
  return subscriptionBillingQueueInstance;
}

function tenantDataExportQueue() {
  if (!tenantDataExportQueueInstance) {
    tenantDataExportQueueInstance = new Queue(TENANT_DATA_EXPORT_QUEUE, { connection: redisConnection() });
  }
  return tenantDataExportQueueInstance;
}

function dataImportQueue() {
  if (!dataImportQueueInstance) {
    dataImportQueueInstance = new Queue(DATA_IMPORT_QUEUE, { connection: redisConnection() });
  }
  return dataImportQueueInstance;
}

function notificationsSweepQueue() {
  if (!notificationsSweepQueueInstance) {
    notificationsSweepQueueInstance = new Queue(NOTIFICATIONS_SWEEP_QUEUE, { connection: redisConnection() });
  }
  return notificationsSweepQueueInstance;
}

function doorAccessRetentionQueue() {
  if (!doorAccessRetentionQueueInstance) {
    doorAccessRetentionQueueInstance = new Queue(DOOR_ACCESS_RETENTION_QUEUE, { connection: redisConnection() });
  }
  return doorAccessRetentionQueueInstance;
}

function expenseSchedulesQueue() {
  if (!expenseSchedulesQueueInstance) {
    expenseSchedulesQueueInstance = new Queue(EXPENSE_SCHEDULES_QUEUE, { connection: redisConnection() });
  }
  return expenseSchedulesQueueInstance;
}

function nightAuditOverdueQueue() {
  if (!nightAuditOverdueQueueInstance) {
    nightAuditOverdueQueueInstance = new Queue(NIGHT_AUDIT_OVERDUE_QUEUE, { connection: redisConnection() });
  }
  return nightAuditOverdueQueueInstance;
}

/** Test-only teardown — BullMQ's `Queue` holds its own connection handles beyond the shared `redisConnection()` instance, and both must close for the process to exit without `--forceExit`. */
async function __closeQueuesForTesting() {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (trialExpiryQueueInstance) {
    await trialExpiryQueueInstance.close();
    trialExpiryQueueInstance = null;
  }
  if (subscriptionBillingQueueInstance) {
    await subscriptionBillingQueueInstance.close();
    subscriptionBillingQueueInstance = null;
  }
  if (tenantDataExportQueueInstance) {
    await tenantDataExportQueueInstance.close();
    tenantDataExportQueueInstance = null;
  }
  if (dataImportQueueInstance) {
    await dataImportQueueInstance.close();
    dataImportQueueInstance = null;
  }
  if (notificationsSweepQueueInstance) {
    await notificationsSweepQueueInstance.close();
    notificationsSweepQueueInstance = null;
  }
  if (doorAccessRetentionQueueInstance) {
    await doorAccessRetentionQueueInstance.close();
    doorAccessRetentionQueueInstance = null;
  }
  if (expenseSchedulesQueueInstance) {
    await expenseSchedulesQueueInstance.close();
    expenseSchedulesQueueInstance = null;
  }
  if (nightAuditOverdueQueueInstance) {
    await nightAuditOverdueQueueInstance.close();
    nightAuditOverdueQueueInstance = null;
  }
}

module.exports = {
  OUTBOX_DISPATCH_QUEUE,
  outboxDispatchQueue,
  TRIAL_EXPIRY_QUEUE,
  trialExpiryQueue,
  SUBSCRIPTION_BILLING_QUEUE,
  subscriptionBillingQueue,
  TENANT_DATA_EXPORT_QUEUE,
  tenantDataExportQueue,
  DATA_IMPORT_QUEUE,
  dataImportQueue,
  NOTIFICATIONS_SWEEP_QUEUE,
  notificationsSweepQueue,
  DOOR_ACCESS_RETENTION_QUEUE,
  doorAccessRetentionQueue,
  EXPENSE_SCHEDULES_QUEUE,
  expenseSchedulesQueue,
  NIGHT_AUDIT_OVERDUE_QUEUE,
  nightAuditOverdueQueue,
  __closeQueuesForTesting,
};
