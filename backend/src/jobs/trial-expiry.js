'use strict';

/**
 * The trial-expiry sweep's transport — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md
 * §3.22 ("clear expiry behaviour... a PMS holding live reservations cannot
 * simply lock out a hotel mid-service"). Mirrors `src/jobs/outbox-dispatcher.js`'s
 * own split exactly: the dispatch LOGIC (`runTrialExpirySweep`) is fully
 * testable against real MySQL with no live queue; this file is only the
 * BullMQ wiring around it, and reuses that file's own hard-won lesson —
 * `upsertJobScheduler`, not `Queue#add({repeat})`, which is a silent v4-era
 * no-op against this codebase's installed BullMQ v6.
 *
 * ── WHAT COUNTS AS "EXPIRED" ─────────────────────────────────────────────
 *
 * A `trial`-status tenant whose `trial_ends_at` has passed. There is no
 * separate "trial_expired" status (`src/shared/tenant-lifecycle.js`'s own
 * header explains why) — this sweep transitions it straight to `suspended`,
 * the same status non-payment produces, so both causes share one
 * enforcement mechanism and one reactivation path.
 * `src/shared/tenant-lifecycle.js`'s `isTenantWriteBlocked` ALSO checks
 * `trial_ends_at` directly, independent of whether this sweep has run yet —
 * so a lapsed trial is enforced immediately, at the very next request,
 * never waiting up to `SWEEP_INTERVAL_MS` for this job to catch up. This
 * sweep's own job is to make that lapse a real, queryable, auditable fact
 * (`tenants.status`, an `audit_log` row) rather than only a live-computed
 * one — the platform console's tenant list needs to be able to show
 * "suspended" without recomputing the trial math on every read.
 *
 * ── WHY THIS FILE READS `tenants` DIRECTLY ──────────────────────────────
 *
 * Same reasoning `outbox-dispatcher.js`'s own header already gives for its
 * sweep: "which tenants" is a bootstrapping question with no tenant context
 * yet to ask it through. `src/db`'s `knex()` is the one place
 * ARCHITECTURE.md §2 already grants raw-connection ownership for exactly
 * this.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────
 *
 * The transition itself is a conditional UPDATE (`WHERE status = 'trial'`),
 * the same "affected-row-count is the proof, not a separate read" shape
 * `platform/service.js`'s own `suspendTenant`/`reactivateTenant` and
 * `endImpersonation` already use — a tenant already transitioned (by this
 * sweep, a concurrent run of it, or a manual platform suspend in between)
 * simply affects zero rows on a repeat pass, never a duplicate transition
 * or a duplicate audit row. Proven under genuine concurrent execution in
 * `tests/jobs/trial-expiry.test.js`, not merely asserted.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { trialExpiryQueue, TRIAL_EXPIRY_QUEUE } = require('./queues');
const { knex, scopedDb } = require('../db');
const { workerContext } = require('../modules/tenancy');
const { recordAuditEntry } = require('../audit');

const SWEEP_JOB_NAME = 'sweep';
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_SCHEDULER_ID = 'trial-expiry-sweep';

/**
 * One conditional UPDATE per lapsed trial, each its own transaction — a
 * failure on one tenant must never block the rest.
 *
 * PLAN.md Phase 5 (subscription billing): a tenant that already has a
 * `subscriptions` row (a payment method on file, whether or not its first
 * charge has succeeded yet) is deliberately EXCLUDED here, regardless of
 * that row's own status. Once a subscription exists, `src/jobs/
 * subscription-billing.js`'s own sweep owns this tenant's status
 * transitions entirely — a successful first charge converts trial ->
 * active (`billing/service.js`'s `applyChargeOutcome`), and an exhausted
 * dunning schedule suspends it. Without this exclusion, a trial lapsing on
 * the exact day its first billing attempt is due would race this sweep
 * against that one: this sweep could suspend the tenant for a merely
 * elapsed trial in the same moment the billing sweep is legitimately
 * converting it, discarding a real, in-progress payment relationship for
 * no reason other than unlucky timing.
 */
async function runTrialExpirySweep() {
  const now = new Date();
  const lapsed = await knex()('tenants')
    .where({ status: 'trial' })
    .andWhere('trial_ends_at', '<=', now)
    .whereNotExists(function excludeBilled() {
      this.select('*').from('subscriptions').whereRaw('subscriptions.tenant_id = tenants.id');
    })
    .select('id');

  let transitioned = 0;
  for (const tenant of lapsed) {
    const db = scopedDb().for(workerContext({ tenantId: tenant.id }));
    const updated = await db.transaction(async (trx) => {
      const affected = await trx.table('tenants').where({ status: 'trial' }).update({ status: 'suspended' });
      if (affected > 0) {
        await recordAuditEntry(trx, {
          entityType: 'tenants',
          entityId: tenant.id,
          action: 'trial_expired',
          source: 'job',
          beforeState: { status: 'trial' },
          afterState: { status: 'suspended' },
        });
      }
      return affected;
    });
    if (updated > 0) transitioned += 1;
  }
  return transitioned;
}

/**
 * Registers the repeatable sweep job — call once at process startup.
 * `upsertJobScheduler` is itself idempotent by id, so calling this once per
 * server restart (unchanged call-site behaviour) is correct and safe to
 * repeat.
 */
async function scheduleTrialExpirySweep() {
  await trialExpiryQueue().upsertJobScheduler(SWEEP_SCHEDULER_ID, { every: SWEEP_INTERVAL_MS }, { name: SWEEP_JOB_NAME, data: {} });
}

function startTrialExpiryWorker() {
  return new Worker(
    TRIAL_EXPIRY_QUEUE,
    async () => {
      await runTrialExpirySweep();
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  runTrialExpirySweep,
  scheduleTrialExpirySweep,
  startTrialExpiryWorker,
  SWEEP_SCHEDULER_ID,
  SWEEP_JOB_NAME,
};
