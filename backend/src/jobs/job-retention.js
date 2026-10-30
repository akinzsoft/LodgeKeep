'use strict';

/**
 * Explicit retention for every BullMQ queue (production incident: queues with no
 * `removeOnComplete` kept every completed sweep job forever, ~57k keys per queue
 * after 12 days, and Redis (maxmemory 256mb, noeviction) started refusing writes).
 *
 * Applied once, as each queue's `defaultJobOptions` (`queues.js`), so a queue and
 * the jobs a scheduler creates for it can never be left unbounded by forgetting an
 * option at one `add()` call. Nothing relies on retained jobs: no job uses a
 * deterministic `jobId`, and webhook dedupe lives in MySQL
 * (`payment_webhook_events` UNIQUE(provider, provider_event_id)).
 *
 * Failed jobs are kept longer than completed ones (they are the evidence);
 * payment-webhooks keeps them longest.
 */

const HOUR = 3600;
const DAY = 24 * HOUR;

const DEFAULT_RETENTION = Object.freeze({
  removeOnComplete: Object.freeze({ age: HOUR, count: 1000 }),
  removeOnFail: Object.freeze({ age: 14 * DAY, count: 5000 }),
});

const PAYMENT_WEBHOOKS_RETENTION = Object.freeze({
  removeOnComplete: DEFAULT_RETENTION.removeOnComplete,
  removeOnFail: Object.freeze({ age: 30 * DAY, count: 10000 }),
});

/** Per-queue-name overrides; every other queue uses the default. */
const RETENTION_BY_QUEUE = Object.freeze({
  'payment-webhooks': PAYMENT_WEBHOOKS_RETENTION,
});

function retentionFor(queueName) {
  return RETENTION_BY_QUEUE[queueName] ?? DEFAULT_RETENTION;
}

/** The second argument for `new Queue(name, ...)`. */
function queueOptions(queueName, connection) {
  const { removeOnComplete, removeOnFail } = retentionFor(queueName);
  return { connection, defaultJobOptions: { removeOnComplete: { ...removeOnComplete }, removeOnFail: { ...removeOnFail } } };
}

module.exports = { DEFAULT_RETENTION, PAYMENT_WEBHOOKS_RETENTION, retentionFor, queueOptions };
