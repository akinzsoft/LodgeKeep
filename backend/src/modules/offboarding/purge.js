'use strict';

/**
 * The tenant retention-expiry purge — the deletion `retention_expires_at` has
 * promised since the offboarding work shipped (security audit finding: "Offboarding
 * sets retention_expires_at but nothing acts on it"). Confirmed with the user:
 *
 *   - hard-delete the tenant's data; KEEP the `tenants` tombstone (slug reserved)
 *     and Planmsys's own billing records (see `purge-plan.js`)
 *   - purge `audit_log`/`auth_events` too, then write ONE final `tenant_purged` row
 *   - purge only when a COMPLETED export made after the offboarding request exists
 *     and its file is on disk; otherwise block, re-queue the export, and surface it
 *   - fully AUTOMATIC (a scheduled sweep, `src/jobs/tenant-purge.js`), OFF unless
 *     `TENANT_PURGE_ENABLED=true`
 *   - warn the tenant's admins at T-7d and T-1d, and make a fresh export at T-7d
 *
 * ── STATE MACHINE ────────────────────────────────────────────────────────
 *
 *   offboarding ──claim──▶ purging ──(two clean verification passes)──▶ purged
 *
 * `tenants.status` is the resume marker. `tenant_purges` holds everything else:
 * the lease, the blocked reason, per-table counts, the warning flags.
 *
 * ── THE CLAIM IS ONE CONDITIONAL UPDATE ──────────────────────────────────
 *
 *   UPDATE tenants SET status='purging'
 *    WHERE id=? AND status='offboarding' AND retention_expires_at <= now
 *
 * with the affected-row count as the proof (ARCHITECTURE.md §5), never
 * read-then-write. `reactivateTenant` is a conditional UPDATE on the same row, so
 * the two serialize on the row lock: reactivation committing first clears the
 * deadline and the claim affects zero rows; the claim committing first makes
 * reactivation affect zero rows and raise a 409. Nothing else has happened when the
 * claim loses. The deadline in the WHERE is also what stops a reactivate-then-
 * re-offboard in between from being purged: the re-offboard sets a NEW, future
 * deadline.
 *
 * Lock order matches billing's (`subscriptions` before `tenants`), so the claim can
 * never deadlock with `applyChargeOutcome`.
 *
 * The claim also ENDS ACCESS IMMEDIATELY — sessions revoked, users and guest
 * accounts deactivated, impersonation ended, custom domains removed, the
 * subscription cancelled and its stored card token cleared — so access is gone at
 * the claim even though the deletion itself takes several ticks.
 *
 * ── DELETION IS RESUMABLE, CHUNKED AND IDEMPOTENT ────────────────────────
 *
 * ~85 tables cannot be one transaction. Each chunk of each table is its own
 * statement; re-running deletes nothing already gone. `purging` is the resume
 * marker, so a crash simply continues on the next tick. The tenant only becomes
 * `purged` after TWO consecutive verification passes find nothing left — the gap
 * between them lets an in-flight job that was mid-write at the claim finish.
 *
 * ── SAFEGUARDS FOR A DESTRUCTIVE JOB RUNNING UNATTENDED ──────────────────
 *
 *   TENANT_PURGE_ENABLED         must be exactly 'true' (checked where the worker is
 *                                registered, `src/server.js`)
 *   TENANT_PURGE_MAX_PER_TICK    tenants STARTED or RESUMED per sweep (default 1)
 *   TENANT_PURGE_DRY_RUN=true    evaluate, log counts, write nothing
 *   the export gate, and a minimum retention window (an accidental or edited
 *   date can never cause an instant purge)
 *   fail-closed table classification: the sweep refuses to run if any tenant-owned
 *   table has no purge decision
 *
 * NO BACKUPS EXIST for this stack. Enabling the job in production without a verified
 * backup means a wrong deadline is unrecoverable.
 */

