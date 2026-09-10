'use strict';

/**
 * Accounts Receivable service — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md
 * §3.9 ("Company invoicing, credit management, outstanding balance
 * tracking, payment collection workflows"), TESTING.md AR-1/AR-2/AR-3.
 *
 * ── THE ACCOUNT BALANCE ──────────────────────────────────────────────────
 *
 * `ar_accounts.current_balance` is never trusted as an independent running
 * total — `recomputeArAccountBalance` (below) is the ONLY writer, and
 * always re-derives it from scratch: the sum of every non-voided
 * charge-type `folio_line_items` row on a folio billed to this account,
 * minus the sum of every non-voided `ar_payments.amount` for this account.
 * The full payment amount reduces exposure the moment it is recorded,
 * regardless of how much of it has been *applied* to a specific invoice —
 * `ar_payment_applications` is bookkeeping allocation only (which invoice
 * shows partially_paid/paid), never a second, disagreeing notion of how
 * much the company really owes. Voiding an invoice does not itself change
 * this balance — an invoice is a paperwork/collections summary layered on
 * top of charges that remain owed regardless of its own status; only
 * voiding the underlying charge (blocked once invoiced — see
 * `cashiering/service.js`'s `voidLineItem`) or recording a payment changes
 * what is actually owed.
 *
 * ── THE CREDIT-LIMIT RACE (ARCHITECTURE.md §5) ──────────────────────────
 *
 * `assertWithinCreditLimit` takes a `SELECT ... FOR UPDATE` lock on the
 * `ar_accounts` row before evaluating anything — the same lock
 * `generateInvoice` also takes before its own eligibility read, so a single
 * lock point serializes every real committer of exposure against an
 * account (two concurrent charges) AND every concurrent "generate an
 * invoice for this account" call, rather than inventing a second lock for
 * the latter.
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { withDuplicateMapping } = require('../../shared/errors');
const { writeOutboxEvent } = require('../../shared/outbox');
const { sumMoney, negateMoney, compareMoney } = require('../../shared/money');
const { computeAgeingBuckets, formatInvoiceNumber, BUCKET_KEYS } = require('./ageing');
const {
  CreditLimitExceededError,
  ArAccountNotFoundError,
  CompanyProfileNotFoundError,
  NoChargesToInvoiceError,
  InvoiceAlreadyVoidError,
  PaymentApplicationExceedsInvoiceError,
  PaymentApplicationExceedsPaymentError,
  PaymentAlreadyVoidError,
  CreditLimitOverrideReasonRequiredError,
} = require('./errors');

const CHARGE_TYPES_FOR_AR_BALANCE = ['room_charge', 'pos_charge', 'tax', 'adjustment'];
const INVOICEABLE_TYPES = ['room_charge', 'pos_charge', 'tax', 'adjustment'];

// ---------------------------------------------------------------------
// Shared small helpers — deliberately duplicated from
// cashiering/service.js's own `propertyBusinessDate` rather than imported,
// since `ar/service.js` must not import from `cashiering/service.js`
// (cashiering imports THIS module, not the other way — see this module's
// wiring in cashiering/service.js's own header).
// ---------------------------------------------------------------------

async function propertyBusinessDate({ trx, propertyId }) {
  const property = await trx.table('properties').where({ id: propertyId }).first();
  return property?.current_business_date ?? null;
}

function addDays(dateString, days) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// AR accounts
// ---------------------------------------------------------------------

/**
 * Re-derives current_balance and is_over_limit from scratch — see file
 * header. The only writer of both columns. Returns the computed values
 * directly rather than re-selecting the row after writing it — the same
 * "trust what you just computed and wrote, don't re-round-trip for it"
 * shape `cashiering/service.js`'s own `recomputeFolioBalance` already
 * uses. This isn't just a style match: this module's own concurrency test
 * caught a real, reproducible anomaly where a `SELECT` issued immediately
 * after this function's own `UPDATE`, on the very same transaction/
 * connection, returned the PRE-update value under genuine two-connection
 * load (never under the single-shared-transaction test harness every other
 * test file in this suite uses) — a real environment/driver-level
 * read-your-own-write hazard, not a logic bug in the update itself (the
 * generated SQL and its bound values were confirmed correct). Returning
 * the in-memory computed values sidesteps it entirely rather than working
 * around it, and is strictly fewer round trips besides.
 *
 * Every read here is a LOCKING read (`.forUpdate()`), not a plain SELECT:
 * `assertWithinCreditLimit` calls this immediately after taking
 * `ar_accounts`' own row lock, from inside a transaction that may have
 * started (and established its REPEATABLE READ snapshot) before a
 * concurrent committer's charge/payment landed. A plain SELECT would keep
 * reading that ORIGINAL snapshot even after the account row lock is
 * acquired — a locking read is what actually bypasses it and sees the
 * latest committed data, the same bug class this codebase's own POS module
 * already hit and documented once (`pos/service.js`'s void/settlement
 * recheck).
 */
