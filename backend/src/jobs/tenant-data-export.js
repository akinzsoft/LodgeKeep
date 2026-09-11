'use strict';

/**
 * Tenant data export — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22
 * (NDPA/GDPR data-portability). A one-off, reactive job — never a
 * periodic sweep (see `queues.js`'s own header for why an empty,
 * nothing-enqueues-to-it queue is the case ARCHITECTURE.md §14 warns
 * against), triggered the moment `src/modules/offboarding/service.js`'s
 * `requestOwnOffboarding`/`retryFailedExport`, or `platform/service.js`'s
 * `offboardTenant`, creates a fresh `tenant_data_exports` row.
 *
 * ── WHAT'S IN THE BUNDLE, AND WHY AN EXPLICIT DENYLIST, NOT AN ALLOWLIST ─
 *
 * Every TENANT_SCOPED and PROPERTY_SCOPED table in
 * `src/shared/table-scopes.js` is included by default, minus
 * `EXPORT_TABLE_DENYLIST` — tables that are secrets, session/credential
 * state, or Planmsys-internal bookkeeping rather than the tenant's own
 * guests/reservations/folios/operational history (PLAN.md Phase 5's own
 * scope line). An allowlist would silently drop a future table nobody
 * remembered to add — the wrong failure direction for "did we hand over
 * everything a departing tenant is legally entitled to." A PROPERTY_SCOPED
 * table is read via `.acrossProperties()` (every property the tenant
 * runs, not just one — this is a data-portability export, not a
 * single-property report); a TENANT_SCOPED one via a plain
 * `workerContext({tenantId})` read. `tenants`/`properties` are handled
 * separately, hand-picking only business-identity fields (`tenants`:
 * name/slug; `properties`: name/slug/timezone/base_currency/
 * current_business_date) rather than the whole row, which carries
 * billing/lifecycle internals — `plan_id`, `status`, the very
 * `offboarding_requested_at`/`retention_expires_at` pair this job's own
 * existence depends on — that a departing tenant has no use for and
 * Planmsys has no reason to hand back.
 *
 * `GLOBAL_COLUMN_DENYLIST` strips a secret-shaped column even from an
 * otherwise-included table (`users.password_hash`/`mfa_secret`,
 * `guest_accounts.password_hash`) — belt-and-braces alongside the
 * table-level denylist, not a substitute for it.
 *
 * ── FORMAT: ONE JSON FILE, NOT CSV ────────────────────────────────────────
 *
 * Confirmed with the user. The bundle spans dozens of tables with
 * different shapes, several carrying nested/JSON-typed columns
 * (`pos_menu_items.modifiers`) a single flat CSV dialect can't represent
 * without inventing a bespoke per-table convention. One `{table: [...]}`
 * JSON document loses nothing and needs no such convention; a future pass
 * could add a CSV-per-table ZIP as an alternative format, not a
 * replacement.
 *
 * ── DELIVERY: LOCAL DISK, GITIGNORED — CONFIRMED WITH THE USER ───────────
 *
 * No object-storage dependency exists in this codebase (no S3/MinIO) and
 * none was added for this pass. Written to `EXPORT_STORAGE_DIR` (default:
 * `backend/storage/exports/`, gitignored) as
 * `tenant-{tenantId}-export-{exportId}.json`. `tenant_data_exports.file_path`
 * is a server-local path, never a public URL — downloaded only through
 * the authenticated `GET /offboarding/exports/:exportId/download` route,
 * which streams it via `res.download()`.
 *
 * ── IDEMPOTENCY: A CONDITIONAL UPDATE CLAIMS THE ROW FIRST ───────────────
 *
 * `runExportJob` claims the row (`WHERE status IN ('pending','processing')`)
 * before doing any work — the same affected-row-count idiom every other
 * lifecycle transition in this codebase uses (ARCHITECTURE.md §5) — so a
 * BullMQ retry after a crash mid-write never re-processes a row a prior
 * attempt already finished (completed OR failed; a failed attempt is
 * retried as a FRESH row via `retryFailedExport`, never by re-running this
 * same job against the same id).
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { TENANT_DATA_EXPORT_QUEUE, tenantDataExportQueue } = require('./queues');
const { scopedDb } = require('../db');
const { workerContext } = require('../modules/tenancy');
const { TABLE_SCOPES, SCOPES } = require('../shared/table-scopes');

const EXPORT_JOB_NAME = 'export';

/** Called right after the transaction that creates a `tenant_data_exports` row commits — best-effort, matching `enqueueOutboxDispatch`'s own fire-and-forget shape; a lost enqueue leaves the row `pending` forever with nothing to retry it, a real, narrower gap than the outbox's own (which has a periodic sweep as a fallback) — flagged, not fixed here, since a one-off job has no natural periodic-sweep equivalent to fall back to without reinventing a "find stuck pending exports" scan this pass doesn't build. */
async function enqueueTenantDataExportJob({ tenantId, exportId }) {
  await tenantDataExportQueue().add(
    EXPORT_JOB_NAME,
    { tenantId, exportId },
    { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: 100 }
  );
}