const os = require('os');
const { randomUUID } = require('crypto');
const { scopedDb, knex } = require('../../db');
const { systemContext, workerContext } = require('../tenancy');
const { recordAuditEntry } = require('../../audit');
const { writeOutboxEvent } = require('../../shared/outbox');
const { enqueueOutboxDispatch } = require('../../jobs/outbox-dispatcher');
const { enqueueTenantDataExportJob } = require('../../jobs/tenant-data-export');
const { buildPurgeSteps, classifyAllTables, CLEARED_TABLES } = require('./purge-plan');
const { deleteFilesForRows, deleteExportFilesForTenant, emptyTally, addTallies } = require('./purge-files');
const { createExportAttempt } = require('./service');
const fs = require('fs');

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEAN_PASSES_REQUIRED = 2;
const LEASE_MS = 5 * 60 * 1000;
const EXPORT_STALE_MS = 6 * 60 * 60 * 1000;
/** An export request still pending after this long lost its queue message; it is enqueued again (the job claims the row conditionally, so a duplicate is harmless). */
const EXPORT_REENQUEUE_MS = 60 * 60 * 1000;
/** The final warning must have been out at least this long before deletion starts (a hair under 24h so a normal T-1d warning, sent as the last day begins, is not held back). */
const WARNING_GRACE_MS = 23 * 60 * 60 * 1000;
const RETRYABLE_LOCK_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/** Read at call time so a test (or an operator) can change them without a restart. */
/**
 * A safeguard must not switch itself off on a typo: `Number('abc')` is NaN, and every
 * comparison against NaN is false, which would silently disable the minimum-retention
 * gate and the per-tick cap. Anything that is not a positive whole number falls back
 * to the default.
 */
function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`[tenant-purge] ${name}="${raw}" is not a positive whole number; using ${fallback}.`);
    return fallback;
  }
  return value;
}

const config = {
  minRetentionDays: () => positiveInt('TENANT_PURGE_MIN_RETENTION_DAYS', 7),
  maxPerTick: () => positiveInt('TENANT_PURGE_MAX_PER_TICK', 1),
  tickBudgetMs: () => positiveInt('TENANT_PURGE_TICK_BUDGET_MS', 240_000),
  dryRun: () => process.env.TENANT_PURGE_DRY_RUN === 'true',
};

/** Exposed so a test can prove a retry is not silently hiding a deadlock. */
const retryStats = { lockRetries: 0 };

const steps = buildPurgeSteps();
const planTables = new Set(steps.map((step) => step.table));

const platformDb = () => scopedDb().for(systemContext()).platform();
const tenantDb = (tenantId) => scopedDb().for(workerContext({ tenantId }));
const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
const sameInstant = (a, b) => Boolean(a) && Boolean(b) && new Date(a).getTime() === new Date(b).getTime();

// ---------------------------------------------------------------------
// The one door to a table: every purge query goes through here
// ---------------------------------------------------------------------

/**
 * A query over one plan table, scoped to ONE tenant.
 *
 * A PLATFORM_SCOPED table gets NO predicate from the accessor, so a bare delete
 * would remove every tenant's rows. This helper always adds `where({tenant_id})` for
 * those and then asserts the predicate and its binding really reached the compiled
 * SQL. A table that is not in the plan is refused outright.
 */
function purgeQuery(db, step, tenantId) {
  if (!planTables.has(step.table)) throw new Error(`purge: "${step.table}" is not in the purge plan.`);

  if (step.access === 'platform') {
    const query = db.platform().table(step.table).where({ tenant_id: tenantId });
    const { sql, bindings } = query.toSQL();
    if (!sql.includes('`tenant_id`') || !bindings.some((binding) => String(binding) === String(tenantId))) {
      throw new Error(`purge: refusing to query PLATFORM_SCOPED "${step.table}" without a tenant_id predicate.`);
    }
    return query;
  }
  if (step.access === 'property') return db.acrossProperties().table(step.table);
  return db.table(step.table);
}

/** Retries a statement that lost a lock race a few times, so a transient deadlock never aborts a tick. */
async function withLockRetry(fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!RETRYABLE_LOCK_ERRORS.has(error.code) || attempt >= 3) throw error;
      retryStats.lockRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 200)));
    }
  }
}

// ---------------------------------------------------------------------
// tenant_purges bookkeeping
// ---------------------------------------------------------------------

/**
 * The tenant's purge row, created on first sight. It describes ONE offboarding
 * cycle: if the tenant was reactivated and offboarded again, the row is reset so
 * the new cycle gets its own warnings and a fresh gate.
 */
async function ensurePurgeRow(tenant) {
  const table = () => platformDb().table('tenant_purges');
  let row = await table().where({ tenant_id: tenant.id }).first();

  if (!row) {
    try {
      await table().insert({ tenant_id: tenant.id, state: 'scheduled', offboarding_requested_at: tenant.offboarding_requested_at ?? null });
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
    }
    return table().where({ tenant_id: tenant.id }).first();
  }

  if (tenant.status === 'offboarding' && row.state !== 'completed' && !sameInstant(row.offboarding_requested_at, tenant.offboarding_requested_at)) {
    await table().where({ tenant_id: tenant.id }).update({
      state: 'scheduled',
      offboarding_requested_at: tenant.offboarding_requested_at ?? null,
      blocked_reason: null,
      blocked_at: null,
      export_id: null,
      attempts: 0,
      last_error: null,
      clean_passes: 0,
      deleted_counts: null,
      files_deleted: null,
      warned_7d_at: null,
      warned_1d_at: null,
    });
    row = await table().where({ tenant_id: tenant.id }).first();
  }
  return row;
}

