'use strict';

/**
 * The payment-webhook retry sweep — the safety net that guarantees a persisted
 * gateway webhook event is never stranded. Security audit fix: both Paystack
 * webhooks now verify the event against Paystack's own record, and that
 * verification can be unavailable (Paystack timing out, rate-limiting, or a
 * misconfigured key) or the transaction can still be in flight.
 *
 * The DB ROW is the durable unit of work, not a queue message. Each signed
 * event is persisted first (`src/shared/webhook-events.js`) with a
 * `next_attempt_at`; the request path makes one inline attempt, and anything
 * left unfinished (`outcome IS NULL`) is picked up here. Redis is only the
 * scheduler (ARCHITECTURE.md §14): losing it delays a retry, it never loses an
 * event or a payment. Paystack's own redeliveries are a second, independent
 * trigger into the same idempotent processors.
 *
 * Mirrors `subscription-billing.js` exactly: the sweep query is plain
 * `knex()` (a bootstrapping question with no tenant context yet, the same
 * exception `outbox-dispatcher.js`/`trial-expiry.js` document), and the
 * schedule uses `upsertJobScheduler` (not `Queue#add({repeat})`, a silent
 * no-op against this codebase's BullMQ v6).
 *
 * IDEMPOTENCY. The processors decide an event exactly once
 * (`finalizeWebhookEvent` is conditional on `outcome IS NULL`) and their state
 * transitions are conditional UPDATEs, so an overlapping sweep tick, an inline
 * attempt and a Paystack redelivery racing on one event apply it once.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { paymentWebhooksQueue, PAYMENT_WEBHOOKS_QUEUE } = require('./queues');
const { knex } = require('../db');
const { processPaymentWebhookEvent } = require('../modules/cashiering/service');
const { processBillingWebhookEvent } = require('../modules/billing/service');

const SWEEP_JOB_NAME = 'sweep';
const SWEEP_INTERVAL_MS = Number(process.env.PAYMENT_WEBHOOK_SWEEP_INTERVAL_MS || 60_000);
const SWEEP_SCHEDULER_ID = 'payment-webhook-sweep';
/** Events examined per table per tick — a backlog drains over successive ticks instead of one long one. */
const BATCH_SIZE = 100;

const SOURCES = [
  { table: 'payment_webhook_events', source: 'guest', process: processPaymentWebhookEvent },
  { table: 'subscription_webhook_events', source: 'billing', process: processBillingWebhookEvent },
];

/** Processes every signed, undecided event whose retry time has arrived. One event's failure never blocks the rest. */
async function runPaymentWebhookRetrySweep(now = new Date()) {
  const results = [];
  for (const { table, source, process } of SOURCES) {
    const due = await knex()(table)
      .where({ verified: 1 })
      .whereNull('outcome')
      .whereNotNull('next_attempt_at')
      .andWhere('next_attempt_at', '<=', now)
      .orderBy('id')
      .limit(BATCH_SIZE)
      .select('id');

    for (const row of due) {
      try {
        const { outcome } = await process({ eventId: row.id, now });
        results.push({ source, eventId: row.id, outcome });
      } catch (error) {
        console.error(`payment-webhook sweep failed for ${source} event ${row.id}:`, error);
        results.push({ source, eventId: row.id, outcome: 'error', error: error.message });
      }
    }
  }
  return results;
}

/** Registers the repeatable sweep — call once at process startup. Idempotent by scheduler id. */
async function schedulePaymentWebhookSweep() {
  await paymentWebhooksQueue().upsertJobScheduler(SWEEP_SCHEDULER_ID, { every: SWEEP_INTERVAL_MS }, { name: SWEEP_JOB_NAME, data: {} });
}

function startPaymentWebhooksWorker() {
  return new Worker(
    PAYMENT_WEBHOOKS_QUEUE,
    async () => {
      await runPaymentWebhookRetrySweep();
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  runPaymentWebhookRetrySweep,
  schedulePaymentWebhookSweep,
  startPaymentWebhooksWorker,
  SWEEP_SCHEDULER_ID,
  SWEEP_JOB_NAME,
  BATCH_SIZE,
};
