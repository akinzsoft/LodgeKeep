'use strict';

/**
 * Tenant offboarding — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22
 * ("Offboarding must include a full data export... define a retention
 * window before deletion, and honour it" — a real NDPA/GDPR
 * data-portability obligation, not a nice-to-have).
 *
 * This module owns the TENANT-INITIATED half of the transition
 * (`requestOwnOffboarding`) plus every tenant self-service read/write
 * against its own export attempts (`getOffboardingStatus`,
 * `retryFailedExport`, `downloadExport`). The PLATFORM-INITIATED half
 * (`offboardTenant`) lives in `src/modules/platform/service.js`, mirroring
 * `suspendTenant`/`reactivateTenant`'s own placement exactly — but both
 * halves share the same export-attempt bookkeeping
 * (`createExportAttempt`, below) and the same retention-window constant,
 * so the two entry points can never drift on what "an offboarding
 * request" actually creates.
 *
 * ── ACCESS PATTERN, mirroring `billing/service.js`'s own header exactly ──
 *
 * `tenant_data_exports` is PLATFORM_SCOPED with `tenant_id` an
 * `unscopedColumns` mandatory business column (Planmsys' own record of a
 * job run against a tenant, not the tenant's own operational data). A
 * tenant self-service caller carries an ordinary STAFF context, which
 * cannot call `.platform()` directly — every read/write here rebuilds a
 * SYSTEM context internally (`systemContext()`) and filters explicitly by
 * `context.tenantId`, never a caller-supplied one, so one tenant can never
 * reach another's export rows.
 *
 * The status TRANSITION itself (`tenants.status` — TENANT_SCOPED, with
 * `scopeRoot: 'tenant'`) needs no such rebuild for the self-service path:
 * an ordinary `scopedDb().for(context).table('tenants')` already scopes to
 * exactly `WHERE id = context.tenantId`, so a ROOT-level conditional
 * UPDATE against it — `whereIn('status', fromStatuses)`, affected-row-count
 * as the proof, never read-then-write (ARCHITECTURE.md §5) — is both the
 * simplest and the safest way to write it. Reaching PLATFORM_SCOPED
 * `tenant_data_exports` on the SAME connection, so the status flip and the
 * export-attempt row commit atomically, uses the identical
 * `.platform().withContext(...)` rebind `billing/service.js`'s
 * `applyChargeOutcome` already established.
 *
 * ── RETENTION WINDOW: 30 DAYS, COMPUTED ONCE AND STORED ──────────────────
 *
 * See `20260925090000_add_offboarding_columns_to_tenants.js`'s own header
 * for the full reasoning — confirmed with the user. `RETENTION_WINDOW_DAYS`
 * lives here (not duplicated in `platform/service.js`) since this is the
 * one place a future policy change would touch; `offboardTenant`
 * (platform-initiated) imports it from here rather than hardcoding its own
 * copy.
 *
 * ── WHAT OFFBOARDING BLOCKS VS. ALLOWS, CONFIRMED WITH THE USER ──────────
 *
 * Read-only, exactly like `suspended` — `src/shared/tenant-lifecycle.js`'s
 * own header. The four routes this module exposes are deliberately
 * mounted in `src/app.js` AHEAD of `rejectMutationForTenantLifecycle()`
 * (see that file's own comment at the mount point) so a tenant already
 * `offboarding` can still request a retry or check status/download —
 * without that carve-out, the very state this module puts a tenant into
 * would make its own "view your export" screen unreachable, which is
 * precisely the trap `tenant-resolution.js`'s own header (see that file)
 * already flags for the analogous 404 case.
 *
 * ── OUT OF SCOPE, DELIBERATELY (confirmed with the user before building) ─
 *
 * The actual destructive purge once `retention_expires_at` passes — this
 * pass stores the date and builds the export; nothing reads that date yet.
 */

const { scopedDb } = require('../../db');
const { systemContext, workerContext } = require('../tenancy');
const { recordAuditEntry } = require('../../audit');
const { ValidationError } = require('../../shared/errors');
const { TenantNotFoundError, InvalidTenantLifecycleTransitionError } = require('../platform/errors');
const { ExportNotRetryableError, ExportNotDownloadableError } = require('./errors');
const { enqueueTenantDataExportJob } = require('../../jobs/tenant-data-export');

const RETENTION_WINDOW_DAYS = 30;
const RETENTION_WINDOW_MS = RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** A tenant already `offboarding` cannot re-request; `suspended` is included so a non-paying tenant can still choose to leave rather than being stuck fully blocked with no way out except platform intervention. */
const OFFBOARDABLE_FROM_STATUSES = ['trial', 'active', 'suspended'];

/** Pure — takes "now" as a parameter so a test can pick a fixed instant. */
function computeRetentionExpiresAt(now = new Date()) {
  return new Date(now.getTime() + RETENTION_WINDOW_MS);
}

function formatExport(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    status: row.status,
    reason: row.reason ?? null,
    fileSizeBytes: row.file_size_bytes != null ? String(row.file_size_bytes) : null,
    completedAt: row.completed_at ?? null,
    downloadedAt: row.downloaded_at ?? null,
    failedReason: row.failed_reason ?? null,
    createdAt: row.created_at,
  };
}

/**
 * Inserts one export-attempt row on an ALREADY-OPEN transactional
 * accessor — `db` must already be able to call `.platform()` (a real
 * platform context, or SYSTEM). Shared by both `requestOwnOffboarding`
 * below and `platform/service.js`'s `offboardTenant`, so "what a fresh
 * offboarding request creates" is defined exactly once.
 */
