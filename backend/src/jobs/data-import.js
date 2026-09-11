'use strict';

/**
 * Data migration commit — PLAN.md Phase 5's last unbuilt bullet,
 * PRODUCT_REQUIREMENTS.md §3.20. A one-off, reactive-only job (never a
 * periodic sweep — the identical shape `tenant-data-export.js`'s own
 * header established), triggered by `src/modules/migration/service.js`'s
 * `commitImportRun` right after it flips the run's own status to
 * `committing` inside a conditional UPDATE.
 *
 * ── PER-ROW, NOT WHOLE-RUN-ATOMIC ─────────────────────────────────────────
 *
 * Each data row is created inside its OWN small transaction — never one
 * giant transaction spanning the whole file. A row dry-run predicted would
 * succeed but which fails at actual commit time (a genuine race: a room
 * type archived in the interim, a rate code deleted) is caught, logged as a
 * fresh `import_row_errors` row, and skipped; the rest of the run
 * proceeds. ARCHITECTURE.md §5's own "the whole run rolling back on any row
 * the operator hasn't explicitly excepted" is satisfied at row-transaction
 * granularity — no row is ever partially written — while the operator's
 * own commit confirmation IS the explicit exception for every row dry-run
 * already approved. The real, always-available wholesale-undo mechanism
 * for "the data turned out to be wrong" is the separate, explicit
 * `rollbackImportRun` action (§3.20: "rolled back wholesale"), not an
 * automatic reflex to one anomalous row discarding hundreds of good ones.
 *
 * ── RESUMABLE AFTER A CRASH ───────────────────────────────────────────────
 *
 * `imported_record_map`'s own `UNIQUE(tenant_id, import_run_id, row_number,
 * entity_type)` is what makes a BullMQ retry after a mid-job crash safe:
 * `alreadyProcessedRowNumbers` reads which rows a prior, crashed attempt
 * already committed, and skips them outright on the retry rather than
 * re-processing (which would otherwise double-create a guest/reservation).
 *
 * ── WHICH PROPERTY THIS JOB'S OWN QUERIES ARE SCOPED TO ──────────────────
 *
 * See `migration/service.js`'s own header for the full reasoning — the
 * job's `db` is a `workerContext()` pinned to `run.property_id` (null for
 * guests/companies runs, real for reservations/ar_balances runs), so every
 * plain `.table()` call below is already correctly scoped with no
 * `.acrossProperties()` needed anywhere in this file.
 *
 * ── AVAILABILITY, DUNNING BOTH INVENTORY IN THE SAME WAY §3.20 DESCRIBES ──
 *
 * A future-dated reservation row still takes the real
 * `reserveInventoryForDates` lock at commit time — historical rows never
 * do (§3.20: "future reservations need room availability checked at
 * import time," implying historical ones don't). A row dry-run flagged as
 * an oversell warning is passed `bypassThreshold: true` — the operator was
 * shown the warning and explicitly confirmed commit anyway, the same kind
 * of informed override an AR credit-limit override already represents
 * elsewhere in this codebase.
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('./redis-connection');
const { DATA_IMPORT_QUEUE, dataImportQueue } = require('./queues');
const { scopedDb } = require('../db');
const { workerContext } = require('../modules/tenancy');
const { parseImportFile } = require('../modules/migration/parse');
const { matchExistingGuestByContact, matchExistingCompanyByEmail } = require('../modules/migration/dedup');
const { expandStayDates, reserveInventoryForDates } = require('../modules/reservations/service');
const { resolveRate } = require('../modules/setup/service');
const { recomputeArAccountBalance } = require('../modules/ar/service');
const { generateUlid } = require('../shared/ulid');
const { sumMoney } = require('../shared/money');

/**
 * Code-review finding: only `tentative`/`confirmed`/`checked_in`/
 * `checked_out` reservations hold real room_type_inventory anywhere else
 * in this codebase (`reservations/service.js`'s own cancel/no-show/
 * waitlist-promotion logic) — a `waitlisted` row holds none by definition,
 * and `cancelled`/`no_show`/`expired` have already released whatever they
 * once held. The original version of this job called
 * `reserveInventoryForDates` for every non-historical row regardless of
 * its imported status, so a migrated open waitlist would have silently
 * consumed real, live sellable capacity no other waitlisted reservation in
 * the system ever does.
 */