async function recomputeArAccountBalance({ trx, arAccountId }) {
  const account = await trx.table('ar_accounts').where({ id: arAccountId }).forUpdate().first();
  if (!account) return null;

  const charges = await trx
    .table('folio_line_items')
    .joinScoped('folios', (join) => join.on('folio_line_items.folio_id', '=', 'folios.id'))
    .where('folios.company_profile_id', account.company_profile_id)
    .whereNull('folio_line_items.voided_at')
    .whereIn('folio_line_items.type', CHARGE_TYPES_FOR_AR_BALANCE)
    .forUpdate()
    .select('folio_line_items.amount');
  const chargeTotal = sumMoney(charges.map((line) => line.amount));

  const payments = await trx.table('ar_payments').where({ ar_account_id: arAccountId }).whereNull('voided_at').forUpdate();
  const paymentTotal = sumMoney(payments.map((payment) => payment.amount));

  const balance = sumMoney([chargeTotal, negateMoney(paymentTotal)]);
  const isOverLimit = compareMoney(balance, account.credit_limit) > 0;

  await trx.table('ar_accounts').where({ id: arAccountId }).update({ current_balance: balance, is_over_limit: isOverLimit });
  return { ...account, current_balance: balance, is_over_limit: isOverLimit };
}

/**
 * ARCHITECTURE.md §5: the row lock is taken here, before the balance is
 * even read, so two concurrent charges against the same account (or a
 * charge racing a `generateInvoice` call, which takes the identical lock)
 * are fully serialized. Returns `{ arAccountId, overLimit }` on success —
 * never writes `is_over_limit` itself; the caller's own follow-up
 * `recomputeArAccountBalance` (run once the real charge is actually
 * inserted) is what makes that flag correct against real data, not a
 * projection.
 */
async function assertWithinCreditLimit({ trx, companyProfileId, additionalAmount, overrideCreditLimit, overrideReason, userId }) {
  const account = await trx.table('ar_accounts').where({ company_profile_id: companyProfileId }).forUpdate().first();
  if (!account || account.status !== 'active') throw new ArAccountNotFoundError();

  const recomputed = await recomputeArAccountBalance({ trx, arAccountId: account.id });
  const projected = sumMoney([recomputed.current_balance, additionalAmount]);

  if (compareMoney(projected, account.credit_limit) > 0) {
    if (account.enforcement_mode === 'flag_only') {
      return { arAccountId: account.id, overLimit: true };
    }
    if (overrideCreditLimit) {
      if (!overrideReason) throw new CreditLimitOverrideReasonRequiredError();
      return { arAccountId: account.id, overLimit: true, overridden: true, overriddenByUserId: userId ?? null };
    }
    throw new CreditLimitExceededError({ arAccountId: account.id, projectedBalance: projected, creditLimit: account.credit_limit });
  }

  return { arAccountId: account.id, overLimit: false };
}

/** Used by `cashiering/service.js`'s `billFolioToCompany` — a folio can only be billed to an account that genuinely exists and is active, never an implicit zero-credit-limit account created on the fly. */
async function getActiveAccountForCompanyAtProperty({ trx, companyProfileId }) {
  return trx.table('ar_accounts').where({ company_profile_id: companyProfileId, status: 'active' }).first();
}

