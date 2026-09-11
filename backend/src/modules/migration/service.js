'use strict';

/**
 * Data migration service — PLAN.md Phase 5's last unbuilt bullet,
 * PRODUCT_REQUIREMENTS.md §3.20. Owns everything synchronous: creating a
 * run from an uploaded file, the dry run itself, recording a duplicate-
 * guest resolution, triggering a commit (the actual row-by-row work runs
 * in `src/jobs/data-import.js`, mirroring `tenant-data-export.js`'s own
 * "the job file owns the heavy per-record work" shape), and rollback.
 *
 * ── DRY RUN IS SYNCHRONOUS, NOT A JOB ────────────────────────────────────
 *
 * A dry run is pure parse-and-validate against already-loaded reference
 * data — no external call, no long lock — the same order of magnitude as
 * Setup's existing synchronous bulk-room-add. There is no genuine reason to
 * hop through Redis/BullMQ for it. It is safely RE-RUNNABLE: every call
 * deletes and re-inserts this run's own `import_row_errors` rows, carrying
 * forward any duplicate-guest `resolution` already recorded for a row that
 * is still a duplicate candidate on the re-run (matched by row_number) — so
 * re-running dry run after reference data changes never silently discards
 * an operator's earlier decision.
 *
 * ── WHICH PROPERTY A RUN'S OWN QUERIES ARE SCOPED TO ─────────────────────
 *
 * `import_runs`/`import_row_errors`/`imported_record_map` are all
 * TENANT_SCOPED — reached through the caller's own `context` directly, no
 * special handling needed. But a `reservations`/`ar_balances` run's
 * PROPERTY_SCOPED reads/writes (room types, rate codes, reservations,
 * folios, AR accounts/invoices) must be scoped to `import_runs.property_id`
 * — NOT necessarily the caller's own currently-active property (an admin
 * can run a migration against a property that isn't the one they happen to
 * have selected right now). `runScopedDb` rebuilds a worker-shaped context
 * pinned to the run's own `(tenant_id, property_id)` rather than trusting
 * `context.propertyId` — the same `workerContext()` constructor
 * `src/jobs/*` already uses for the identical "I already know the real
 * scope, it doesn't come from the caller's own session" reason. This also
 * means every ordinary `.table()` call below (no `.acrossProperties()`
 * needed anywhere in this file) is already correctly scoped.
 */

const { scopedDb } = require('../../db');
const { workerContext } = require('../tenancy');
const { ValidationError } = require('../../shared/errors');
const { parseImportFile } = require('./parse');
const { columnsForEntityType, ENTITY_TYPES } = require('./templates');
const { findDuplicateCandidates, matchExistingGuestByContact, matchExistingCompanyByEmail } = require('./dedup');
const { validateGuestRow, validateCompanyRow, validateReservationRow, validateArBalanceRow } = require('./validate');
const { sumMoney, negateMoney } = require('../../shared/money');
const { expandStayDates, releaseInventoryForDates } = require('../reservations/service');
const { recomputeArAccountBalance } = require('../ar/service');
const {
  UnknownEntityTypeError,
  MissingPropertyIdError,
  ImportRunNotFoundError,
  InvalidImportRunStateError,
  UnresolvedDuplicatesError,
  DuplicateRowNotFoundError,
  InvalidDuplicateResolutionError,
} = require('./errors');
const { enqueueDataImportJob } = require('../../jobs/data-import');

const PROPERTY_REQUIRED_ENTITY_TYPES = new Set(['reservations', 'ar_balances']);
const DRY_RUNNABLE_FROM_STATUSES = ['uploaded', 'dry_run_complete'];
const ROLLBACKABLE_FROM_STATUSES = ['completed', 'partially_rolled_back'];
/** Children before parents — see `rollbackImportRun`'s own comment. */
const ROLLBACK_ENTITY_ORDER = ['ar_invoice', 'reservation', 'ar_account', 'company_profile', 'guest'];

function trimmed(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}
function normalizedCode(value) {
  return trimmed(value).toUpperCase();
}
function codeMap(rows, codeField) {
  const map = new Map();
  for (const row of rows) map.set(normalizedCode(row[codeField]), row);
  return map;
}

/** See file header. `run.property_id` is null for guests/companies runs, which is fine — TENANT_SCOPED tables don't need one. */
function runScopedDb(context, run) {
  return scopedDb().for(workerContext({ tenantId: context.tenantId, propertyId: run.property_id ?? null }));
}