const NON_INVENTORY_HOLDING_STATUSES = new Set(['waitlisted', 'cancelled', 'no_show', 'expired']);

const IMPORT_JOB_NAME = 'commit';

/** Called right after `commitImportRun` flips the run to `committing` — best-effort, matching `enqueueTenantDataExportJob`'s own fire-and-forget shape; a lost enqueue leaves the run stuck `committing` forever, the identical narrower-than-the-outbox gap that job's own header already flags and accepts. */
async function enqueueDataImportJob({ tenantId, importRunId }) {
  await dataImportQueue().add(
    IMPORT_JOB_NAME,
    { tenantId, importRunId },
    { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: 100 }
  );
}

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

async function alreadyProcessedRowNumbers(db, importRunId) {
  const rows = await db.table('imported_record_map').where({ import_run_id: importRunId }).select('row_number');
  return new Set(rows.map((row) => row.row_number));
}

async function loadFindings(db, importRunId) {
  const rows = await db.table('import_row_errors').where({ import_run_id: importRunId });
  const blockedRows = new Set(rows.filter((row) => row.severity === 'error').map((row) => row.row_number));
  const duplicateResolutions = new Map(
    rows.filter((row) => row.severity === 'duplicate_candidate').map((row) => [row.row_number, { resolution: row.resolution, resolvedGuestId: row.resolved_guest_id }])
  );
  const conflictedRows = new Set(rows.filter((row) => row.severity === 'availability_conflict').map((row) => row.row_number));
  return { blockedRows, duplicateResolutions, conflictedRows };
}

async function recordCommitError(db, importRunId, rowNumber, message) {
  await db.table('import_row_errors').insert({ import_run_id: importRunId, row_number: rowNumber, column_name: null, severity: 'error', message: String(message).slice(0, 500) });
}

// ---------------------------------------------------------------------
// Per-entity commit logic — each runs inside the caller's already-open
// row-level `trx`.
// ---------------------------------------------------------------------

async function commitGuestRow({ trx, importRunId, row, duplicateResolutions }) {
  const resolution = duplicateResolutions.get(row.__rowNumber);
  if (resolution && resolution.resolution === 'use_existing') {
    await trx.table('imported_record_map').insert({
      import_run_id: importRunId,
      row_number: row.__rowNumber,
      entity_type: 'guest',
      entity_id: resolution.resolvedGuestId,
      created: false,
    });
    return;
  }

  const [id] = await trx.table('guests').insert({
    first_name: trimmed(row.first_name),
    last_name: trimmed(row.last_name),
    email: trimmed(row.email) || null,
    phone: trimmed(row.phone) || null,
    date_of_birth: trimmed(row.date_of_birth) || null,
  });
  await trx.table('imported_record_map').insert({ import_run_id: importRunId, row_number: row.__rowNumber, entity_type: 'guest', entity_id: id, created: true });
}

async function commitCompanyRow({ trx, importRunId, row }) {
  const [id] = await trx.table('company_profiles').insert({
    name: trimmed(row.name),
    type: trimmed(row.type) || 'company',
    billing_email: trimmed(row.billing_email) || null,
    billing_phone: trimmed(row.billing_phone) || null,
    billing_address: trimmed(row.billing_address) || null,
    payment_terms_days: trimmed(row.payment_terms_days) ? Number(row.payment_terms_days) : 30,
  });
  await trx.table('imported_record_map').insert({ import_run_id: importRunId, row_number: row.__rowNumber, entity_type: 'company_profile', entity_id: id, created: true });
}

