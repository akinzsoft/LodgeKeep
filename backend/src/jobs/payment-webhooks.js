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
const { refreshOnlineRefunds } = require('../modules/supermarket/paystack-sale');
const { reconcileRefundIntent, refundReconcileConfig } = require('../modules/cashiering/service');
const { workerContext } = require('../modules/tenancy');

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

/**
 * A supermarket online-sale void whose refund Paystack accepted but had not
 * processed yet: re-ask Paystack until it says processed (the original payment
 * becomes REFUNDED) or failed (a manager is belled). One property at a time.
 */
async function runSupermarketRefundSweep() {
  const pending = await knex()('payments')
    .where({ settlement_target: 'supermarket_sale', status: 'PENDING' })
    .whereNotNull('parent_payment_id')
    .whereNotNull('provider_payment_id')
    .distinct('tenant_id', 'property_id');
  let changed = 0;
  for (const { tenant_id: tenantId, property_id: propertyId } of pending) {
    try {
      changed += await refreshOnlineRefunds({ context: workerContext({ tenantId, propertyId }) });
    } catch (error) {
      console.error(`supermarket refund sweep failed for tenant ${tenantId} property ${propertyId}:`, error);
    }
  }
  return changed;
}

/**
 * Refund reconciliation (folio and Register / QR card refunds). A Paystack refund intent still INITIATED or PENDING
 * after a few minutes — accepted but unfinished, or sent with an outcome we never learned — is checked against
 * Paystack's own record and settled when Paystack gives a clear answer. If Paystack cannot be reached or answers
 * unclearly nothing is released; the check is recorded and tried again later. Supermarket online refunds keep their own
 * sweep above. Each intent is its own transaction, so one failure never blocks the rest.
 */
async function runRefundReconciliationSweep(now = new Date()) {
  const { minAgeMinutes } = refundReconcileConfig();
  const cutoff = new Date(now.getTime() - minAgeMinutes * 60_000);
  const due = await knex()('payments as p')
    .leftJoin('refund_reconciliations as r', 'r.payment_id', 'p.id')
    .where('p.provider', 'paystack')
    .whereNotNull('p.parent_payment_id')
    .whereIn('p.status', ['INITIATED', 'PENDING'])
    .whereNot('p.settlement_target', 'supermarket_sale')
    .andWhere('p.created_at', '<=', cutoff)
    .andWhere((builder) => builder.whereNull('r.last_checked_at').orWhere('r.last_checked_at', '<=', cutoff))
    .orderBy('p.id')
    .limit(BATCH_SIZE)
    .select('p.id', 'p.tenant_id', 'p.property_id');
  const results = [];
  for (const row of due) {
    try {
      const owner = await knex()('tenants').where({ id: row.tenant_id }).first('status');
      if (!owner || ['purging', 'purged', 'offboarding'].includes(owner.status)) continue;
      const outcome = await reconcileRefundIntent({ context: workerContext({ tenantId: row.tenant_id, propertyId: row.property_id }), intentId: row.id, source: 'sweep', now });
      results.push({ paymentId: row.id, ...outcome });
    } catch (error) {
      console.error(`refund reconciliation failed for payment ${row.id}:`, error);
      results.push({ paymentId: row.id, error: error.message });
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
      await runSupermarketRefundSweep();
      await runRefundReconciliationSweep();
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  runPaymentWebhookRetrySweep,
  runSupermarketRefundSweep,
  runRefundReconciliationSweep,
  schedulePaymentWebhookSweep,
  startPaymentWebhooksWorker,
  SWEEP_SCHEDULER_ID,
  SWEEP_JOB_NAME,
  BATCH_SIZE,
};