// ---------------------------------------------------------------------
// Create / get / list
// ---------------------------------------------------------------------

async function createImportRun({ context, entityType, propertyId, originalFilename, filePath }) {
  if (!ENTITY_TYPES.includes(entityType)) throw new UnknownEntityTypeError(entityType);
  const requiresProperty = PROPERTY_REQUIRED_ENTITY_TYPES.has(entityType);
  if (requiresProperty && !propertyId) throw new MissingPropertyIdError(entityType);

  const db = scopedDb().for(context);
  if (requiresProperty) {
    const property = await db.table('properties').where({ id: propertyId }).first('id');
    if (!property) throw new ValidationError('PROPERTY_NOT_FOUND', 'The specified property does not exist in this tenant.');
  }

  const [id] = await db.table('import_runs').insert({
    property_id: requiresProperty ? propertyId : null,
    entity_type: entityType,
    status: 'uploaded',
    original_filename: originalFilename,
    file_path: filePath,
    run_by_user_id: context.userId,
  });
  return db.table('import_runs').where({ id }).first();
}

async function getImportRun({ context, importRunId }) {
  const db = scopedDb().for(context);
  const run = await db.table('import_runs').where({ id: importRunId }).first();
  if (!run) return null;
  const errors = await db.table('import_row_errors').where({ import_run_id: importRunId }).orderBy('row_number');
  return { run, errors };
}

async function listImportRuns({ context, entityType, status }) {
  const db = scopedDb().for(context);
  let query = db.table('import_runs');
  if (entityType) query = query.where({ entity_type: entityType });
  if (status) query = query.where({ status });
  return query.orderBy('id', 'desc');
}

// ---------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------

/** How many nights of `roomTypeId` are already sold at/over threshold across `arrivalDate..departureDate` — informational only (§3.20: "shown as warnings before commit"), so this deliberately skips the OOO/discrepancy exclusion `livePhysicalCount` applies for a REAL booking's own enforcement. */
async function findOversoldNights({ db, roomTypeId, arrivalDate, departureDate }) {
  const stayDates = expandStayDates(arrivalDate, departureDate);
  const conflicts = [];
  for (const stayDate of stayDates) {
    const inventoryRow = await db.table('room_type_inventory').where({ room_type_id: roomTypeId, stay_date: stayDate }).first();
    const physicalCount = await db.table('rooms').where({ room_type_id: roomTypeId, status: 'active' }).count();
    const thresholdPct = inventoryRow ? Number(inventoryRow.overbooking_threshold_pct) : 100;
    const roomsSold = inventoryRow ? inventoryRow.rooms_sold : 0;
    const threshold = Math.floor((physicalCount * thresholdPct) / 100);
    if (roomsSold + 1 > threshold) conflicts.push(stayDate);
  }
  return conflicts;
}

