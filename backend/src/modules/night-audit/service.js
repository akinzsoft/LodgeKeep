'use strict';

/**
 * Night Audit service — PLAN.md Phase 2.5 step 3, ARCHITECTURE.md §6 (the
 * full run-state machine, recovery model, and exact 13-step sequence).
 *
 * ── ONE ROW PER (property, business_date), CLAIMED RATHER THAN
 * INSERT-ONLY ──────────────────────────────────────────────────────────
 *
 * See `night_audit_runs`' own migration header for the schema-level
 * reasoning. `runNightAudit` below is the exact insert-or-reclaim logic
 * that schema is built for: a fresh date INSERTs (the UNIQUE constraint is
 * the concurrency gate — a losing concurrent INSERT hits `ER_DUP_ENTRY`
 * immediately, before touching anything else); a date whose last run
 * FAILED reclaims that SAME row via `UPDATE ... WHERE status = 'FAILED'`
 * (an affected-row count of 0 means someone else claimed it first, or it
 * is no longer FAILED — either way, refuse).
 *
 * ── RECOVERY (§6.3), EVALUATED LAZILY ───────────────────────────────────
 *
 * This codebase has no separate, continuously-running monitor process
 * sweeping `heartbeat_at` (flagged, not an oversight — see
 * `night_audit_runs`' own migration header: "no separate monitor process
 * sweeps heartbeat_at in this pass ... recovery is evaluated lazily, on
 * the next run attempt"). `reconcileExistingRun` below IS that lazy check,
 * run at the START of every `runNightAudit` call: a `RUNNING` row whose
 * `heartbeat_at` has exceeded `STALE_TIMEOUT_MS` is stale by definition (a
 * synchronous request handler either completes steps 4-13's transaction
 * well under the timeout, or the process died and nothing since the
 * insert/reclaim ever ran) — reality is then checked exactly as §6.3
 * describes (does a `daily_reports` row exist AND has the business date
 * already advanced?) before deciding COMPLETED-after-the-fact or FAILED.
 *
 * ── WHY THIS FILE DOES NOT GO THROUGH `withIdempotency` ─────────────────
 *
 * Every other financial mutation in this codebase carries a client-
 * supplied `Idempotency-Key`. Night audit does not need one: its OWN
 * mechanism (the claimed run row, unique per property + business date) is
 * a STRONGER guarantee — it protects even a retry with no key at all (an
 * automatic re-trigger after a crash), which a client-supplied key
 * cannot. Folding it into the generic key-based wrapper would also be
 * structurally wrong here: steps 1-3 must commit their own state (the
 * RUNNING claim) BEFORE steps 4-13 even begin, which needs multiple
 * separate transactions/statements, not the single transaction
 * `withIdempotency` opens per call.
 */

const crypto = require('crypto');
const { scopedDb } = require('../../db');
const { livePhysicalCount } = require('../../shared/room-availability');
const { sumMoney, negateMoney, divideMoney } = require('../../shared/money');
const { writeOutboxEvent } = require('../../shared/outbox');
const cashiering = require('../cashiering/service');
const {
  NightAuditAlreadyCompletedError,
  NightAuditAlreadyRunningError,
  NightAuditBlockingConditionsError,
  PropertyNotOpenedError,
} = require('./errors');

/** A real per-process identifier (ARCHITECTURE.md §6.1: "not just a hostname"), generated once at module load. */
const WORKER_ID = crypto.randomUUID();

/** ARCHITECTURE.md §6.1's own recommendation. */
const STALE_TIMEOUT_MS = 90_000;

