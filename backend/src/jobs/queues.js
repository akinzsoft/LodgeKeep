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
 */

const { Queue } = require('bullmq');
const { redisConnection } = require('./redis-connection');

const OUTBOX_DISPATCH_QUEUE = 'outbox-dispatch';
const TRIAL_EXPIRY_QUEUE = 'trial-expiry';
const SUBSCRIPTION_BILLING_QUEUE = 'subscription-billing';
const TENANT_DATA_EXPORT_QUEUE = 'tenant-data-export';

let queue = null;
let trialExpiryQueueInstance = null;
let subscriptionBillingQueueInstance = null;
let tenantDataExportQueueInstance = null;

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
  __closeQueuesForTesting,
};