async function runDryRun({ context, importRunId }) {
  const outerDb = scopedDb().for(context);
  const run = await outerDb.table('import_runs').where({ id: importRunId }).first();
  if (!run) throw new ImportRunNotFoundError();
  if (!DRY_RUNNABLE_FROM_STATUSES.includes(run.status)) throw new InvalidImportRunStateError(run.status, DRY_RUNNABLE_FROM_STATUSES);

  const db = runScopedDb(context, run);
  const rows = parseImportFile(run.file_path);

  const priorResolutions = new Map(
    (await outerDb.table('import_row_errors').where({ import_run_id: importRunId, severity: 'duplicate_candidate' }).whereNotNull('resolution')).map(
      (row) => [row.row_number, { resolution: row.resolution, resolved_guest_id: row.resolved_guest_id }]
    )
  );

  const findings = [];
  let rowsWithBlockingErrors = 0;

  function addErrors(rowNumber, errors) {
    if (!errors.length) return false;
    rowsWithBlockingErrors += 1;
    for (const error of errors) {
      findings.push({ row_number: rowNumber, column_name: error.columnName, severity: 'error', message: error.message });
    }
    return true;
  }

  if (run.entity_type === 'guests') {
    const existingGuests = await outerDb.table('guests').select('id', 'first_name', 'last_name', 'email', 'phone', 'date_of_birth');
    for (const row of rows) {
      if (addErrors(row.__rowNumber, validateGuestRow(row))) continue;
      const candidate = findDuplicateCandidates({ importedRow: row, existingGuests });
      if (candidate) {
        const prior = priorResolutions.get(row.__rowNumber);
        const tierLabel = candidate.tier === 'name_dob' ? 'name + date of birth' : candidate.tier;
        findings.push({
          row_number: row.__rowNumber,
          column_name: null,
          severity: 'duplicate_candidate',
          message: `Matches ${candidate.matches.length} existing guest(s) on ${tierLabel} (id${candidate.matches.length > 1 ? 's' : ''}: ${candidate.matches.map((m) => m.id).join(', ')}).`,
          resolution: prior?.resolution ?? null,
          resolved_guest_id: prior?.resolved_guest_id ?? null,
        });
      }
    }
  } else if (run.entity_type === 'companies') {
    for (const row of rows) addErrors(row.__rowNumber, validateCompanyRow(row));
  } else if (run.entity_type === 'reservations') {
    const property = await db.table('properties').where({ id: run.property_id }).first('current_business_date');
    const roomTypes = codeMap(await db.table('room_types').where({ status: 'active' }), 'code');
    const rateCodes = codeMap(await db.table('rate_codes').where({ status: 'active' }), 'code');
    const existingGuests = await outerDb.table('guests').select('id', 'first_name', 'last_name', 'email', 'phone');

    for (const row of rows) {
      const guestMatch = matchExistingGuestByContact({ email: row.guest_email, phone: row.guest_phone }, existingGuests);
      const roomType = roomTypes.get(normalizedCode(row.room_type_code));
      const rateCode = rateCodes.get(normalizedCode(row.rate_code));
      const errors = validateReservationRow(row, { guestMatch, roomTypeExists: Boolean(roomType), rateCodeExists: Boolean(rateCode) });
      if (addErrors(row.__rowNumber, errors)) continue;

      const arrivalDate = trimmed(row.arrival_date);
      const departureDate = trimmed(row.departure_date);
      const isHistorical = property.current_business_date ? departureDate <= property.current_business_date : false;
      if (!isHistorical) {
        const conflictDates = await findOversoldNights({ db, roomTypeId: roomType.id, arrivalDate, departureDate });
        if (conflictDates.length) {
          findings.push({
            row_number: row.__rowNumber,
            column_name: null,
            severity: 'availability_conflict',
            message: `This booking would oversell room type "${trimmed(row.room_type_code)}" on: ${conflictDates.join(', ')}. Not blocking — commit will still create it if confirmed.`,
          });
        }
      }
    }
  } else if (run.entity_type === 'ar_balances') {
    const companies = await outerDb.table('company_profiles').select('id', 'name', 'billing_email');
    for (const row of rows) {
      const companyMatch = matchExistingCompanyByEmail(row.company_email, companies);
      addErrors(row.__rowNumber, validateArBalanceRow(row, { companyExists: Boolean(companyMatch) && companyMatch !== 'ambiguous' }));
    }
  }

  await outerDb.table('import_row_errors').where({ import_run_id: importRunId }).delete();
  if (findings.length) {
    await outerDb.table('import_row_errors').insert(
      findings.map((finding) => ({
        import_run_id: importRunId,
        row_number: finding.row_number,
        column_name: finding.column_name ?? null,
        severity: finding.severity,
        message: finding.message,
        resolution: finding.resolution ?? null,
        resolved_guest_id: finding.resolved_guest_id ?? null,
      }))
    );
  }

  const rowsTotal = rows.length;
  const rowsToSkip = rowsWithBlockingErrors;
  const rowsToCreate = rowsTotal - rowsToSkip;

  await outerDb.table('import_runs').where({ id: importRunId }).update({
    status: 'dry_run_complete',
    rows_total: rowsTotal,
    rows_created: rowsToCreate,
    rows_skipped: rowsToSkip,
  });

  return getImportRun({ context, importRunId });
}

// ---------------------------------------------------------------------
// Duplicate resolution — §3.20: "never auto-merge"
// ---------------------------------------------------------------------

