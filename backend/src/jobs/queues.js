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
 */

const { Queue } = require('bullmq');
const { redisConnection } = require('./redis-connection');

const OUTBOX_DISPATCH_QUEUE = 'outbox-dispatch';
const TRIAL_EXPIRY_QUEUE = 'trial-expiry';

let queue = null;
let trialExpiryQueueInstance = null;

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
}

module.exports = {
  OUTBOX_DISPATCH_QUEUE,
  outboxDispatchQueue,
  TRIAL_EXPIRY_QUEUE,
  trialExpiryQueue,
  __closeQueuesForTesting,
};