// ---------------------------------------------------------------------
// The export gate
// ---------------------------------------------------------------------

/**
 * May this tenant be purged NOW? Returns `{ok: true, exportRow}` or `{ok: false,
 * reason}`. Reasons: `retention_dates_missing`, `retention_window_invalid`,
 * `export_missing`, `export_file_missing`, `export_file_size_mismatch`.
 *
 * A qualifying export is `completed` with `completed_at` on or after the
 * offboarding request (so an export from an earlier offboard-then-reactivate cycle
 * never counts) and its file still on disk at the recorded size. `completed_at` is
 * used rather than `created_at`: the application stamps it after the request, so it
 * cannot straddle clock skew or DATETIME rounding.
 */
async function evaluateGate({ tenant, now = new Date() }) {
  if (!tenant.offboarding_requested_at || !tenant.retention_expires_at) return { ok: false, reason: 'retention_dates_missing' };

  const window = new Date(tenant.retention_expires_at).getTime() - new Date(tenant.offboarding_requested_at).getTime();
  if (window < config.minRetentionDays() * DAY_MS) return { ok: false, reason: 'retention_window_invalid' };

  // The tenant must have been told, and told recently enough to act. Without this a
  // tenant already past its deadline when the purge is first switched on, or after any
  // period the sweep was off, would be deleted with no notice at all. Transient: the
  // warnings sweep (which runs first) is what clears it.
  const purgeRow = await platformDb().table('tenant_purges').where({ tenant_id: tenant.id }).first();
  if (!purgeRow?.warned_1d_at) return { ok: false, reason: 'warning_pending', transient: true };
  if (new Date(purgeRow.warned_1d_at).getTime() > now.getTime() - WARNING_GRACE_MS) return { ok: false, reason: 'warning_grace', transient: true };

  // The guest portal and QR ordering stay live until the claim, so data keeps arriving
  // after the offboarding-day export. The export that gates deletion is the one made
  // when the 7-day warning went out (or later), not the day-0 one.
  const since = purgeRow.warned_7d_at ?? tenant.offboarding_requested_at;
  const completed = await platformDb()
    .table('tenant_data_exports')
    .where({ tenant_id: tenant.id, status: 'completed' })
    .where('completed_at', '>=', since)
    .orderBy('id', 'desc');
  if (!completed.length) return { ok: false, reason: 'export_missing' };

  let failure = 'export_file_missing';
  for (const row of completed) {
    let stat = null;
    try {
      stat = row.file_path ? fs.statSync(row.file_path) : null;
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) continue;
    if (row.file_size_bytes != null && String(stat.size) !== String(row.file_size_bytes)) {
      failure = 'export_file_size_mismatch';
      continue;
    }
    return { ok: true, exportRow: row };
  }
  return { ok: false, reason: failure };
}

/** Makes sure an export is being produced — at most one in flight, and not more than one per 6 hours. Returns true if it queued one. */
async function ensureFreshExport({ tenantId, now, reason }) {
  const db = scopedDb().for(systemContext());
  const inFlight = await db.platform().table('tenant_data_exports').where({ tenant_id: tenantId }).whereIn('status', ['pending', 'processing']).first();
  if (inFlight) {
    if (now.getTime() - new Date(inFlight.created_at).getTime() > EXPORT_REENQUEUE_MS) {
      enqueueTenantDataExportJob({ tenantId: String(tenantId), exportId: inFlight.id }).catch((error) => {
        console.error('Failed to re-enqueue tenant data export job:', error);
      });
    }
    return false;
  }
  const newest = await db.platform().table('tenant_data_exports').where({ tenant_id: tenantId }).orderBy('id', 'desc').first();
  if (newest && now.getTime() - new Date(newest.created_at).getTime() < EXPORT_STALE_MS) return false;

  // Both requester columns NULL = requested by the system.
  const exportId = await createExportAttempt(db, { tenantId, reason });
  enqueueTenantDataExportJob({ tenantId: String(tenantId), exportId }).catch((error) => {
    console.error('Failed to enqueue tenant data export job:', error);
  });
  return true;
}