async function resolveDuplicateRow({ context, importRunId, rowNumber, resolution, matchedGuestId }) {
  if (!['use_existing', 'create_new'].includes(resolution)) throw new InvalidDuplicateResolutionError();
  if (resolution === 'use_existing' && !matchedGuestId) throw new InvalidDuplicateResolutionError();

  const db = scopedDb().for(context);
  const run = await db.table('import_runs').where({ id: importRunId }).first();
  if (!run) return null;
  if (run.status !== 'dry_run_complete') throw new InvalidImportRunStateError(run.status, ['dry_run_complete']);

  const row = await db
    .table('import_row_errors')
    .where({ import_run_id: importRunId, row_number: rowNumber, severity: 'duplicate_candidate' })
    .first();
  if (!row) throw new DuplicateRowNotFoundError();

  if (resolution === 'use_existing') {
    const guest = await db.table('guests').where({ id: matchedGuestId }).first();
    if (!guest) throw new ValidationError('GUEST_NOT_FOUND', 'The specified guest does not exist in this tenant.');

    // Code-review finding: never trust a client-supplied matchedGuestId
    // just because it names a real guest somewhere in the tenant — verify
    // it's actually one of THIS row's own reported duplicate candidates,
    // recomputed fresh from the real file and the real current guest
    // roster (never parsed back out of the free-text `message`, which the
    // frontend only ever uses for display).
    const rows = parseImportFile(run.file_path);
    const importedRow = rows.find((candidateRow) => candidateRow.__rowNumber === rowNumber);
    if (!importedRow) throw new DuplicateRowNotFoundError();
    const existingGuests = await db.table('guests').select('id', 'first_name', 'last_name', 'email', 'phone', 'date_of_birth');
    const candidate = findDuplicateCandidates({ importedRow, existingGuests });
    const validCandidateIds = new Set((candidate?.matches ?? []).map((match) => String(match.id)));
    if (!validCandidateIds.has(String(matchedGuestId))) {
      throw new InvalidDuplicateResolutionError();
    }
  }

  await db.table('import_row_errors').where({ id: row.id }).update({
    resolution,
    resolved_guest_id: resolution === 'use_existing' ? matchedGuestId : null,
  });

  return db.table('import_row_errors').where({ id: row.id }).first();
}

// ---------------------------------------------------------------------
// Commit — synchronous status flip + job trigger; the row-by-row work is
// `src/jobs/data-import.js`'s `runImportCommitJob`.
// ---------------------------------------------------------------------

async function commitImportRun({ context, importRunId }) {
  const db = scopedDb().for(context);
  const run = await db.table('import_runs').where({ id: importRunId }).first();
  if (!run) throw new ImportRunNotFoundError();

  const unresolved = await db
    .table('import_row_errors')
    .where({ import_run_id: importRunId, severity: 'duplicate_candidate' })
    .whereNull('resolution')
    .select('row_number');
  if (unresolved.length) throw new UnresolvedDuplicatesError(unresolved.map((row) => row.row_number));

  const updated = await db.table('import_runs').where({ id: importRunId }).where({ status: 'dry_run_complete' }).update({ status: 'committing' });
  if (!updated) throw new InvalidImportRunStateError(run.status, ['dry_run_complete']);

  enqueueDataImportJob({ tenantId: context.tenantId, importRunId }).catch((error) => {
    console.error('Failed to enqueue data import job (the run will stay "committing" until manually re-triggered):', error);
  });

  return db.table('import_runs').where({ id: importRunId }).first();
}

// ---------------------------------------------------------------------
// Rollback — §3.20: "a run can be rolled back wholesale." This session's
// confirmed decision: delete everything still untouched, refuse and
// report the rest — an honest partial rollback, never a silent skip or a
// forced cascade delete of something with real downstream activity.
// ---------------------------------------------------------------------