async function createExportAttempt(db, { tenantId, requestedByUserId = null, requestedByPlatformUserId = null, reason = null }) {
  const [exportId] = await db.platform().table('tenant_data_exports').insert({
    tenant_id: tenantId,
    status: 'pending',
    requested_by_user_id: requestedByUserId,
    requested_by_platform_user_id: requestedByPlatformUserId,
    reason: reason ? String(reason).trim() : null,
  });
  return String(exportId);
}

// ---------------------------------------------------------------------
// Tenant self-service — POST /offboarding/request, GET /offboarding/status,
// POST /offboarding/exports/:id/retry, GET /offboarding/exports/:id/download
// ---------------------------------------------------------------------

async function requestOwnOffboarding({ context, reason, ip, userAgent, requestId }) {
  const tenantId = context.tenantId;

  // Opens with a SYSTEM context, not the caller's own STAFF one — reaching
  // PLATFORM_SCOPED `tenant_data_exports` needs `.platform()`, which only a
  // PLATFORM/SYSTEM audience satisfies (see file header). `tenantId` still
  // comes from the real authenticated caller's own context, never a
  // request param — this rebuild is about WHICH accessor methods are
  // reachable on this connection, not a widening of whose data it can
  // touch.
  const result = await scopedDb()
    .for(systemContext())
    .transaction(async (trx) => {
      const tenantDb = trx.platform().withContext(workerContext({ tenantId }));
      const before = await tenantDb.table('tenants').first('status');
      const now = new Date();
      const retentionExpiresAt = computeRetentionExpiresAt(now);

      const updated = await tenantDb
        .table('tenants')
        .whereIn('status', OFFBOARDABLE_FROM_STATUSES)
        .update({ status: 'offboarding', offboarding_requested_at: now, retention_expires_at: retentionExpiresAt });

      if (!updated) {
        if (!before) throw new TenantNotFoundError();
        throw new InvalidTenantLifecycleTransitionError(before.status, 'offboarding');
      }

      const exportId = await createExportAttempt(trx, { tenantId, requestedByUserId: context.userId, reason });

      await recordAuditEntry(tenantDb, {
        entityType: 'tenants',
        entityId: tenantId,
        action: 'offboard_request',
        source: 'api',
        beforeState: { status: before.status },
        afterState: { status: 'offboarding' },
        reason: reason ? String(reason).trim() : null,
        requestId,
        ipAddress: ip,
        userAgent,
      });

      return { tenantId: String(tenantId), status: 'offboarding', retentionExpiresAt, exportId };
    });

  enqueueTenantDataExportJob({ tenantId: result.tenantId, exportId: result.exportId }).catch((error) => {
    console.error('Failed to enqueue tenant data export job:', error);
  });

  return result;
}

async function getOffboardingStatus({ context }) {
  const tenantId = context.tenantId;
  const db = scopedDb().for(context);
  const tenant = await db.table('tenants').first('status', 'offboarding_requested_at', 'retention_expires_at');

  const platformDb = scopedDb().for(systemContext()).platform();
  const latestExport = await platformDb.table('tenant_data_exports').where({ tenant_id: tenantId }).orderBy('id', 'desc').first();

  return {
    status: tenant.status,
    offboardingRequestedAt: tenant.offboarding_requested_at,
    retentionExpiresAt: tenant.retention_expires_at,
    latestExport: formatExport(latestExport),
  };
}

async function retryFailedExport({ context, exportId }) {
  const tenantId = context.tenantId;
  const db = scopedDb().for(systemContext());
  const existing = await db.platform().table('tenant_data_exports').where({ tenant_id: tenantId, id: exportId }).first();
  if (!existing) return null; // controller: 404 — cross-tenant/nonexistent look identical (SECURITY.md §2)
  if (existing.status !== 'failed') throw new ExportNotRetryableError(existing.status);

  // The new attempt is attributed to whoever is actually retrying it, never
  // inherited from the row being retried — `retryFailedExport` is reachable
  // only via the tenant self-service route, so `context.userId` is always
  // the real actor here. Blindly copying `existing.requested_by_platform_user_id`
  // forward would set BOTH attribution columns at once for a failed export
  // that was originally platform-initiated (`offboardTenant`), violating
  // this table's own documented "exactly one, never both" invariant (see
  // `20260925091000_create_tenant_data_exports.js`'s header) the moment a
  // tenant's own admin retries a platform-triggered failure.
  const newExportId = await createExportAttempt(db, {
    tenantId,
    requestedByUserId: context.userId,
    requestedByPlatformUserId: null,
    reason: existing.reason,
  });

  enqueueTenantDataExportJob({ tenantId, exportId: newExportId }).catch((error) => {
    console.error('Failed to enqueue tenant data export job:', error);
  });

  const fresh = await db.platform().table('tenant_data_exports').where({ id: newExportId }).first();
  return formatExport(fresh);
}

async function downloadExport({ context, exportId }) {
  const tenantId = context.tenantId;
  const db = scopedDb().for(systemContext()).platform();
  const row = await db.table('tenant_data_exports').where({ tenant_id: tenantId, id: exportId }).first();
  if (!row) return null; // controller: 404
  if (row.status !== 'completed' || !row.file_path) throw new ExportNotDownloadableError(row.status);

  await db.table('tenant_data_exports').where({ id: exportId }).update({ downloaded_at: new Date() });

  return { filePath: row.file_path, fileName: `tenant-${tenantId}-export-${row.id}.json` };
}

module.exports = {
  RETENTION_WINDOW_DAYS,
  computeRetentionExpiresAt,
  OFFBOARDABLE_FROM_STATUSES,
  createExportAttempt,
  formatExport,
  requestOwnOffboarding,
  getOffboardingStatus,
  retryFailedExport,
  downloadExport,
  ValidationError,
};