/**
 * Takes `trx` (an already transaction-bound accessor), never opens its own
 * — this and every other mutating function below is called from inside
 * `runIdempotentMutation`'s handler (`ar/controller.js`), which is the sole
 * transaction owner (`src/shared/idempotency.js`'s "one transaction per
 * operation" rule). AR has no external gateway call anywhere (this
 * session's confirmed decision: manual payment recording only), so unlike
 * `cashiering/service.js`'s Paystack-touching functions, nothing here has a
 * reason to deviate from that rule.
 */
async function createArAccount({ trx, companyProfileId, creditLimit, currency, enforcementMode }) {
  // A friendly existence check ahead of the FK — matching this codebase's own
  // established convention (rate_code_id, preferred_room_id, etc.) — so a bad
  // or cross-tenant company id gets a real 422 instead of a raw
  // ER_NO_REFERENCED_ROW_2 falling through to a 500.
  const company = await trx.table('company_profiles').where({ id: companyProfileId }).first();
  if (!company) throw new CompanyProfileNotFoundError();

  return withDuplicateMapping('ar_accounts', 'An AR account for this company already exists at this property.', async () => {
    const [id] = await trx.table('ar_accounts').insert({
      company_profile_id: companyProfileId,
      credit_limit: creditLimit ?? '0.00',
      currency,
      enforcement_mode: enforcementMode ?? 'block',
    });
    return trx.table('ar_accounts').where({ id }).first();
  });
}

async function updateArAccount({ trx, id, changes }) {
  await trx.table('ar_accounts').where({ id }).update(changes);
  // Lowering credit_limit below the current balance (or raising it back above)
  // must flip `is_over_limit` immediately, not wait for the next charge/
  // payment/invoice to happen to touch this account — real enforcement
  // (`assertWithinCreditLimit`) always reads the live credit_limit regardless,
  // but the displayed flag would otherwise go stale.
  if (Object.prototype.hasOwnProperty.call(changes, 'credit_limit')) {
    return recomputeArAccountBalance({ trx, arAccountId: id });
  }
  return trx.table('ar_accounts').where({ id }).first();
}