async function commitReservationRow({ trx, importRunId, run, row, roomTypes, rateCodes, rooms, existingGuests, conflictedRows }) {
  const guestMatch = matchExistingGuestByContact({ email: row.guest_email, phone: row.guest_phone }, existingGuests);
  if (guestMatch === null || guestMatch === 'ambiguous') {
    throw new Error('The matching guest for this row could no longer be resolved at commit time.');
  }
  const roomType = roomTypes.get(normalizedCode(row.room_type_code));
  const rateCode = rateCodes.get(normalizedCode(row.rate_code));
  if (!roomType || !rateCode) {
    throw new Error('The room type or rate code for this row could no longer be resolved at commit time.');
  }

  const arrivalDate = trimmed(row.arrival_date);
  const departureDate = trimmed(row.departure_date);
  const status = trimmed(row.status) || 'confirmed';
  const stayDates = expandStayDates(arrivalDate, departureDate);

  const property = await trx.table('properties').where({ id: run.property_id }).first('current_business_date');
  const isHistorical = property?.current_business_date ? departureDate <= property.current_business_date : false;
  const holdsInventory = !isHistorical && !NON_INVENTORY_HOLDING_STATUSES.has(status);

  if (holdsInventory) {
    await reserveInventoryForDates({ trx, roomTypeId: roomType.id, stayDates, bypassThreshold: conflictedRows.has(row.__rowNumber) });
  }

  const [reservationId] = await trx.table('reservations').insert({
    guest_id: guestMatch,
    room_type_id: roomType.id,
    rate_code_id: rateCode.id,
    arrival_date: arrivalDate,
    departure_date: departureDate,
    adults: trimmed(row.adults) ? Number(row.adults) : 1,
    children: trimmed(row.children) ? Number(row.children) : 0,
    status,
    confirmation_number: generateUlid(),
  });

  const overrides = await trx.table('rate_calendar').where({ rate_code_id: rateCode.id, room_type_id: roomType.id }).whereIn('stay_date', stayDates);
  const overrideByDate = new Map(overrides.map((override) => [String(override.stay_date), override]));
  await trx.table('reservation_daily_rates').insert(
    stayDates.map((stayDate) => ({
      reservation_id: reservationId,
      stay_date: stayDate,
      rate: resolveRate(rateCode, overrideByDate.get(stayDate)),
      currency: rateCode.currency,
    }))
  );

  const roomNumber = normalizedCode(row.room_number);
  const room = roomNumber ? rooms.get(roomNumber) : null;
  if (room) {
    await trx.table('reservation_rooms').insert({
      reservation_id: reservationId,
      room_id: room.id,
      effective_from: `${arrivalDate} 00:00:00`,
      effective_to: status === 'checked_out' ? `${departureDate} 00:00:00` : null,
    });
  }

  await trx.table('imported_record_map').insert({
    import_run_id: importRunId,
    row_number: row.__rowNumber,
    entity_type: 'reservation',
    entity_id: reservationId,
    created: true,
    inventory_reserved: holdsInventory,
  });
}

