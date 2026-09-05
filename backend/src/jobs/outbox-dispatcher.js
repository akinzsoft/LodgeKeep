'use strict';

/**
 * The outbox dispatcher's transport — ARCHITECTURE.md §13/§14, PLAN.md
 * Phase 3. The real dispatch LOGIC (render → send → log → retry/backoff →
 * fail) lives in `src/modules/notifications/service.js`'s
 * `dispatchPendingOutboxEventsForTenant`, fully testable against real MySQL
 * with no live queue; this file is only the BullMQ wiring around it.
 *
 * ── TWO TRIGGERS, ONE DISPATCH FUNCTION ─────────────────────────────────
 *
 * 1. **Reactive**: `enqueueOutboxDispatch({tenantId, propertyId})` is called
 *    by a controller right after its business transaction commits (e.g.
 *    `reservations` controller's `runMutation`, after `withIdempotency`
 *    resolves) — cheap, near-instant, and uses the `tenantId` the request
 *    already has (ARCHITECTURE.md §14: "every payload carries tenant_id").
 * 2. **Sweep**: `runOutboxDispatchSweep()` is the durable safety net for
 *    ARCHITECTURE.md §13's own scenario — "if [the triggering process]
 *    crashes after committing... the dispatch worker picks it up
 *    independently whenever it next runs" — which the reactive trigger
 *    alone cannot guarantee (a crash between commit and the enqueue call
 *    would lose it). Scheduled as a repeatable BullMQ job.
 *
 * ── WHY THIS FILE READS `tenants` DIRECTLY ──────────────────────────────
 *
 * The sweep needs to answer "which tenants have pending work" before any
 * tenant-scoped context can exist to ask them — the same bootstrapping
 * problem `src/auth/tenant-resolution.js` solves for a Host header via
 * `db.bootstrap()`. There is no equivalent "list every tenant" entry point
 * on the scoped accessor (by design — SECURITY.md §2), and this genuinely
 * is not tenant DATA access, only infrastructure scheduling bookkeeping —
 * `id`/`status` off one platform-wide table, nothing a tenant's own staff
 * could not already infer from their own account working. `src/db`'s
 * `knex()` is the one place ARCHITECTURE.md §2 already grants raw-connection
 * ownership, so this file uses that directly rather than inventing a second
 * escape hatch. Every OTHER read/write in this file and in
 * `dispatchPendingOutboxEventsForTenant` goes through the scoped accessor
 * exactly as normal.
 *
 * ── WHAT IS NOT BUILT ────────────────────────────────────────────────────
 *
 * BullMQ's own per-job retry/backoff covers a failed ENQUEUE; a failed SEND
 * inside a run is retried by `dispatchPendingOutboxEventsForTenant`'s own
 * `attempt_count` logic instead (the row stays `pending` and is picked up
 * again by the next sweep or reactive trigger) — the two retry mechanisms
 * are deliberately layered, not merged into one. No live BullMQ integration
 * test exists in this codebase for ANY job yet (Redis/BullMQ have been
 * "installed, not wired up" since Phase 0) — the dispatch logic itself has
 * real, direct test coverage; this transport layer does not, the same
 * boundary every other untested-transport/tested-logic split in this
 * codebase draws.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { outboxDispatchQueue, OUTBOX_DISPATCH_QUEUE } = require('./queues');
const { knex } = require('../db');
const { workerContext } = require('../modules/tenancy');
const { dispatchPendingOutboxEventsForTenant } = require('../modules/notifications/service');

const SWEEP_JOB_NAME = 'sweep';
const DISPATCH_JOB_NAME = 'dispatch';
const SWEEP_INTERVAL_MS = 60_000;

/** Called right after a business transaction commits — see file header. */
async function enqueueOutboxDispatch({ tenantId, propertyId }) {
  await outboxDispatchQueue().add(
    DISPATCH_JOB_NAME,
    { tenantId, propertyId },
    { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 100 }
  );
}

/** The durable safety net — one dispatch run per active tenant. */
async function runOutboxDispatchSweep() {
  const tenants = await knex()('tenants').where({ status: 'active' }).select('id');
  for (const tenant of tenants) {
    await dispatchPendingOutboxEventsForTenant({ context: workerContext({ tenantId: tenant.id, propertyId: null }) });
  }
  return tenants.length;
}

/** Registers the repeatable sweep job — call once at process startup. */
async function scheduleOutboxSweep() {
  await outboxDispatchQueue().add(SWEEP_JOB_NAME, {}, { repeat: { every: SWEEP_INTERVAL_MS }, jobId: 'outbox-sweep' });
}

/** The worker process — one job handler for both trigger types. */
function startOutboxWorker() {
  return new Worker(
    OUTBOX_DISPATCH_QUEUE,
    async (job) => {
      if (job.name === SWEEP_JOB_NAME) {
        await runOutboxDispatchSweep();
        return;
      }
      const context = workerContext({ tenantId: job.data.tenantId, propertyId: job.data.propertyId });
      await dispatchPendingOutboxEventsForTenant({ context });
    },
    { connection: redisConnection() }
  );
}

module.exports = { enqueueOutboxDispatch, runOutboxDispatchSweep, scheduleOutboxSweep, startOutboxWorker };