async function getAccount({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('ar_accounts').where({ id }).first();
}

async function listAccounts({ context }) {
  const db = scopedDb().for(context);
  return db.table('ar_accounts').orderBy('id');
}

// ---------------------------------------------------------------------
// Invoices — TESTING.md AR-1
// ---------------------------------------------------------------------

/** Insert-if-missing, then SELECT ... FOR UPDATE, then increment — the same last-room-race shape `room_type_inventory` established, applied to a different resource. */
async function nextInvoiceNumber({ trx, propertyId }) {
  try {
    await trx.table('ar_invoice_sequences').insert({ next_number: 1 });
  } catch (error) {
    if (!(error && error.code === 'ER_DUP_ENTRY')) throw error;
  }
  const row = await trx.table('ar_invoice_sequences').forUpdate().first();
  await trx.table('ar_invoice_sequences').where({ id: row.id }).update({ next_number: row.next_number + 1 });
  return formatInvoiceNumber(propertyId, row.next_number);
}

/**
 * TESTING.md AR-1: pulls every un-invoiced, non-voided chargeable line on a
 * folio billed to this account, snapshots it into a new invoice. Double-
 * invoicing prevention is two-layered: the `LEFT JOIN ... WHERE ail.id IS
 * NULL` filter below is the primary mechanism, and `ar_invoice_lines`'s own
 * `UNIQUE(tenant_id, property_id, folio_line_item_id)` is the structural
 * belt-and-suspenders backstop (a bug that ever tried inserting the same
 * source line twice gets a real 409, never a silent double-bill).
 *
 * PLAN.md Phase 4 (Group Blocks): an optional `groupBlockId` narrows
 * eligible lines to folios whose reservation is tagged with that block —
 * lets a company that both sponsors a group AND has separate, ongoing
 * direct-bill activity get a block-scoped invoice rather than one mixed
 * invoice. Omitted, the query is byte-for-byte what it was before this
 * filter existed — the default (no-filter) behaviour is unchanged.
 */
async function generateInvoice({ trx, arAccountId, userId, groupBlockId }) {
  const account = await trx.table('ar_accounts').where({ id: arAccountId }).forUpdate().first();
  if (!account || account.status !== 'active') throw new ArAccountNotFoundError();

  // A locking read, not a plain SELECT — the same reason
  // `recomputeArAccountBalance` uses one (see that function's own header):
  // this transaction may have started before a concurrent committer's
  // invoice landed, and only a locking read bypasses that stale
  // REPEATABLE READ snapshot to see its real, latest `ar_invoice_lines` row.
  let eligibleLinesQuery = trx
    .table('folio_line_items')
    .joinScoped('folios', (join) => join.on('folio_line_items.folio_id', '=', 'folios.id'))
    .joinScoped('ar_invoice_lines', (join) => join.on('ar_invoice_lines.folio_line_item_id', '=', 'folio_line_items.id'), { type: 'left' })
    .where('folios.company_profile_id', account.company_profile_id)
    .whereNull('folio_line_items.voided_at')
    .whereIn('folio_line_items.type', INVOICEABLE_TYPES)
    .whereNull('ar_invoice_lines.id');

  if (groupBlockId) {
    eligibleLinesQuery = eligibleLinesQuery
      .joinScoped('reservations', (join) => join.on('reservations.id', '=', 'folios.reservation_id'))
      .where('reservations.group_block_id', groupBlockId);
  }

  const eligibleLines = await eligibleLinesQuery.forUpdate().select('folio_line_items.*');

  if (eligibleLines.length === 0) throw new NoChargesToInvoiceError();

  const total = sumMoney(eligibleLines.map((line) => line.amount));
  const invoiceNumber = await nextInvoiceNumber({ trx, propertyId: account.property_id });
  const company = await trx.table('company_profiles').where({ id: account.company_profile_id }).first();
  const businessDate = await propertyBusinessDate({ trx, propertyId: account.property_id });
  const dueAt = addDays(businessDate, company.payment_terms_days);

  const [invoiceId] = await trx.table('ar_invoices').insert({
    ar_account_id: arAccountId,
    invoice_number: invoiceNumber,
    currency: account.currency,
    total_amount: total,
    status: 'issued',
    issued_at: businessDate,
    due_at: dueAt,
    business_date: businessDate,
    created_by_user_id: userId ?? null,
  });

  for (const line of eligibleLines) {
    await withDuplicateMapping(
      'ar_invoice_lines',
      'This folio line has already been invoiced.',
      async () =>
        trx.table('ar_invoice_lines').insert({
          ar_invoice_id: invoiceId,
          folio_line_item_id: line.id,
          amount: line.amount,
          currency: line.currency,
          business_date: line.business_date,
        })
    );
  }

  await writeOutboxEvent({
    trx,
    eventType: 'ar.invoice_generated',
    aggregateType: 'ar_invoices',
    aggregateId: invoiceId,
    propertyId: account.property_id,
    payload: {
      recipientEmail: company.billing_email,
      companyName: company.name,
      invoiceNumber,
      totalAmount: total,
      currency: account.currency,
      dueAt,
    },
  });

  return trx.table('ar_invoices').where({ id: invoiceId }).first();
}

/**
 * Void, never delete (ARCHITECTURE.md §8). Deliberately does NOT release
 * the invoice's own `ar_invoice_lines` back to "un-invoiced" — doing so
 * would silently re-bill the same charge on a future invoice. A genuine
 * correction to an invoiced charge goes through `postAdjustment` on the
 * folio instead (blocked from voiding the original line directly — see
 * `cashiering/service.js`'s `voidLineItem`), picked up by the next
 * invoice run as its own new line. Reverses any payment applications
 * against this invoice (restoring those payments to unapplied), matching
 * `ar_payment_applications`'s own void-never-delete convention.
 */
async function voidInvoice({ trx, invoiceId, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void an AR invoice.', [{ field: 'reason', issue: 'missing' }]);
  const invoice = await trx.table('ar_invoices').where({ id: invoiceId }).forUpdate().first();
  if (!invoice) throw new ValidationError('INVOICE_NOT_FOUND', 'The specified AR invoice does not exist.');
  if (invoice.status === 'void') throw new InvoiceAlreadyVoidError(invoiceId);

  const now = new Date();
  await trx.table('ar_invoices').where({ id: invoiceId }).update({ status: 'void', voided_at: now, voided_by_user_id: userId ?? null, void_reason: reason });

  const applications = await trx.table('ar_payment_applications').where({ ar_invoice_id: invoiceId }).whereNull('voided_at');
  for (const application of applications) {
    await trx.table('ar_payment_applications').where({ id: application.id }).update({ voided_at: now, voided_by_user_id: userId ?? null });
  }

  return trx.table('ar_invoices').where({ id: invoiceId }).first();
}

async function getInvoice({ context, id }) {
  const db = scopedDb().for(context);
  const invoice = await db.table('ar_invoices').where({ id }).first();
  if (!invoice) return null;
  const lines = await db.table('ar_invoice_lines').where({ ar_invoice_id: id }).orderBy('id');
  return { ...invoice, lines };
}

async function listInvoicesForAccount({ context, arAccountId }) {
  const db = scopedDb().for(context);
  return db.table('ar_invoices').where({ ar_account_id: arAccountId }).orderBy('id', 'desc');
}

// ---------------------------------------------------------------------
// Payments — manual recording only, no gateway (this session's confirmed decision)
// ---------------------------------------------------------------------

/**
 * Shared by `recordPayment` (applications supplied inline) and `applyPayment`
 * (a separate call against an already-recorded payment).
 *
 * Every target invoice row is locked (`.forUpdate()`, sorted ascending by id)
 * FIRST, before any read against `ar_payment_applications` itself. This
 * ordering matters, not just the presence of a lock: a first version of this
 * function locked `ar_invoices` inside the per-application loop, AFTER an
 * earlier `.forUpdate()` scan of `ar_payment_applications` filtered by
 * `ar_payment_id` — two concurrent calls applying two *different* payments to
 * the *same* invoice could each take a `.forUpdate()` gap lock over that
 * (initially empty) range before either had serialized on the invoice row,
 * then both attempt to INSERT into that same gap — a real MySQL deadlock
 * (`ER_LOCK_DEADLOCK`), caught by this module's own two-connection
 * concurrency test, not by inspection. Locking the invoice row(s) first means
 * a second transaction targeting the same invoice fully blocks until the
 * first commits (releasing every lock it held, gap locks included) before it
 * ever reaches a `ar_payment_applications` read — so there is nothing left
 * for its own reads to race.
 *
 * Once an invoice's row lock is held, `existingForInvoice`/`existingForPayment`
 * below are ALSO locking reads, not plain SELECTs — the same reason
 * `recomputeArAccountBalance`/`generateInvoice` use one (see their own
 * headers): this transaction's REPEATABLE READ snapshot may already be fixed
 * by an earlier plain read elsewhere in the same request (e.g.
 * `withIdempotency`'s own first read of `idempotency_keys`), and a plain read
 * here would keep seeing that stale snapshot even after the row lock above is
 * acquired. Only a locking read bypasses it to see the real, latest committed
 * applications — without this, two concurrent applications against the same
 * invoice or payment could each compute "remaining" from stale data and
 * together exceed what's actually owed or actually paid.
 */
async function applyPaymentApplications({ trx, paymentId, paymentAmount, applications }) {
  const uniqueInvoiceIds = [...new Set(applications.map((row) => row.invoiceId))].sort((a, b) => a - b);
  const invoicesById = new Map();
  for (const invoiceId of uniqueInvoiceIds) {
    const invoice = await trx.table('ar_invoices').where({ id: invoiceId }).forUpdate().first();
    if (!invoice || invoice.status === 'void') {
      throw new ValidationError('INVOICE_NOT_FOUND', 'The specified AR invoice does not exist or has been voided.');
    }
    invoicesById.set(invoiceId, invoice);
  }

  const existingForPayment = await trx.table('ar_payment_applications').where({ ar_payment_id: paymentId }).whereNull('voided_at').forUpdate();
  const alreadyApplied = sumMoney(existingForPayment.map((row) => row.amount));
  const requestedTotal = sumMoney(applications.map((row) => row.amount));
  if (compareMoney(sumMoney([alreadyApplied, requestedTotal]), paymentAmount) > 0) {
    throw new PaymentApplicationExceedsPaymentError({
      paymentId,
      requested: requestedTotal,
      remaining: sumMoney([paymentAmount, negateMoney(alreadyApplied)]),
    });
  }

  for (const { invoiceId, amount } of applications) {
    const invoice = invoicesById.get(invoiceId);
    const existingForInvoice = await trx.table('ar_payment_applications').where({ ar_invoice_id: invoiceId }).whereNull('voided_at').forUpdate();
    const appliedSoFar = sumMoney(existingForInvoice.map((row) => row.amount));
    const remaining = sumMoney([invoice.total_amount, negateMoney(appliedSoFar)]);
    if (compareMoney(amount, remaining) > 0) {
      throw new PaymentApplicationExceedsInvoiceError({ invoiceId, requested: amount, remaining });
    }

    await trx.table('ar_payment_applications').insert({ ar_payment_id: paymentId, ar_invoice_id: invoiceId, amount });

    const newAppliedTotal = sumMoney([appliedSoFar, amount]);
    const newStatus = compareMoney(newAppliedTotal, invoice.total_amount) === 0 ? 'paid' : 'partially_paid';
    await trx.table('ar_invoices').where({ id: invoiceId }).update({ status: newStatus });
  }
}

/** The full `amount` reduces the account's real exposure immediately, regardless of `applications` — see file header. */
async function recordPayment({ trx, arAccountId, amount, currency, methodLabel, reference, receivedAt, businessDate, applications, userId }) {
  const account = await trx.table('ar_accounts').where({ id: arAccountId }).forUpdate().first();
  if (!account || account.status !== 'active') throw new ArAccountNotFoundError();

  const effectiveBusinessDate = businessDate ?? (await propertyBusinessDate({ trx, propertyId: account.property_id }));
  const [paymentId] = await trx.table('ar_payments').insert({
    ar_account_id: arAccountId,
    amount,
    currency: currency ?? account.currency,
    method_label: methodLabel,
    reference: reference ?? null,
    received_at: receivedAt ?? effectiveBusinessDate,
    business_date: effectiveBusinessDate,
    recorded_by_user_id: userId ?? null,
  });

  if (applications && applications.length) {
    await applyPaymentApplications({ trx, paymentId, paymentAmount: amount, applications });
  }

  await recomputeArAccountBalance({ trx, arAccountId });

  const company = await trx.table('company_profiles').where({ id: account.company_profile_id }).first();
  await writeOutboxEvent({
    trx,
    eventType: 'ar.payment_received',
    aggregateType: 'ar_payments',
    aggregateId: paymentId,
    propertyId: account.property_id,
    payload: { recipientEmail: company.billing_email, companyName: company.name, amount, currency: currency ?? account.currency },
  });

  return trx.table('ar_payments').where({ id: paymentId }).first();
}

async function applyPayment({ trx, paymentId, applications }) {
  const payment = await trx.table('ar_payments').where({ id: paymentId }).forUpdate().first();
  if (!payment) throw new ValidationError('PAYMENT_NOT_FOUND', 'The specified AR payment does not exist.');
  if (payment.voided_at) throw new PaymentAlreadyVoidError(paymentId);

  await applyPaymentApplications({ trx, paymentId, paymentAmount: payment.amount, applications });
  return trx.table('ar_payments').where({ id: paymentId }).first();
}

/** Void, never delete. Reverses any applications this payment made (recomputing each affected invoice's status) and restores the account's balance. */
async function voidPayment({ trx, paymentId, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void an AR payment.', [{ field: 'reason', issue: 'missing' }]);
  const payment = await trx.table('ar_payments').where({ id: paymentId }).forUpdate().first();
  if (!payment) throw new ValidationError('PAYMENT_NOT_FOUND', 'The specified AR payment does not exist.');
  if (payment.voided_at) throw new PaymentAlreadyVoidError(paymentId);

  const now = new Date();
  await trx.table('ar_payments').where({ id: paymentId }).update({ voided_at: now, voided_by_user_id: userId ?? null, void_reason: reason });

  const applications = await trx.table('ar_payment_applications').where({ ar_payment_id: paymentId }).whereNull('voided_at');
  for (const application of applications) {
    await trx.table('ar_payment_applications').where({ id: application.id }).update({ voided_at: now, voided_by_user_id: userId ?? null });

    const invoice = await trx.table('ar_invoices').where({ id: application.ar_invoice_id }).first();
    if (invoice && invoice.status !== 'void') {
      const remaining = await trx.table('ar_payment_applications').where({ ar_invoice_id: application.ar_invoice_id }).whereNull('voided_at');
      const appliedTotal = sumMoney(remaining.map((row) => row.amount));
      const newStatus =
        compareMoney(appliedTotal, '0.00') === 0 ? 'issued' : compareMoney(appliedTotal, invoice.total_amount) === 0 ? 'paid' : 'partially_paid';
      await trx.table('ar_invoices').where({ id: invoice.id }).update({ status: newStatus });
    }
  }

  await recomputeArAccountBalance({ trx, arAccountId: payment.ar_account_id });
  return trx.table('ar_payments').where({ id: paymentId }).first();
}

async function getPayment({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('ar_payments').where({ id }).first();
}

async function listPaymentsForAccount({ context, arAccountId }) {
  const db = scopedDb().for(context);
  return db.table('ar_payments').where({ ar_account_id: arAccountId }).orderBy('id', 'desc');
}

// ---------------------------------------------------------------------
// Ageing report — TESTING.md AR-2
// ---------------------------------------------------------------------

/** Aged balance by company, as of the active property's own current_business_date (ARCHITECTURE.md §6 — never wall-clock). */
async function computeAgeingReport({ context }) {
  const db = scopedDb().for(context);
  const accounts = await db.table('ar_accounts').where({ status: 'active' });
  const property = await db.table('properties').where({ id: context.propertyId }).first();
  const asOfDate = property?.current_business_date ?? new Date().toISOString().slice(0, 10);

  const rows = [];
  const grandTotal = Object.fromEntries(BUCKET_KEYS.map((key) => [key, '0.00']));

  for (const account of accounts) {
    const company = await db.table('company_profiles').where({ id: account.company_profile_id }).first();
    const invoices = await db.table('ar_invoices').where({ ar_account_id: account.id }).whereNot({ status: 'void' });
    const invoicesWithApplied = await Promise.all(
      invoices.map(async (invoice) => {
        const applications = await db.table('ar_payment_applications').where({ ar_invoice_id: invoice.id }).whereNull('voided_at');
        return { ...invoice, appliedAmount: sumMoney(applications.map((row) => row.amount)) };
      })
    );
    const buckets = computeAgeingBuckets({ invoices: invoicesWithApplied, asOfDate });
    for (const key of BUCKET_KEYS) grandTotal[key] = sumMoney([grandTotal[key], buckets[key]]);
    rows.push({
      arAccountId: account.id,
      companyProfileId: account.company_profile_id,
      companyName: company?.name ?? null,
      creditLimit: account.credit_limit,
      currentBalance: account.current_balance,
      ...buckets,
    });
  }

  return { asOfDate, rows, total: grandTotal };
}

module.exports = {
  recomputeArAccountBalance,
  assertWithinCreditLimit,
  getActiveAccountForCompanyAtProperty,
  createArAccount,
  updateArAccount,
  getAccount,
  listAccounts,
  generateInvoice,
  voidInvoice,
  getInvoice,
  listInvoicesForAccount,
  recordPayment,
  applyPayment,
  voidPayment,
  getPayment,
  listPaymentsForAccount,
  computeAgeingReport,
};