function addOneDay(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * §6.2 step 3: unresolved blocking conditions. This pass's own confirmed
 * scope — the one condition PRODUCT_REQUIREMENTS.md/ARCHITECTURE.md name
 * concretely enough to check for real: an unassigned in-house reservation
 * has no meaning in this schema (a reservation only becomes `checked_in`
 * once a room IS assigned — `src/modules/reservations/service.js`'s
 * `checkIn` requires a `room_id`), so the one real, checkable blocking
 * condition left is an OPEN housekeeping discrepancy on a room currently
 * in-house — front desk must resolve it before the date can close, per
 * PRODUCT_REQUIREMENTS.md §3.6's own "requiring front-desk follow-up
 * before the room can be sold again."
 */
async function findBlockingConditions({ db }) {
  const openDiscrepancies = await db.table('housekeeping_discrepancies').whereNull('resolved_at');
  return openDiscrepancies.map((d) => ({
    type: 'unresolved_housekeeping_discrepancy',
    roomId: d.room_id,
    discrepancyId: d.id,
  }));
}

/**
 * §6.3's reality check, applied to a stale `RUNNING` row. Returns the row
 * to reclaim (now `FAILED`) — or throws `NightAuditAlreadyCompletedError`
 * if reality shows the run actually finished.
 */
async function recoverStaleRun({ db, existing, propertyId, businessDate }) {
  const [dailyReport, property] = await Promise.all([
    db.table('daily_reports').where({ property_id: propertyId, business_date: businessDate }).first(),
    db.table('properties').where({ id: propertyId }).first(),
  ]);
  const businessDateAdvanced = property.current_business_date > businessDate;

  if (dailyReport && businessDateAdvanced) {
    await db.table('night_audit_runs').where({ id: existing.id }).update({ status: 'COMPLETED', completed_at: new Date() });
    throw new NightAuditAlreadyCompletedError(businessDate);
  }

  await db.table('night_audit_runs').where({ id: existing.id }).update({
    status: 'FAILED',
    failed_at: new Date(),
    error: 'Recovered from a stale RUNNING state: no heartbeat within the timeout and the critical transaction never committed (ARCHITECTURE.md §6.3).',
  });
  return { ...existing, status: 'FAILED' };
}

/** Inspects the one row (if any) for this (property, business_date) and resolves it to something `claimRun` can reclaim, or throws if a run is genuinely already in progress or complete. */
async function reconcileExistingRun({ db, propertyId, businessDate }) {
  const existing = await db.table('night_audit_runs').where({ property_id: propertyId, business_date: businessDate }).first();
  if (!existing) return null;

  if (existing.status === 'COMPLETED') {
    throw new NightAuditAlreadyCompletedError(businessDate);
  }
  if (existing.status === 'RUNNING') {
    const staleMs = Date.now() - new Date(existing.heartbeat_at).getTime();
    if (staleMs < STALE_TIMEOUT_MS) {
      throw new NightAuditAlreadyRunningError(businessDate);
    }
    return recoverStaleRun({ db, existing, propertyId, businessDate });
  }
  // FAILED — reclaimable as-is.
  return existing;
}

/** Insert-or-reclaim the single row for this (property, business_date) — see file header. Returns the run id. */
async function claimRun({ db, propertyId, businessDate, userId, existing }) {
  const now = new Date();
  if (existing) {
    const affected = await db
      .table('night_audit_runs')
      .where({ id: existing.id, status: 'FAILED' })
      .update({ status: 'RUNNING', worker_id: WORKER_ID, heartbeat_at: now, started_at: now, run_by_user_id: userId ?? null, failed_at: null, error: null, exceptions: null });
    if (affected !== 1) throw new NightAuditAlreadyRunningError(businessDate);
    return existing.id;
  }

  try {
    const [id] = await db.table('night_audit_runs').insert({
      property_id: propertyId,
      business_date: businessDate,
      status: 'RUNNING',
      worker_id: WORKER_ID,
      heartbeat_at: now,
      started_at: now,
      run_by_user_id: userId ?? null,
    });
    return id;
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') throw new NightAuditAlreadyRunningError(businessDate);
    throw error;
  }
}

/**
 * Steps 4-13 (ARCHITECTURE.md §6.2), one transaction. Package charges (step
 * 5) and POS reconciliation (step 7) are skipped outright — no packages or
 * POS module exists in this codebase (Phase 4/6) — flagged, not silently
 * omitted.
 */
async function runCriticalTransaction({ db, propertyId, businessDate, runId }) {
  return db.transaction(async (trx) => {
    const inHouse = await trx.table('reservations').where({ status: 'checked_in' });
    const exceptions = [];

    // Step 4: post room charges (idempotency guard: skip a folio that
    // already has a non-voided room_charge for this business_date).
    for (const reservation of inHouse) {
      const folio = await trx.table('folios').where({ reservation_id: reservation.id, status: 'open' }).first();
      if (!folio) {
        exceptions.push({ type: 'in_house_reservation_without_open_folio', reservationId: reservation.id });
        continue;
      }

      const dailyRate = await trx
        .table('reservation_daily_rates')
        .where({ reservation_id: reservation.id, stay_date: businessDate })
        .first();
      if (!dailyRate) continue; // Tonight is not one of this reservation's booked nights.

      const alreadyPosted = await trx
        .table('folio_line_items')
        .where({ folio_id: folio.id, type: 'room_charge', business_date: businessDate })
        .whereNull('voided_at')
        .first();
      if (alreadyPosted) continue; // Step 4's own idempotency guard (ARCHITECTURE.md §6.2).

      // Step 6 (tax) happens inside postCharge itself.
      await cashiering.postCharge({
        trx,
        folioId: folio.id,
        type: 'room_charge',
        description: `Room charge — ${businessDate}`,
        amount: dailyRate.rate,
        businessDate,
        userId: null, // System-posted; audit_log.source distinguishes "job" from "web".
      });
    }

    // Step 8: reconcile payments received today into the snapshot total —
    // real reconciliation against a gateway ledger is deeper scope than
    // this pass claims (see this module's own index.js header); this is
    // the day's actual posted payment total from the real ledger.
    const roomChargeLines = await trx
      .table('folio_line_items')
      .where({ type: 'room_charge', business_date: businessDate })
      .whereNull('voided_at');
    const paymentLines = await trx
      .table('folio_line_items')
      .where({ type: 'payment', business_date: businessDate })
      .whereNull('voided_at');

    const roomRevenue = sumMoney(roomChargeLines.map((l) => l.amount));
    const paymentsCollected = negateMoney(sumMoney(paymentLines.map((l) => l.amount)));

    // Step 9: the daily_reports snapshot — occupancy/ADR/RevPAR against the
    // REAL ledger (roomChargeLines.length, not a reservation_daily_rates
    // snapshot — see the daily_reports migration's own header for why this
    // differs from Reporting's own live-computed figures for a still-open date).
    const physicalCount = await livePhysicalCount({ db: trx, stayDate: businessDate });
    const inventoryRows = await trx.table('room_type_inventory').where({ stay_date: businessDate });
    const roomsSold = inventoryRows.reduce((total, row) => total + row.rooms_sold, 0);
    const occupancyPct = physicalCount > 0 ? Number(((roomsSold / physicalCount) * 100).toFixed(2)) : 0;
    const adr = divideMoney(roomRevenue, roomChargeLines.length);
    const revpar = divideMoney(roomRevenue, physicalCount);

    // Step 10: flag exceptions — open housekeeping discrepancies do not
    // block a LATER run (only a CURRENT one, per findBlockingConditions),
    // but still surface here for the day being closed.
    const openDiscrepancies = await trx.table('housekeeping_discrepancies').whereNull('resolved_at');
    for (const discrepancy of openDiscrepancies) {
      exceptions.push({ type: 'unresolved_housekeeping_discrepancy', roomId: discrepancy.room_id, discrepancyId: discrepancy.id });
    }

    const [dailyReportId] = await trx.table('daily_reports').insert({
      property_id: propertyId,
      night_audit_run_id: runId,
      business_date: businessDate,
      room_revenue: roomRevenue,
      pos_revenue: '0.00',
      payments_collected: paymentsCollected,
      occupancy_pct: occupancyPct,
      adr,
      revpar,
    });

    // Steps 11-12: close the date, advance the property's business date.
    const nextBusinessDate = addOneDay(businessDate);
    await trx.table('properties').where({ id: propertyId }).update({ current_business_date: nextBusinessDate });

    // Step 13: mark the run COMPLETED — this update and everything above
    // are the SAME transaction; nothing here survives a failure that
    // rolls it back.
    const now = new Date();
    await trx.table('night_audit_runs').where({ id: runId }).update({
      status: 'COMPLETED',
      completed_at: now,
      exceptions: JSON.stringify(exceptions),
    });

    await writeOutboxEvent({
      trx,
      eventType: 'night_audit.completed',
      aggregateType: 'night_audit_runs',
      aggregateId: runId,
      propertyId,
      payload: { businessDate, nextBusinessDate, roomRevenue, occupancyPct, exceptionCount: exceptions.length },
    });

    const dailyReport = await trx.table('daily_reports').where({ id: dailyReportId }).first();
    const run = await trx.table('night_audit_runs').where({ id: runId }).first();
    return { run, dailyReport, exceptions, nextBusinessDate };
  });
}

/**
 * The full sequence, §6.2. `context.propertyId` names which property closes
 * — the property's OWN `current_business_date` is always the date being
 * audited (ARCHITECTURE.md §6: "never wall-clock").
 */
async function runNightAudit({ context, userId }) {
  const db = scopedDb().for(context);
  const propertyId = context.propertyId;

  const property = await db.table('properties').where({ id: propertyId }).first();
  const businessDate = property.current_business_date;
  if (!businessDate) throw new PropertyNotOpenedError();

  const existing = await reconcileExistingRun({ db, propertyId, businessDate });
  const runId = await claimRun({ db, propertyId, businessDate, userId, existing });

  try {
    const blocking = await findBlockingConditions({ db, propertyId });
    if (blocking.length) throw new NightAuditBlockingConditionsError(blocking);

    return await runCriticalTransaction({ db, propertyId, businessDate, runId });
  } catch (error) {
    // ARCHITECTURE.md §6.2: "the run row records FAILED with the error,
    // outside the rolled-back transaction, so the failure itself is never
    // lost" — a plain statement, not part of the transaction that just rolled back.
    await db.table('night_audit_runs').where({ id: runId }).update({
      status: 'FAILED',
      failed_at: new Date(),
      error: String(error?.message ?? error),
    });
    throw error;
  }
}

async function getRun({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('night_audit_runs').where({ id }).first();
}

async function listRuns({ context }) {
  const db = scopedDb().for(context);
  return db.table('night_audit_runs').orderBy('business_date', 'desc');
}

async function getDailyReport({ context, businessDate }) {
  const db = scopedDb().for(context);
  return db.table('daily_reports').where({ business_date: businessDate }).first();
}

module.exports = {
  WORKER_ID,
  STALE_TIMEOUT_MS,
  addOneDay,
  findBlockingConditions,
  reconcileExistingRun,
  claimRun,
  runNightAudit,
  getRun,
  listRuns,
  getDailyReport,
};
