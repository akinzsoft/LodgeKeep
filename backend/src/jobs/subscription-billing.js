'use strict';

/**
 * The subscription-billing sweep's transport — PLAN.md Phase 5,
 * PRODUCT_REQUIREMENTS.md §3.22. Mirrors `src/jobs/trial-expiry.js`'s own
 * split exactly: the per-tenant business logic
 * (`src/modules/billing/service.js`'s `processTenantBillingCycle`) is
 * fully testable against real MySQL with no live queue; this file is only
 * the sweep query plus the BullMQ wiring around it, reusing that file's
 * own hard-won `upsertJobScheduler` lesson (not `Queue#add({repeat})`,
 * a silent v4-era no-op against this codebase's installed BullMQ v6).
 *
 * ── WHICH SUBSCRIPTIONS THIS SWEEP LOOKS AT ──────────────────────────────
 *
 * Every subscription whose `current_period_start` has arrived — a due
 * ordinary renewal, a due first trial-conversion charge, or a due dunning
 * retry (all three are the SAME `processTenantBillingCycle` call; see that
 * function's own header and `subscriptions`' own migration header for why
 * this is deliberately one unified mechanism, not three). A `canceled`
 * subscription is excluded at the SQL level, and `processTenantBillingCycle`
 * itself re-checks the exact same condition inside its own locked
 * transaction, so a subscription whose card was replaced (clearing dunning)
 * or period advanced by a CONCURRENT sweep tick between this query and that
 * transaction is safely re-evaluated, never blindly charged twice.
 *
 * ── WHY THIS FILE READS `subscriptions` VIA `knex()` DIRECTLY ────────────
 *
 * Same reasoning `outbox-dispatcher.js`/`trial-expiry.js`'s own headers
 * already give: "which subscriptions" is a bootstrapping question with no
 * tenant context yet to ask it through — `src/db`'s `knex()` is the one
 * place ARCHITECTURE.md §2 already grants raw-connection ownership for
 * exactly this class of read.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────
 *
 * Every write `processTenantBillingCycle` makes is itself idempotent by
 * construction (see that function's own header) — a crashed or overlapping
 * sweep tick that reprocesses the same tenant either finds no due invoice
 * left to create (`UNIQUE(subscription_id, period_start)`), no dunning
 * attempt yet due (the pure `isDunningAttemptDue` check), or a payment
 * already resolved (`applyChargeOutcome`'s conditional UPDATE). Proven
 * under genuine concurrent execution in
 * `tests/jobs/subscription-billing-sweep.test.js`, not merely asserted.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { subscriptionBillingQueue, SUBSCRIPTION_BILLING_QUEUE } = require('./queues');
const { knex } = require('../db');
const { processTenantBillingCycle } = require('../modules/billing/service');

const SWEEP_JOB_NAME = 'sweep';
const SWEEP_INTERVAL_MS = Number(process.env.SUBSCRIPTION_BILLING_SWEEP_INTERVAL_MS || 60_000);
const SWEEP_SCHEDULER_ID = 'subscription-billing-sweep';

/** One tenant's billing cycle per iteration, each its own set of short transactions (see service.js) — a failure or a real gateway error on one tenant must never block the rest. */
async function runSubscriptionBillingSweep(now = new Date()) {
  const due = await knex()('subscriptions')
    .whereNot({ status: 'canceled' })
    .andWhere('current_period_start', '<=', now)
    .select('tenant_id');

  const results = [];
  for (const row of due) {
    try {
      const outcome = await processTenantBillingCycle({ tenantId: row.tenant_id, now });
      results.push({ tenantId: row.tenant_id, ...outcome });
    } catch (error) {
      console.error(`subscription-billing sweep failed for tenant ${row.tenant_id}:`, error);
      results.push({ tenantId: row.tenant_id, action: 'error', error: error.message });
    }
  }
  return results;
}

/**
 * Registers the repeatable sweep job — call once at process startup.
 * `upsertJobScheduler` is itself idempotent by id, so calling this once
 * per server restart (unchanged call-site behaviour) is correct and safe
 * to repeat.
 */
async function scheduleSubscriptionBillingSweep() {
  await subscriptionBillingQueue().upsertJobScheduler(SWEEP_SCHEDULER_ID, { every: SWEEP_INTERVAL_MS }, { name: SWEEP_JOB_NAME, data: {} });
}

function startSubscriptionBillingWorker() {
  return new Worker(
    SUBSCRIPTION_BILLING_QUEUE,
    async () => {
      await runSubscriptionBillingSweep();
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  runSubscriptionBillingSweep,
  scheduleSubscriptionBillingSweep,
  startSubscriptionBillingWorker,
  SWEEP_SCHEDULER_ID,
  SWEEP_JOB_NAME,
};