async function rollbackOneRow({ context, run, mapRow }) {
  const db = runScopedDb(context, run);
  return db.transaction(async (trx) => {
    switch (mapRow.entity_type) {
      case 'guest': {
        // A guests-entity-type run's own `property_id` is null (guests are
        // TENANT_SCOPED, so a guests import has no single property) — this
        // trx's context therefore carries no active property either. Every
        // PROPERTY_SCOPED check below goes through `.acrossProperties()`
        // for that reason — a guest may hold real activity at ANY property
        // the tenant runs, not just one.
        //
        // Code-review finding: the original check only looked at
        // `reservations` — but `guest_accounts.guest_id` (a guest portal
        // login) and `import_row_errors.resolved_guest_id` (a LATER
        // import's dry run resolving a duplicate against this guest) are
        // both real RESTRICT foreign keys too. Missing either meant a
        // guest that had since registered for the portal, or been matched
        // by a subsequent import, hit a raw uncaught FK violation instead
        // of a graceful refusal.
        const referencingReservation = await trx.acrossProperties().table('reservations').where({ guest_id: mapRow.entity_id }).first();
        if (referencingReservation) return { ok: false, reason: 'A reservation now references this guest.' };
        const referencingGuestAccount = await trx.acrossProperties().table('guest_accounts').where({ guest_id: mapRow.entity_id }).first();
        if (referencingGuestAccount) return { ok: false, reason: 'A guest portal account now references this guest.' };
        const referencingImportError = await trx.table('import_row_errors').where({ resolved_guest_id: mapRow.entity_id }).first();
        if (referencingImportError) return { ok: false, reason: "A later import's duplicate-guest resolution now references this guest." };
        await trx.table('guests').where({ id: mapRow.entity_id }).delete();
        return { ok: true };
      }

      case 'reservation': {
        const reservation = await trx.table('reservations').where({ id: mapRow.entity_id }).first();
        if (!reservation) return { ok: true }; // already gone — nothing left to reverse
        if (['checked_in', 'checked_out'].includes(reservation.status)) {
          return { ok: false, reason: `This reservation is already ${reservation.status} and cannot be removed.` };
        }
        // Code-review finding: the original check only inspected the
        // FIRST folio via `.first()` — a reservation can have more than
        // one (split billing, cashiering's own `openAdditionalFolio`).
        // Check every folio, not just one.
        const folios = await trx.table('folios').where({ reservation_id: reservation.id });
        for (const folio of folios) {
          const charge = await trx.table('folio_line_items').where({ folio_id: folio.id }).first();
          if (charge) return { ok: false, reason: 'A folio with real charges exists against this reservation.' };
        }

        // Code-review finding: this used to re-derive "did this row hold
        // real inventory" from the property's CURRENT business date, which
        // can have advanced (Night Audit runs daily) between commit and
        // rollback — a one-directional leak. `inventory_reserved` is the
        // frozen, true fact recorded at commit time; see the migration's
        // own header.
        if (mapRow.inventory_reserved) {
          const dailyRates = await trx.table('reservation_daily_rates').where({ reservation_id: reservation.id });
          await releaseInventoryForDates({ trx, roomTypeId: reservation.room_type_id, stayDates: dailyRates.map((rate) => rate.stay_date) });
        }

        for (const folio of folios) await trx.table('folios').where({ id: folio.id }).delete();
        await trx.table('reservation_rooms').where({ reservation_id: reservation.id }).delete();
        await trx.table('reservation_daily_rates').where({ reservation_id: reservation.id }).delete();
        // `reservation_notes` is plain reservation-owned metadata, not
        // financial or audit-significant history like a folio charge — the
        // same tier as `reservation_rooms`/`reservation_daily_rates`
        // above, deleted along with the reservation rather than blocking
        // its rollback.
        await trx.table('reservation_notes').where({ reservation_id: reservation.id }).delete();
        await trx.table('reservations').where({ id: reservation.id }).delete();
        return { ok: true };
      }

      case 'company_profile': {
        // Same reasoning as the 'guest' case above — a companies-entity-
        // type run has no single property either, and a company may hold
        // activity at any property the tenant runs.
        //
        // Code-review finding: the original check only looked at
        // `ar_accounts` — `guests.company_profile_id` (set via the real
        // `POST /guests/:id/link-company` route), `folios.company_profile_id`
        // (a folio billed directly to the company), and
        // `group_blocks.company_profile_id` (the company sponsoring a real
        // group block) are all real RESTRICT foreign keys too.
        const referencingArAccount = await trx.acrossProperties().table('ar_accounts').where({ company_profile_id: mapRow.entity_id }).first();
        if (referencingArAccount) return { ok: false, reason: 'An AR account now references this company.' };
        const referencingGuest = await trx.table('guests').where({ company_profile_id: mapRow.entity_id }).first();
        if (referencingGuest) return { ok: false, reason: 'A guest is now linked to this company.' };
        const referencingFolio = await trx.acrossProperties().table('folios').where({ company_profile_id: mapRow.entity_id }).first();
        if (referencingFolio) return { ok: false, reason: 'A folio is now billed directly to this company.' };
        const referencingGroupBlock = await trx.acrossProperties().table('group_blocks').where({ company_profile_id: mapRow.entity_id }).first();
        if (referencingGroupBlock) return { ok: false, reason: 'A group block is now sponsored by this company.' };
        await trx.table('company_profiles').where({ id: mapRow.entity_id }).delete();
        return { ok: true };
      }

      case 'ar_invoice': {
        const invoice = await trx.table('ar_invoices').where({ id: mapRow.entity_id }).first();
        if (!invoice) return { ok: true };
        const applied = await trx.table('ar_payment_applications').where({ ar_invoice_id: invoice.id }).first();
        if (applied) return { ok: false, reason: 'A payment has been applied against this migrated invoice.' };

        const lines = await trx.table('ar_invoice_lines').where({ ar_invoice_id: invoice.id });
        const totalAmount = sumMoney(lines.map((line) => line.amount));
        await trx.table('ar_invoice_lines').where({ ar_invoice_id: invoice.id }).delete();
        await trx.table('ar_invoices').where({ id: invoice.id }).delete();

        const account = await trx.table('ar_accounts').where({ id: invoice.ar_account_id }).forUpdate().first();
        if (account) {
          // Code-review finding: this used to hand-roll the
          // current_balance/is_over_limit update inline — a second writer
          // of a column this codebase's own convention (and
          // `recomputeArAccountBalance`'s own header) says has exactly
          // one. Only `opening_balance_imported` (this invoice's own real
          // contribution, reversed — never the whole column, which may
          // still carry a different run's standing contribution) is
          // written directly; `current_balance`/`is_over_limit` are always
          // re-derived from scratch, the same single-source-of-truth
          // mechanism every other AR mutation in this codebase uses.
          await trx.table('ar_accounts').where({ id: account.id }).update({
            opening_balance_imported: sumMoney([account.opening_balance_imported, negateMoney(totalAmount)]),
          });
          await recomputeArAccountBalance({ trx, arAccountId: account.id });
        }
        return { ok: true };
      }

      case 'ar_account': {
        const account = await trx.table('ar_accounts').where({ id: mapRow.entity_id }).first();
        if (!account) return { ok: true };
        const anyInvoice = await trx.table('ar_invoices').where({ ar_account_id: account.id }).first();
        if (anyInvoice) return { ok: false, reason: 'This AR account still has an invoice against it.' };
        const anyPayment = await trx.table('ar_payments').where({ ar_account_id: account.id }).first();
        if (anyPayment) return { ok: false, reason: 'A real payment has been recorded against this AR account.' };
        await trx.table('ar_accounts').where({ id: account.id }).delete();
        return { ok: true };
      }

      default:
        return { ok: false, reason: `Unknown entity type "${mapRow.entity_type}".` };
    }
  });
}