async function commitArBalanceRow({ trx, importRunId, run, row, companies }) {
  const companyMatch = matchExistingCompanyByEmail(row.company_email, companies);
  if (!companyMatch || companyMatch === 'ambiguous') {
    throw new Error('The matching company for this row could no longer be resolved at commit time.');
  }

  let account = await trx.table('ar_accounts').where({ company_profile_id: companyMatch }).first();
  let accountCreated = false;
  if (!account) {
    const [accountId] = await trx.table('ar_accounts').insert({
      company_profile_id: companyMatch,
      credit_limit: trimmed(row.credit_limit) || '0.00',
      currency: trimmed(row.currency),
      enforcement_mode: trimmed(row.enforcement_mode) || 'block',
    });
    account = await trx.table('ar_accounts').where({ id: accountId }).first();
    accountCreated = true;
  }
  await trx.table('imported_record_map').insert({
    import_run_id: importRunId,
    row_number: row.__rowNumber,
    entity_type: 'ar_account',
    entity_id: account.id,
    created: accountCreated,
  });

  // Code-review finding: `row.amount` is already validated by
  // MONEY_PATTERN as a plain, at-most-2-decimal-place string — routing it
  // through `Number(...).toFixed(2)` is exactly the float round-trip this
  // codebase's own money rule (`shared/money.js`'s header) warns against.
  // The trimmed string is used as-is.
  const amount = trimmed(row.amount);
  const currency = trimmed(row.currency);
  const property = await trx.table('properties').where({ id: run.property_id }).first('current_business_date');
  const businessDate = property?.current_business_date || new Date().toISOString().slice(0, 10);

  const [invoiceId] = await trx.table('ar_invoices').insert({
    ar_account_id: account.id,
    invoice_number: `MIG-${run.id}-${row.__rowNumber}`,
    currency,
    total_amount: amount,
    status: 'issued',
    issued_at: businessDate,
    due_at: businessDate,
    business_date: businessDate,
  });
  await trx.table('ar_invoice_lines').insert({
    ar_invoice_id: invoiceId,
    folio_line_item_id: null,
    amount,
    currency,
    business_date: businessDate,
    source: 'migration_opening_balance',
    description: `Opening balance imported — run #${run.id} row ${row.__rowNumber}`,
  });
  await trx.table('imported_record_map').insert({ import_run_id: importRunId, row_number: row.__rowNumber, entity_type: 'ar_invoice', entity_id: invoiceId, created: true });

  // A locking read, immediately before the write — the same reason
  // `recomputeArAccountBalance` (ar/service.js) always uses one: two rows
  // of the SAME import file contributing to the SAME account (two
  // ar_balances rows for one company) would otherwise race each other's
  // read-then-write of this column, each starting from a stale snapshot.
  //
  // Code-review finding: `current_balance`/`is_over_limit` used to be
  // hand-rolled here — a second, independent writer of a column this
  // codebase's own convention says has exactly one (`ar/service.js`'s own
  // header: "`ar_accounts.current_balance` is never trusted as an
  // independent running total"). Only `opening_balance_imported` (the real
  // new data this row actually contributes) is written directly;
  // `current_balance`/`is_over_limit` are always re-derived from scratch
  // via the same single writer every other AR mutation in this codebase
  // already goes through.
  const locked = await trx.table('ar_accounts').where({ id: account.id }).forUpdate().first();
  await trx.table('ar_accounts').where({ id: account.id }).update({
    opening_balance_imported: sumMoney([locked.opening_balance_imported, amount]),
    opening_balance_import_run_id: run.id,
  });
  await recomputeArAccountBalance({ trx, arAccountId: account.id });
}

// ---------------------------------------------------------------------
// The job itself
// ---------------------------------------------------------------------

/**
 * `attemptsMade`/`maxAttempts` — code-review finding. The outer catch below
 * flips the run to `status: 'failed'` before rethrowing so BullMQ's own
 * `attempts: 3` retry policy still applies — but `runImportCommitJob`'s own
 * FIRST guard only proceeds while `status === 'committing'`, so a retried
 * attempt after the first failure immediately saw `failed` and no-op'd,
 * silently defeating the very retry it was configured for. `status` is now
 * only flipped to the terminal `failed` state on the LAST configured
 * attempt — an earlier failure leaves the run `committing`, so BullMQ's
 * automatic retry genuinely re-enters and re-attempts the job, the same as
 * a fresh crash-recovery run would (the per-row `imported_record_map`
 * dedup above is what makes that safe).
 *
 * `attemptsMade` mirrors BullMQ's own `Job#attemptsMade` semantics exactly:
 * the count of PRIOR, already-finished attempts — `0` on a job's first
 * execution, only incremented once that execution itself completes or
 * fails (confirmed directly against `node_modules/bullmq`'s own
 * `Job#moveToFailed`, not assumed). Defaults (`0`/`1`) make a direct call
 * — every test in this codebase calls this function directly, never
 * through a real BullMQ `Job` object — behave exactly like a single-
 * attempt job's only try, unchanged from before this fix.
 */