/** Records why a purge cannot start. Audited only when the reason CHANGES (the sweep runs every 5 minutes). */
async function blockPurge({ tenant, purgeRow, reason, now }) {
  const changed = purgeRow.state !== 'blocked' || purgeRow.blocked_reason !== reason;
  await platformDb()
    .table('tenant_purges')
    .where({ tenant_id: tenant.id })
    .update({ state: 'blocked', blocked_reason: reason, blocked_at: changed ? now : purgeRow.blocked_at ?? now });

  if (changed) {
    await tenantDb(tenant.id).transaction((trx) =>
      recordAuditEntry(trx, {
        entityType: 'tenants',
        entityId: tenant.id,
        action: 'purge_blocked',
        source: 'job',
        afterState: { reason },
        reason: 'The retention deadline passed but the tenant cannot be purged yet.',
      })
    );
  }
  if (reason.startsWith('export_')) {
    await ensureFreshExport({ tenantId: tenant.id, now, reason: 'System: retention deadline reached without a usable export' });
  }
}

// ---------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------

/**
 * Cuts access and starts the purge — see the file header. Returns `{claimed: false}`
 * when the tenant is no longer purgeable (reactivated, re-offboarded, not due), having
 * changed nothing.
 */
async function claimTenantForPurge({ tenantId, exportId, now }) {
  return scopedDb()
    .for(systemContext())
    .transaction(async (trx) => {
      // Lock order: subscription BEFORE tenants — billing's own order.
      await trx.platform().table('subscriptions').where({ tenant_id: tenantId }).forUpdate().first();
      const scoped = trx.platform().withContext(workerContext({ tenantId }));

      const claimed = await scoped
        .table('tenants')
        .where({ status: 'offboarding' })
        .whereNotNull('retention_expires_at')
        .where('retention_expires_at', '<=', now)
        .update({ status: 'purging' });
      if (!claimed) return { claimed: false };

      // A cancelled subscription is never charged and a late webhook cannot revive it;
      // the stored card token is cleared because a purged tenant must never be charged.
      await trx.platform().table('subscriptions').where({ tenant_id: tenantId }).update({
        status: 'canceled',
        payment_method_provider: null,
        payment_method_authorization_code: null,
        payment_method_last4: null,
        payment_method_brand: null,
        payment_method_exp_month: null,
        payment_method_exp_year: null,
      });

      await scoped.table('sessions').whereNull('revoked_at').update({ revoked_at: now, revoked_reason: 'admin_revoked' });
      await scoped.table('users').update({ status: 'inactive' });
      await scoped.acrossProperties().table('guest_accounts').update({ status: 'inactive' });
      await trx.platform().table('impersonation_sessions').where({ tenant_id: tenantId }).whereNull('ended_at').update({ ended_at: now });
      await scoped.table('tenant_domains').delete();
      await redactRetainedWebhookPayloads(trx, tenantId);

      // An export or import still in flight has nothing left to work on.
      await trx
        .platform()
        .table('tenant_data_exports')
        .where({ tenant_id: tenantId })
        .whereIn('status', ['pending', 'processing'])
        .update({ status: 'failed', failed_reason: 'Tenant purge started' });
      await scoped.table('import_runs').where({ status: 'committing' }).update({ status: 'failed', failed_reason: 'Tenant purge started' });

      // The claim must not depend on a caller having created the bookkeeping row first.
      // (A duplicate is expected and harmless: MySQL does not abort the transaction on it.)
      try {
        await trx.platform().table('tenant_purges').insert({ tenant_id: tenantId, state: 'running' });
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
      }
      await trx.platform().table('tenant_purges').where({ tenant_id: tenantId }).update({
        state: 'running',
        export_id: exportId,
        started_at: now,
        blocked_reason: null,
        blocked_at: null,
        clean_passes: 0,
      });

      return { claimed: true };
    });
}

// ---------------------------------------------------------------------
// One tick of deletion
// ---------------------------------------------------------------------

async function acquireLease({ tenantId, owner, now }) {
  const updated = await platformDb()
    .table('tenant_purges')
    .where({ tenant_id: tenantId })
    .where((group) => group.whereNull('lease_expires_at').orWhere('lease_expires_at', '<', now))
    .update({ lease_owner: owner, lease_expires_at: new Date(now.getTime() + LEASE_MS) });
  return updated > 0;
}

async function renewLease({ tenantId, owner }) {
  await platformDb()
    .table('tenant_purges')
    .where({ tenant_id: tenantId, lease_owner: owner })
    .update({ lease_expires_at: new Date(Date.now() + LEASE_MS) });
}

