'use strict';

/**
 * BullMQ queue definitions — ARCHITECTURE.md §14: "one queue per job
 * category, not one global queue."
 *
 * Only `outbox-dispatch` exists this pass. ARCHITECTURE.md §14 also names
 * `night-audit`, `reports`, `imports`, `exports`, and `email` (kept separate
 * from `outbox-dispatch` so an email-provider outage can't back up other
 * dispatch work) — none of those has a real job category behind it yet
 * (Night Audit, Reporting exports, Data Migration are all later-phase
 * work), so none is created here. Adding an empty queue nothing ever
 * enqueues to is exactly the "not preemptively for everything" case
 * ARCHITECTURE.md §14 itself warns against.
 */

const { Queue } = require('bullmq');
const { redisConnection } = require('./redis-connection');

const OUTBOX_DISPATCH_QUEUE = 'outbox-dispatch';

let queue = null;

function outboxDispatchQueue() {
  if (!queue) {
    queue = new Queue(OUTBOX_DISPATCH_QUEUE, { connection: redisConnection() });
  }
  return queue;
}

/** Test-only teardown — BullMQ's `Queue` holds its own connection handles beyond the shared `redisConnection()` instance, and both must close for the process to exit without `--forceExit`. */
async function __closeQueuesForTesting() {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

module.exports = { OUTBOX_DISPATCH_QUEUE, outboxDispatchQueue, __closeQueuesForTesting };