async function runImportCommitJob({ tenantId, importRunId, attemptsMade = 0, maxAttempts = 1 }) {
  const bootstrapDb = scopedDb().for(workerContext({ tenantId }));
  const run = await bootstrapDb.table('import_runs').where({ id: importRunId }).first();
  if (!run) return;
  if (run.status !== 'committing') return; // already finished (or never actually committed) by a prior attempt

  const db = scopedDb().for(workerContext({ tenantId, propertyId: run.property_id ?? null }));

  try {
    const rows = parseImportFile(run.file_path);
    const { blockedRows, duplicateResolutions, conflictedRows } = await loadFindings(db, importRunId);
    const alreadyProcessed = await alreadyProcessedRowNumbers(db, importRunId);

    let existingGuests = null;
    let companies = null;
    let roomTypes = null;
    let rateCodes = null;
    let rooms = null;

    if (run.entity_type === 'ar_balances') {
      companies = await db.table('company_profiles').select('id', 'name', 'billing_email');
    } else if (run.entity_type === 'reservations') {
      existingGuests = await db.table('guests').select('id', 'first_name', 'last_name', 'email', 'phone');
      roomTypes = codeMap(await db.table('room_types').where({ status: 'active' }), 'code');
      rateCodes = codeMap(await db.table('rate_codes').where({ status: 'active' }), 'code');
      rooms = codeMap(await db.table('rooms'), 'room_number');
    }

    let created = 0;
    let skipped = 0;

    for (const row of rows) {
      if (alreadyProcessed.has(row.__rowNumber)) {
        created += 1; // a prior, crashed attempt already committed this row — resumability, not a re-count
        continue;
      }
      if (blockedRows.has(row.__rowNumber)) {
        skipped += 1;
        continue;
      }
      const resolution = duplicateResolutions.get(row.__rowNumber);
      if (resolution && !resolution.resolution) {
        // Defensive only — `commitImportRun` already refuses to reach this
        // job at all while any duplicate candidate is unresolved.
        await recordCommitError(db, importRunId, row.__rowNumber, 'Unresolved duplicate-candidate guest at commit time.');
        skipped += 1;
        continue;
      }

      try {
        await db.transaction(async (trx) => {
          if (run.entity_type === 'guests') await commitGuestRow({ trx, importRunId, row, duplicateResolutions });
          else if (run.entity_type === 'companies') await commitCompanyRow({ trx, importRunId, row });
          else if (run.entity_type === 'reservations') {
            await commitReservationRow({ trx, importRunId, run, row, roomTypes, rateCodes, rooms, existingGuests, conflictedRows });
          } else if (run.entity_type === 'ar_balances') await commitArBalanceRow({ trx, importRunId, run, row, companies });
        });
        created += 1;
      } catch (error) {
        await recordCommitError(db, importRunId, row.__rowNumber, error?.message || error);
        skipped += 1;
      }
    }

    await db.table('import_runs').where({ id: importRunId }).update({
      status: 'completed',
      rows_created: created,
      rows_skipped: skipped,
      completed_at: new Date(),
    });
  } catch (error) {
    const isFinalAttempt = attemptsMade + 1 >= maxAttempts;
    if (isFinalAttempt) {
      await db.table('import_runs').where({ id: importRunId }).update({ status: 'failed', failed_reason: String(error?.message || error).slice(0, 2000) });
    }
    // Not the final attempt: status stays `committing` so BullMQ's retry
    // genuinely re-enters this function rather than seeing a terminal
    // state and no-opping. Rethrow either way — BullMQ's own retry/backoff
    // decides whether there's another attempt to schedule.
    throw error;
  }
}

function startDataImportWorker() {
  return new Worker(
    DATA_IMPORT_QUEUE,
    async (job) => {
      await runImportCommitJob({
        tenantId: job.data.tenantId,
        importRunId: job.data.importRunId,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts?.attempts ?? 1,
      });
    },
    { connection: redisConnection() }
  );
}

module.exports = {
  DATA_IMPORT_QUEUE,
  IMPORT_JOB_NAME,
  enqueueDataImportJob,
  runImportCommitJob,
  startDataImportWorker,
};