async function releaseLease({ tenantId, owner }) {
  await platformDb().table('tenant_purges').where({ tenant_id: tenantId, lease_owner: owner }).update({ lease_owner: null, lease_expires_at: null });
}

/** NULLs the self-reference of the tenant's rows in one table, chunk by chunk, so the rows can be deleted in any order. */
async function clearSelfReferences({ db, step, tenantId }) {
  for (;;) {
    const rows = await purgeQuery(db, step, tenantId).whereNotNull(step.selfReference).select('id').orderBy('id').limit(step.chunk);
    if (!rows.length) return;
    await withLockRetry(() =>
      purgeQuery(db, step, tenantId)
        .whereIn('id', rows.map((row) => row.id))
        .update({ [step.selfReference]: null })
    );
  }
}

/** `tenant_data_exports` is kept, but its FK to `users` must not block deleting them. */
async function clearExportRequester({ tenantId }) {
  const patch = CLEARED_TABLES.tenant_data_exports.beforeUsers;
  await platformDb().table('tenant_data_exports').where({ tenant_id: tenantId }).update(patch);
}

/**
 * Deletes one plan step. Returns `{deleted, files, budgetExhausted, blocked}`.
 * `blocked` names a foreign-key refusal: the tick records it and moves on, and the
 * verification pass will (correctly) find the table non-empty and try again.
 */
async function purgeStep({ db, step, tenantId, owner, deadline }) {
  const result = { deleted: 0, files: emptyTally(), budgetExhausted: false, blocked: null };

  if (step.clearExportRequesterBefore) await clearExportRequester({ tenantId });
  if (step.selfReference) await clearSelfReferences({ db, step, tenantId });

  const columns = ['id', ...(step.fileHook ? [step.fileHook.column] : [])];
  for (;;) {
    const rows = await purgeQuery(db, step, tenantId).select(...columns).orderBy('id').limit(step.chunk);
    if (!rows.length) return result;

    // Files first: a crash between the two leaves rows pointing at missing files (harmless).
    if (step.fileHook) result.files = addTallies(result.files, deleteFilesForRows(step.fileHook, rows));

    try {
      const deleted = await withLockRetry(() =>
        purgeQuery(db, step, tenantId)
          .whereIn('id', rows.map((row) => row.id))
          .delete()
      );
      result.deleted += deleted;
    } catch (error) {
      if (error.code === 'ER_ROW_IS_REFERENCED_2') {
        result.blocked = `${step.table}: ${error.sqlMessage ?? error.message}`.slice(0, 500);
        return result;
      }
      throw error;
    }

    await renewLease({ tenantId, owner });
    if (Date.now() > deadline) {
      result.budgetExhausted = true;
      return result;
    }
  }
}

/** Tables that still hold at least one of this tenant's rows. */
async function nonEmptyTables({ db, tenantId }) {
  const remaining = [];
  for (const step of steps) {
    const row = await purgeQuery(db, step, tenantId).first('id');
    if (row) remaining.push(step.table);
  }
  return remaining;
}

/**
 * One resumable tick for a tenant in `purging`. Returns `{status}`:
 *   'skipped'   another instance holds the lease (or the tenant is not purging)
 *   'progress'  more to do; the next tick continues
 *   'complete'  everything deleted and verified; the tenant is now `purged`
 */