async function rollbackImportRun({ context, importRunId, userId }) {
  const outerDb = scopedDb().for(context);
  const run = await outerDb.table('import_runs').where({ id: importRunId }).first();
  if (!run) return null;
  if (!ROLLBACKABLE_FROM_STATUSES.includes(run.status)) throw new InvalidImportRunStateError(run.status, ROLLBACKABLE_FROM_STATUSES);

  const mapRows = await outerDb.table('imported_record_map').where({ import_run_id: importRunId, created: true });
  mapRows.sort((a, b) => ROLLBACK_ENTITY_ORDER.indexOf(a.entity_type) - ROLLBACK_ENTITY_ORDER.indexOf(b.entity_type));

  let rowsRolledBack = 0;
  const rowsRefused = [];

  for (const mapRow of mapRows) {
    // Code-review finding: an unhandled exception here (e.g. a real FK
    // constraint the refuse-checks above don't already anticipate) used to
    // escape the whole loop uncaught — crashing the entire rollback
    // request with a stale run status and no report, for what §3.20 itself
    // promises is a "wholesale" rollback that should never just blow up.
    // Every row's own attempt is now isolated: an unexpected failure is
    // recorded as an ordinary refusal (this row stays in
    // `imported_record_map` for a future retry), and the loop — and the
    // rest of this run's own rollback — continues.
    let result;
    try {
      result = await rollbackOneRow({ context, run, mapRow });
    } catch (error) {
      result = { ok: false, reason: `Could not be rolled back: ${error?.message || error}` };
    }
    if (result.ok) {
      rowsRolledBack += 1;
      await outerDb.table('imported_record_map').where({ id: mapRow.id }).delete();
    } else {
      rowsRefused.push({ entityType: mapRow.entity_type, entityId: String(mapRow.entity_id), rowNumber: mapRow.row_number, reason: result.reason });
    }
  }

  const finalStatus = rowsRefused.length === 0 ? 'rolled_back' : 'partially_rolled_back';
  await outerDb.table('import_runs').where({ id: importRunId }).update({
    status: finalStatus,
    rolled_back_at: new Date(),
    rolled_back_by_user_id: userId ?? null,
  });

  return { importRunId: String(importRunId), status: finalStatus, rowsRolledBack, rowsRefused };
}

module.exports = {
  ENTITY_TYPES,
  columnsForEntityType,
  createImportRun,
  getImportRun,
  listImportRuns,
  runDryRun,
  resolveDuplicateRow,
  commitImportRun,
  rollbackImportRun,
  runScopedDb,
};