const EXPORT_TABLE_DENYLIST = new Set([
  // Secrets / credential / session state — never leaves the platform, regardless of scope.
  'sessions',
  'password_resets',
  'mfa_devices',
  'mfa_login_codes',
  'guest_password_resets',
  'user_invitations',
  // Planmsys/platform-internal bookkeeping — not the tenant's own operational history.
  'tenant_domains',
  'audit_log',
  'idempotency_keys',
  'outbox_events',
  'in_app_notifications',
  'notification_log',
  'email_settings',
  'email_templates',
  'roles',
  'role_permissions',
  'ar_invoice_sequences',
  // Handled separately, hand-picked business-identity fields only — see file header.
  'tenants',
  'properties',
]);

const GLOBAL_COLUMN_DENYLIST = {
  users: ['password_hash', 'mfa_secret'],
  guest_accounts: ['password_hash'],
};

/** Every table this export includes, in declaration order — TENANT_SCOPED and PROPERTY_SCOPED, minus the denylist above. PLATFORM_SCOPED and GLOBAL_REFERENCE tables are never Planmsys-internal-vs-tenant-data ambiguous — they're excluded outright, not by name. */
function exportableTables() {
  return Object.entries(TABLE_SCOPES)
    .filter(([name, declared]) => (declared.scope === SCOPES.TENANT || declared.scope === SCOPES.PROPERTY) && !EXPORT_TABLE_DENYLIST.has(name))
    .map(([name]) => name);
}

function stripDeniedColumns(tableName, rows) {
  const denied = GLOBAL_COLUMN_DENYLIST[tableName];
  if (!denied || !denied.length) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const column of denied) delete copy[column];
    return copy;
  });
}

function storageDir() {
  const dir = process.env.EXPORT_STORAGE_DIR || path.join(__dirname, '..', '..', 'storage', 'exports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The actual bundle-building work — a plain function, directly testable against a real seeded tenant with no BullMQ involved. */
async function generateTenantDataExport({ tenantId, exportId }) {
  const db = scopedDb().for(workerContext({ tenantId }));

  const tenant = await db.table('tenants').first('id', 'name', 'slug', 'created_at');
  const properties = await db.acrossProperties().table('properties').select('id', 'name', 'slug', 'timezone', 'base_currency', 'current_business_date', 'created_at');

  const bundle = { generatedAt: new Date().toISOString(), tenant, properties };

  for (const table of exportableTables()) {
    const declared = TABLE_SCOPES[table];
    const rows = declared.scope === SCOPES.PROPERTY ? await db.acrossProperties().table(table) : await db.table(table);
    bundle[table] = stripDeniedColumns(table, rows);
  }

  const json = JSON.stringify(bundle, null, 2);
  const filePath = path.join(storageDir(), `tenant-${tenantId}-export-${exportId}.json`);
  fs.writeFileSync(filePath, json, 'utf8');
  const { size } = fs.statSync(filePath);
  return { filePath, fileSizeBytes: size };
}

async function runExportJob({ tenantId, exportId }) {
  const db = scopedDb().for(workerContext({ tenantId }));

  const claimed = await db
    .platform()
    .table('tenant_data_exports')
    .where({ id: exportId, tenant_id: tenantId })
    .whereIn('status', ['pending', 'processing'])
    .update({ status: 'processing' });
  if (!claimed) return; // already completed/failed by a prior attempt

  try {
    const { filePath, fileSizeBytes } = await generateTenantDataExport({ tenantId, exportId });
    await db
      .platform()
      .table('tenant_data_exports')
      .where({ id: exportId })
      .update({ status: 'completed', file_path: filePath, file_size_bytes: fileSizeBytes, completed_at: new Date(), failed_reason: null });
  } catch (error) {
    await db
      .platform()
      .table('tenant_data_exports')
      .where({ id: exportId })
      .update({ status: 'failed', failed_reason: String(error?.message || error).slice(0, 2000) });
    throw error; // BullMQ's own retry/backoff still applies on top of the row's own terminal state
  }
}

function startTenantDataExportWorker() {
  return new Worker(
    TENANT_DATA_EXPORT_QUEUE,
    async (job) => {
      await runExportJob({ tenantId: job.data.tenantId, exportId: job.data.exportId });
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  TENANT_DATA_EXPORT_QUEUE,
  EXPORT_JOB_NAME,
  enqueueTenantDataExportJob,
  generateTenantDataExport,
  runExportJob,
  startTenantDataExportWorker,
  exportableTables,
};