async function runPurgeTick({ tenantId, now = new Date(), budgetMs = config.tickBudgetMs(), leaseOwner } = {}) {
  const tenant = await knex()('tenants').where({ id: tenantId }).first();
  if (!tenant || tenant.status !== 'purging') return { status: 'skipped', reason: 'not_purging' };

  const purgeRow = await ensurePurgeRow(tenant);
  const owner = leaseOwner ?? `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  if (!(await acquireLease({ tenantId, owner, now }))) return { status: 'skipped', reason: 'leased' };

  const deadline = Date.now() + budgetMs;
  const db = tenantDb(tenantId);
  let counts = purgeRow.deleted_counts ? (typeof purgeRow.deleted_counts === 'string' ? JSON.parse(purgeRow.deleted_counts) : purgeRow.deleted_counts) : {};
  let files = purgeRow.files_deleted ? (typeof purgeRow.files_deleted === 'string' ? JSON.parse(purgeRow.files_deleted) : purgeRow.files_deleted) : emptyTally();
  const errors = [];
  let deletedThisTick = 0;

  try {
    for (const step of steps) {
      const result = await purgeStep({ db, step, tenantId, owner, deadline });
      if (result.deleted) {
        counts[step.table] = (counts[step.table] ?? 0) + result.deleted;
        deletedThisTick += result.deleted;
      }
      files = addTallies(files, result.files);
      if (result.blocked) errors.push(result.blocked);
      if (result.budgetExhausted) {
        await saveProgress({ tenantId, counts, files, cleanPasses: 0, error: errors.join('; ') || null });
        return { status: 'progress', reason: 'budget', deletedThisTick };
      }
    }

    const remaining = await nonEmptyTables({ db, tenantId });
    if (remaining.length) {
      await saveProgress({ tenantId, counts, files, cleanPasses: 0, error: errors.join('; ') || `still holds rows: ${remaining.join(', ')}` });
      return { status: 'progress', reason: 'not_empty', remaining, deletedThisTick };
    }

    const cleanPasses = Number(purgeRow.clean_passes ?? 0) + 1;
    await saveProgress({ tenantId, counts, files, cleanPasses, error: null });
    if (cleanPasses < CLEAN_PASSES_REQUIRED) return { status: 'progress', reason: 'verifying', deletedThisTick };

    await finalizeTenantPurge({ tenantId, counts, files, purgeRow, now });
    return { status: 'complete' };
  } catch (error) {
    // Keep what was deleted before the failure, so the final audit row's counts stay honest.
    await saveProgress({ tenantId, counts, files, cleanPasses: 0, error: String(error?.message ?? error).slice(0, 2000) }).catch(() => {});
    throw error;
  } finally {
    await releaseLease({ tenantId, owner }).catch(() => {});
  }
}

async function saveProgress({ tenantId, counts, files, cleanPasses, error }) {
  const current = await platformDb().table('tenant_purges').where({ tenant_id: tenantId }).first('attempts');
  await platformDb()
    .table('tenant_purges')
    .where({ tenant_id: tenantId })
    .update({
      deleted_counts: JSON.stringify(counts),
      files_deleted: JSON.stringify(files),
      clean_passes: cleanPasses,
      last_error: error,
      attempts: Number(current?.attempts ?? 0) + 1,
    });
}

/**
 * `subscription_webhook_events` is retained (Planmsys's own billing record), but the raw
 * provider payload on it carries the payer's email, card last4 and the reusable
 * authorization code. Keep who/what/outcome; drop the payload. Run at the claim AND at
 * finalize, because a signed event can still be persisted for the tenant in between.
 */
async function redactRetainedWebhookPayloads(trx, tenantId) {
  await trx.platform().table('subscription_webhook_events').where({ tenant_id: tenantId }).update({ payload: JSON.stringify({ redacted: true }) });
}

/**
 * The last step: delete the export files, then in one transaction write the single
 * `tenant_purged` audit row (property NULL, user NULL, per-table counts only — no
 * personal data), mark the tenant `purged`, and complete the purge row.
 */
async function finalizeTenantPurge({ tenantId, counts, files, purgeRow, now }) {
  const exportRows = await platformDb().table('tenant_data_exports').where({ tenant_id: tenantId });
  const exportFiles = deleteExportFilesForTenant({ tenantId, rows: exportRows });
  await platformDb().table('tenant_data_exports').where({ tenant_id: tenantId }).update(CLEARED_TABLES.tenant_data_exports.atFinalize);
  const allFiles = addTallies(files, exportFiles);

  await tenantDb(tenantId).transaction(async (trx) => {
    await recordAuditEntry(trx, {
      entityType: 'tenants',
      entityId: tenantId,
      action: 'tenant_purged',
      source: 'job',
      afterState: {
        deletedRows: counts,
        files: allFiles,
        startedAt: purgeRow.started_at ?? null,
        finishedAt: now,
        exportId: purgeRow.export_id ?? null,
      },
      reason: 'Retention period elapsed; tenant data permanently deleted.',
    });
    await redactRetainedWebhookPayloads(trx, tenantId);
    const updated = await trx.table('tenants').where({ status: 'purging' }).update({ status: 'purged' });
    if (!updated) throw new Error(`purge: tenant ${tenantId} was not in "purging" at finalize.`);
    await trx.platform().table('tenant_purges').where({ tenant_id: tenantId }).update({
      state: 'completed',
      completed_at: now,
      lease_owner: null,
      lease_expires_at: null,
      deleted_counts: JSON.stringify(counts),
      files_deleted: JSON.stringify(allFiles),
      last_error: null,
    });
  });
}

// ---------------------------------------------------------------------
// Warnings: T-7d and T-1d
// ---------------------------------------------------------------------

/** Every active admin/super_admin of the tenant — who to warn. */
async function adminRecipients(tenantId) {
  const db = tenantDb(tenantId);
  const grants = await db.acrossProperties().table('user_property_access').whereIn('role', ['admin', 'super_admin']).select('user_id');
  const userIds = [...new Set(grants.map((grant) => String(grant.user_id)))];
  if (!userIds.length) return [];
  const users = await db.table('users').whereIn('id', userIds).where({ status: 'active' }).select('email');
  return [...new Set(users.map((user) => user.email))];
}

/**
 * Sends one warning ('7d' or '1d') — once. The flag is claimed with a conditional
 * UPDATE inside the same transaction that writes the outbox events, so a crash or a
 * concurrent tick can neither double-send nor lose a warning. The 7-day one also
 * makes a fresh export: the export made at offboarding may be weeks old by now.
 */
async function sendPurgeWarning({ tenant, kind, now }) {
  const flag = kind === '7d' ? 'warned_7d_at' : 'warned_1d_at';
  const recipients = await adminRecipients(tenant.id);
  const property = await tenantDb(tenant.id).acrossProperties().table('properties').where({ status: 'active' }).orderBy('id').first('id');
  // An overdue tenant is told deletion is a day away, which is what the gate guarantees.
  const scheduled = new Date(tenant.retention_expires_at);
  const deletionDate = scheduled.getTime() > now.getTime() ? scheduled : new Date(now.getTime() + DAY_MS);
  const daysRemaining = Math.max(1, Math.ceil((deletionDate.getTime() - now.getTime()) / DAY_MS));

  // Queue the fresh export BEFORE recording that the warning went out: if this throws,
  // the flag stays unset and the next tick tries again, instead of a warning that
  // promised an export nobody ever requested.
  const current = await platformDb().table('tenant_purges').where({ tenant_id: tenant.id }).first(flag);
  if (current?.[flag]) return false;
  if (kind === '7d') await ensureFreshExport({ tenantId: tenant.id, now, reason: 'System: fresh export ahead of permanent deletion' });

  const sent = await scopedDb()
    .for(systemContext())
    .transaction(async (trx) => {
      const claimed = await trx.platform().table('tenant_purges').where({ tenant_id: tenant.id }).whereNull(flag).update({ [flag]: now });
      if (!claimed) return false;

      const scoped = trx.platform().withContext(workerContext({ tenantId: tenant.id }));
      for (const recipientEmail of recipients) {
        await writeOutboxEvent({
          trx: scoped,
          eventType: 'offboarding.purge_warning',
          aggregateType: 'tenants',
          aggregateId: tenant.id,
          propertyId: property?.id ?? null,
          payload: {
            recipientEmail,
            tenantName: tenant.name,
            deletionDate: deletionDate.toISOString().slice(0, 10),
            daysRemaining: `${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
            kind,
          },
        });
      }
      await recordAuditEntry(scoped, {
        entityType: 'tenants',
        entityId: tenant.id,
        action: `purge_warning_${kind}`,
        source: 'job',
        afterState: { recipients: recipients.length, deletionDate },
      });
      return true;
    });

  if (!sent) return false;
  if (recipients.length && property) {
    enqueueOutboxDispatch({ tenantId: tenant.id, propertyId: property.id }).catch((error) => {
      console.error('Failed to enqueue outbox dispatch for a purge warning:', error);
    });
  }
  return true;
}

/** Warns every offboarding tenant whose deadline is within 7 days (and again within 1 day). */
async function runPurgeWarnings({ now = new Date() } = {}) {
  const upcoming = await knex()('tenants')
    .where({ status: 'offboarding' })
    .whereNotNull('retention_expires_at')
    // Includes tenants ALREADY past their deadline (offboarded before the purge was
    // enabled, or while the sweep was off): they get their notice now and are deleted
    // only after the grace period the gate enforces.
    .andWhere('retention_expires_at', '<=', addDays(now, 7))
    .orderBy('id');

  const results = [];
  for (const tenant of upcoming) {
    try {
      const row = await ensurePurgeRow(tenant);
      const remainingMs = new Date(tenant.retention_expires_at).getTime() - now.getTime();
      if (!row.warned_7d_at && (await sendPurgeWarning({ tenant, kind: '7d', now }))) results.push({ tenantId: tenant.id, warned: '7d' });
      if (!row.warned_1d_at && remainingMs <= DAY_MS && (await sendPurgeWarning({ tenant, kind: '1d', now }))) results.push({ tenantId: tenant.id, warned: '1d' });
    } catch (error) {
      console.error(`purge warning failed for tenant ${tenant.id}:`, error);
      results.push({ tenantId: tenant.id, warned: null, error: error.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------
// Preview (dry run)
// ---------------------------------------------------------------------

/** What a purge WOULD delete for one tenant — per-table row counts. Writes nothing. */
async function previewPurge({ tenantId }) {
  const db = tenantDb(tenantId);
  const tables = {};
  let total = 0;
  for (const step of steps) {
    const count = await purgeQuery(db, step, tenantId).count('id');
    if (count) tables[step.table] = count;
    total += count;
  }
  return { tenantId: String(tenantId), totalRows: total, tables };
}

// ---------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------

/**
 * One sweep: warn, then start or resume up to `TENANT_PURGE_MAX_PER_TICK` purges.
 * Tenants that are due but BLOCKED do not count toward the cap, so one stuck tenant
 * can never starve the rest. In dry-run mode it evaluates and logs and writes nothing.
 */
async function runPurgeSweep({ now = new Date() } = {}) {
  const classification = classifyAllTables();
  if (!classification.ok) {
    console.error('[tenant-purge] REFUSING to run: the purge plan does not cover every tenant-owned table.', JSON.stringify(classification));
    return [{ refused: true, classification }];
  }

  const results = [];
  const dryRun = config.dryRun();
  if (!dryRun) results.push(...(await runPurgeWarnings({ now })).map((warning) => ({ ...warning, phase: 'warning' })));

  const candidates = await knex()('tenants')
    .where((group) =>
      group
        .where({ status: 'purging' })
        .orWhere((due) => due.where({ status: 'offboarding' }).whereNotNull('retention_expires_at').andWhere('retention_expires_at', '<=', now))
    )
    .orderByRaw("status = 'purging' DESC, id ASC");

  let started = 0;
  for (const tenant of candidates) {
    if (started >= config.maxPerTick()) break;
    try {
      const outcome = await processCandidate({ tenant, now, dryRun });
      if (outcome.counted) started += 1;
      results.push({ tenantId: tenant.id, ...outcome });
    } catch (error) {
      console.error(`tenant purge failed for tenant ${tenant.id}:`, error);
      results.push({ tenantId: tenant.id, status: 'error', error: error.message });
    }
  }
  return results;
}

/** A tenant that deleted nothing this tick (stuck on a foreign key, a file error, a lease held elsewhere) must not use up the slot other tenants are waiting for. */
function tickMadeProgress(tick) {
  return tick.status === 'complete' || (tick.status === 'progress' && Number(tick.deletedThisTick) > 0);
}

async function processCandidate({ tenant, now, dryRun }) {
  if (tenant.status === 'purging') {
    if (dryRun) return { status: 'dry_run', counted: true, preview: await previewPurge({ tenantId: tenant.id }) };
    const tick = await runPurgeTick({ tenantId: tenant.id, now });
    return { ...tick, counted: tickMadeProgress(tick) };
  }

  const purgeRow = dryRun ? { state: 'scheduled' } : await ensurePurgeRow(tenant);
  const gate = await evaluateGate({ tenant, now });

  if (dryRun) {
    console.log(`[tenant-purge] DRY RUN tenant ${tenant.id}: gate ${gate.ok ? 'passes' : `blocked (${gate.reason})`}`, gate.ok ? JSON.stringify(await previewPurge({ tenantId: tenant.id })) : '');
    return { status: 'dry_run', counted: gate.ok, gate: gate.ok ? 'ok' : gate.reason };
  }

  if (!gate.ok && gate.transient) return { status: 'waiting', reason: gate.reason, counted: false };
  if (!gate.ok) {
    await blockPurge({ tenant, purgeRow, reason: gate.reason, now });
    return { status: 'blocked', reason: gate.reason, counted: false };
  }

  const claim = await claimTenantForPurge({ tenantId: tenant.id, exportId: gate.exportRow.id, now });
  if (!claim.claimed) return { status: 'not_claimed', counted: false };

  const tick = await runPurgeTick({ tenantId: tenant.id, now });
  return { ...tick, claimed: true, counted: true };
}

module.exports = {
  runPurgeSweep,
  runPurgeTick,
  runPurgeWarnings,
  claimTenantForPurge,
  evaluateGate,
  previewPurge,
  ensurePurgeRow,
  purgeQuery,
  retryStats,
  CLEAN_PASSES_REQUIRED,
};
