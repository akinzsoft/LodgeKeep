'use strict';

/**
 * Cashiering service — PLAN.md Phase 2.5 step 1 ("the real folio ledger")
 * and step 2 ("Payment integration"), PRODUCT_REQUIREMENTS.md §3.5,
 * ARCHITECTURE.md §7 (payment state machine), §8 (immutability), §12.1
 * (tax). See this module's own `index.js` for the full scope summary.
 *
 * ── THE ONE-TRANSACTION RULE, WITH ONE DELIBERATE EXCEPTION ─────────────
 *
 * Every function taking `trx` follows `src/modules/reservations/service.js`'s
 * own rule: an already transaction-bound accessor, no nested transaction,
 * the controller opens the one transaction via `withIdempotency`. The
 * exception is the Paystack checkout flow: ARCHITECTURE.md §6.4's rule
 * ("an external HTTP call inside a financial transaction is a defect")
 * applies just as much to a payment-gateway call as to night audit's email
 * sending, so `startPaystackCheckout`/`verifyPayment`/`handlePaystackWebhook`
 * take `context` (not `trx`) and open their own short, separate
 * transactions AROUND each real external call rather than holding one open
 * across it. `initiatePaystackPaymentIntent` is the one function in this
 * file that still takes `trx` — it does ONLY the local insert, deliberately
 * split from the external call that follows it (see `controller.js`'s
 * `capturePaystackPayment` for how the two compose).
 *
 * ── FOLIO BALANCE ────────────────────────────────────────────────────────
 *
 * `folios.balance` is never trusted as an independent running total — every
 * mutation here recomputes it from scratch as `sumMoney` of every
 * non-voided `folio_line_items` row on that folio
 * (`recomputeFolioBalance`), then writes the result back. One source of
 * truth, always re-derived, never incremented/decremented in place.
 */

const { scopedDb, knex } = require('../../db');
const { systemContext, workerContext } = require('../tenancy');
const { ValidationError } = require('../../shared/errors');
const { generateUlid } = require('../../shared/ulid');
const { sumMoney, negateMoney, compareMoney, percentOfMoney } = require('../../shared/money');
const { assertPaymentAmount } = require('../../shared/payment-amount');
const { resolveApplicableTaxVersions, computeChargeWithTax } = require('./tax-engine');
const { taxChargeTypeForOutlet } = require('../../shared/outlet-types');
const paystack = require('./paystack-adapter');
const { assertAllowedCallbackUrl } = require('../../shared/callback-url');
const { recordAuditEntry } = require('../../audit');
const { classifyGatewayRecord, interpretGatewayError } = require('../../shared/gateway-record');
const { persistWebhookEvent, finalizeWebhookEvent, deferWebhookEvent, webhookEventKey, RECORD_NOT_FOUND_GRACE_ATTEMPTS } = require('../../shared/webhook-events');
// PLAN.md Phase 6 (QR self-ordering gap closure) — a one-way dependency,
// the same shape this file's own `ar/service.js` import already
// establishes: cashiering calls into `pos-pricing`/`pos/errors` (both
// dependency-free leaf files, no `require` of `pos/service.js` or of this
// module), never the other way. `pos/service.js` is deliberately NOT
// required here even for the one place a guest-order refund needs to void
// a `pos_order_settlements` row — see `refundPayment`'s own comment for
// why that logic is replicated inline instead of imported: `pos/service.js`
// already requires THIS file (for room-charge settlement), and requiring
// it back here would create the exact circular-require this codebase's
// module-boundary rule exists to avoid (a real, silent breakage — the
// object either module captured before the other finished assigning its
// own `module.exports` would be stale, permanently).
const { computeItemLineTotal } = require('../../shared/pos-pricing');
const { OrderNotOpenError, SettlementAlreadyVoidedError } = require('../pos/errors');
// PLAN.md Phase 6 (POS inventory & stock control) — a one-way dependency,
// the identical shape this file's own `arService`/`pos-pricing` imports
// already establish: this module calls INTO `stock/service.js`, which
// never requires this file back (see that module's own header).
// `finalizePosOrderCardCapture` is the SECOND real settlement writer this
// codebase has (`pos/service.js`'s own `settleOrder` is the first) — both
// need the identical deduction hook, or a card-paid QR guest order would
// silently never deduct stock at all.
const stockService = require('../stock/service');
const voucherStore = require('../discounts/voucher-store');
const { writeOutboxEvent } = require('../../shared/outbox');
const { notifyStaff } = require('../notifications/staff-notifications');
const { notifyGuestOrderReceived } = require('../qr-ordering/staff-alert');
// PLAN.md Phase 4 (Accounts Receivable) — a one-way dependency: this module
// calls into `ar/service.js`, never the other way, so there is no import
// cycle. See that module's own header for the credit-limit lock this
// wiring relies on.
const arService = require('../ar/service');
const terminalAccounts = require('./terminal-accounts');
const { ArAccountNotFoundError } = require('../ar/errors');
const {
  FolioClosedError,
  LineItemAlreadyVoidedError,
  InvalidPaymentTransitionError,
  RefundExceedsCapturedAmountError,
  RefundNotStuckError,
  CrossReservationFolioMoveError,
  LineItemNotFoundError,
  CannotVoidInvoicedLineError,
  CannotPayArBilledFolioDirectlyError,
  PaymentGatewayRecordMismatchError,
  BackdatingNotPermittedError,
  BusinessDayClosedError,
} = require('./errors');

const CHARGE_TYPES = new Set(['room_charge', 'pos_charge']);

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

/**
 * The ONE way a folio is locked before its balance is changed or relied on (F-05). Every mutation that posts, voids or
 * moves a line, takes a payment or refund against a folio, or closes it, starts here.
 *
 * Lock order, for the whole module: the payment row (when there is one), then the AR account of any folio billed to a
 * company, then the folios themselves in ASCENDING id. That is the order `generateInvoice`/`recordPayment` already
 * use (AR account, then the folio rows their locking reads touch), so a charge on an AR-billed folio and an invoice run
 * for the same account cannot deadlock. A folio's `company_profile_id` can change (`billFolioToCompany`) between the
 * peek that finds the account and the lock on the folio, so it is re-checked under the lock and the whole thing
 * retried until the two agree.
 *
 * Returns the freshly locked folio rows by id.
 */
async function lockFoliosForMutation({ trx, folioIds }) {
  const ids = [...new Set(folioIds.map(String))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const lockedAccountCompanies = new Set();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const peek = await trx.table('folios').whereIn('id', ids).select('id', 'company_profile_id');
    const wanted = [...new Set(peek.map((row) => row.company_profile_id).filter(Boolean).map(String))].filter((id) => !lockedAccountCompanies.has(id));
    if (wanted.length > 0) {
      await trx.table('ar_accounts').whereIn('company_profile_id', wanted).orderBy('id').forUpdate();
      wanted.forEach((id) => lockedAccountCompanies.add(id));
    }
    const locked = await trx.table('folios').whereIn('id', ids).orderBy('id').forUpdate();
    const stable = locked.every((row) => !row.company_profile_id || lockedAccountCompanies.has(String(row.company_profile_id)));
    if (stable) return new Map(locked.map((row) => [String(row.id), row]));
  }
  throw new ValidationError('FOLIO_BUSY', 'The folio was changing while it was being locked. Please try again.');
}

async function lockFolio({ trx, folioId }) {
  return (await lockFoliosForMutation({ trx, folioIds: [folioId] })).get(String(folioId)) ?? null;
}

/**
 * The folio's balance is always re-derived from its non-voided lines and written back, never adjusted in place. The sum
 * is a LOCKING read: a plain read sees the REPEATABLE READ snapshot the request's first read fixed (the idempotency-key
 * lookup), which can predate a line another request has since committed. The caller holds the folio lock
 * (`lockFoliosForMutation`), so no other writer can add a line between this read and the write.
 */
async function recomputeFolioBalance({ trx, folioId }) {
  const lines = await trx.table('folio_line_items').where({ folio_id: folioId }).whereNull('voided_at').forUpdate();
  const balance = sumMoney(lines.map((line) => line.amount));
  await trx.table('folios').where({ id: folioId }).update({ balance });
  return balance;
}

async function getFolio({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('folios').where({ id }).first();
}

async function listFoliosForReservation({ context, reservationId }) {
  const db = scopedDb().for(context);
  return db.table('folios').where({ reservation_id: reservationId }).orderBy('id');
}

async function listLineItems({ context, folioId }) {
  const db = scopedDb().for(context);
  return db.table('folio_line_items').where({ folio_id: folioId }).orderBy('id');
}

async function listPaymentsForFolio({ context, folioId }) {
  const db = scopedDb().for(context);
  return annotateStuckRefunds({ db, payments: await db.table('payments').where({ folio_id: folioId }).orderBy('id') });
}

async function getPayment({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('payments').where({ id }).first();
}

async function propertyBusinessDate({ trx, propertyId }) {
  const property = await trx.table('properties').where({ id: propertyId }).first();
  return property?.current_business_date ?? null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Decides the business date a CLIENT asked a posting to carry (F-03, product audit). The date used to come straight
 * from the request body, so anyone who could post could post into any day, closed or not.
 *
 *  - none sent: the caller falls back to the property's current business date (returned as `undefined`);
 *  - not a real calendar date: 400 `VALIDATION_INVALID_BUSINESS_DATE`;
 *  - the property's CURRENT BUSINESS DATE (`properties.current_business_date`, which moves only when Night Audit runs,
 *    never the calendar date): allowed;
 *  - later than it: 400 `VALIDATION_BUSINESS_DATE_IN_FUTURE`, for everyone;
 *  - earlier: 403 `FORBIDDEN_BACKDATING` without `canBackdate`; and even with it, 422 `BUSINESS_RULE_BUSINESS_DAY_CLOSED`
 *    when Night Audit has closed that day (a COMPLETED run or a `daily_reports` snapshot exists for it).
 * Returns `{ businessDate, backdated }`.
 */
async function resolveClientBusinessDate({ trx, folioId, clientDate, canBackdate }) {
  if (clientDate === undefined || clientDate === null) return { businessDate: undefined, backdated: false };
  const invalid = () => new ValidationError('INVALID_BUSINESS_DATE', '"business_date" must be a real date written YYYY-MM-DD.', [{ field: 'business_date', issue: 'invalid' }]);
  if (typeof clientDate !== 'string' || !ISO_DATE.test(clientDate)) throw invalid();
  const parsed = new Date(`${clientDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== clientDate) throw invalid();

  const folio = await trx.table('folios').where({ id: folioId }).first('property_id');
  if (!folio) return { businessDate: clientDate, backdated: false }; // the posting itself reports the missing folio
  const current = await propertyBusinessDate({ trx, propertyId: folio.property_id });
  if (!current) {
    throw new ValidationError('BUSINESS_DATE_NOT_SET', 'This property has no business date yet, so a business_date cannot be chosen.', [{ field: 'business_date', issue: 'not_set' }]);
  }
  const currentIso = String(current).slice(0, 10); // DATE columns come back as 'YYYY-MM-DD' strings (knexfile `dateStrings`)
  if (clientDate === currentIso) return { businessDate: clientDate, backdated: false };
  if (clientDate > currentIso) {
    throw new ValidationError('BUSINESS_DATE_IN_FUTURE', `"business_date" cannot be after the current business date (${currentIso}).`, [{ field: 'business_date', issue: 'in_future' }]);
  }
  if (!canBackdate) throw new BackdatingNotPermittedError(clientDate);
  const run = await trx.table('night_audit_runs').where({ property_id: folio.property_id, business_date: clientDate, status: 'COMPLETED' }).first('id');
  const report = await trx.table('daily_reports').where({ property_id: folio.property_id, business_date: clientDate }).first('id');
  if (run || report) throw new BusinessDayClosedError(clientDate);
  return { businessDate: clientDate, backdated: true };
}

// ---------------------------------------------------------------------
// Folios — split billing (PRODUCT_REQUIREMENTS.md §3.5)
// ---------------------------------------------------------------------

/**
 * The reservation's primary folio — created once, reused forever after.
 * Idempotent: returns the existing folio, however it was opened, rather
 * than ever inserting a second one. Extracted from `checkIn`'s own inline
 * insert (`src/modules/reservations/service.js`) so a second real caller —
 * PLAN.md Phase 4's guest portal, which opens a folio and takes payment
 * *before* arrival, with no check-in to hang it off yet — cannot silently
 * create a duplicate primary folio the day that same reservation is walked
 * up and checked in. `openAdditionalFolio` below still requires a primary
 * folio to already exist; this is the one function that ever creates it.
 */
async function ensurePrimaryFolio({ trx, reservationId }) {
  const existing = await trx.table('folios').where({ reservation_id: reservationId }).first();
  if (existing) return existing;

  const dailyRate = await trx.table('reservation_daily_rates').where({ reservation_id: reservationId }).first();
  const [id] = await trx.table('folios').insert({
    reservation_id: reservationId,
    folio_number: generateUlid(),
    status: 'open',
    balance: '0.00',
    currency: dailyRate.currency,
  });
  return trx.table('folios').where({ id }).first();
}

/**
 * Opens an additional folio on a reservation that already has one (opened
 * at check-in — `src/modules/reservations/service.js`'s `checkIn`) —
 * PRODUCT_REQUIREMENTS.md §3.5's "multiple folios per reservation, split
 * billing across guests/accounts." `billedTo` is a free-text label; see
 * the folios migration's own header for why this is not a
 * `company_profile_id` FK.
 */
async function openAdditionalFolio({ trx, reservationId, billedTo }) {
  const anyExisting = await trx.table('folios').where({ reservation_id: reservationId }).first();
  if (!anyExisting) {
    throw new ValidationError('RESERVATION_NOT_CHECKED_IN', 'A reservation must be checked in (and hold a primary folio) before a split folio can be opened.');
  }
  const [id] = await trx.table('folios').insert({
    reservation_id: reservationId,
    folio_number: generateUlid(),
    status: 'open',
    balance: '0.00',
    currency: anyExisting.currency,
    billed_to: billedTo ?? 'Guest',
  });
  return trx.table('folios').where({ id }).first();
}

/**
 * Split billing's actual mechanism: moves one non-voided line item from one
 * folio to another on the SAME reservation (`CrossReservationFolioMoveError`
 * otherwise) — both folios' balances are recomputed in the same operation.
 * A voided line cannot move (there is nothing left to bill anywhere).
 *
 * A charge's own TAX line(s) (found via `related_line_item_id`, the same
 * link `voidLineItem`'s cascade already uses) move WITH it — splitting a
 * room charge onto a company's folio but leaving its tax behind on the
 * guest's would tax a charge no longer billed there, and PRODUCT_
 * REQUIREMENTS.md §3.5's "must appear as clearly labelled, itemized folio
 * lines" only means something if the charge and its tax stay together.
 */
async function moveLineItem({ trx, lineItemId, destinationFolioId }) {
  let line = await trx.table('folio_line_items').where({ id: lineItemId }).first();
  if (!line) throw new LineItemNotFoundError();
  // Both folios are locked together, ascending by id, so two moves in opposite directions cannot deadlock. The line is
  // then re-read under the lock: a concurrent move may have taken it to another folio since it was first read.
  let locked;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    locked = await lockFoliosForMutation({ trx, folioIds: [line.folio_id, destinationFolioId] });
    const fresh = await trx.table('folio_line_items').where({ id: lineItemId }).forUpdate().first();
    if (!fresh) throw new LineItemNotFoundError();
    if (String(fresh.folio_id) === String(line.folio_id)) {
      line = fresh;
      break;
    }
    line = fresh;
    locked = null;
  }
  if (!locked) throw new ValidationError('FOLIO_BUSY', 'The line was moving while it was being locked. Please try again.');
  if (line.voided_at) throw new LineItemAlreadyVoidedError(lineItemId);

  const sourceFolio = locked.get(String(line.folio_id));
  const destinationFolio = locked.get(String(destinationFolioId));
  if (!destinationFolio) throw new ValidationError('FOLIO_NOT_FOUND', 'The destination folio does not exist.');
  if (sourceFolio.reservation_id !== destinationFolio.reservation_id) throw new CrossReservationFolioMoveError();
  if (destinationFolio.status !== 'open') throw new FolioClosedError(destinationFolioId);

  await trx.table('folio_line_items').where({ id: lineItemId }).update({ folio_id: destinationFolioId });
  await trx
    .table('folio_line_items')
    .where({ related_line_item_id: lineItemId, type: 'tax' })
    .whereNull('voided_at')
    .update({ folio_id: destinationFolioId });

  await recomputeFolioBalance({ trx, folioId: sourceFolio.id });
  await recomputeFolioBalance({ trx, folioId: destinationFolioId });
  return trx.table('folio_line_items').where({ id: lineItemId }).first();
}

/**
 * PLAN.md Phase 4 (Accounts Receivable) — routes an open folio to a
 * company's AR account instead of (or back away from, when
 * `companyProfileId` is null) settlement by the guest directly. Requires an
 * already-active `ar_accounts` row (created explicitly via `POST
 * /ar/accounts`) — a folio can never implicitly acquire a zero-credit-limit
 * account by accident. `billed_to` (the existing free-text label) is set to
 * the company's own name so the two never disagree.
 *
 * Un-billing (`companyProfileId: null`) is only allowed once no line on
 * this folio has ever been invoiced — reversing AR billing after a real
 * invoice already summarized those charges would silently orphan that
 * invoice's own accounting.
 */
async function billFolioToCompany({ trx, folioId, companyProfileId }) {
  // The company's AR account first (the module-wide lock order: AR account, then the folio), then the folio.
  if (companyProfileId) await trx.table('ar_accounts').where({ company_profile_id: companyProfileId }).forUpdate();
  const folio = await lockFolio({ trx, folioId });
  if (!folio) throw new ValidationError('FOLIO_NOT_FOUND', 'The specified folio does not exist.');
  if (folio.status !== 'open') throw new FolioClosedError(folioId);

  if (companyProfileId) {
    const account = await arService.getActiveAccountForCompanyAtProperty({ trx, companyProfileId });
    if (!account) throw new ArAccountNotFoundError();
    const company = await trx.table('company_profiles').where({ id: companyProfileId }).first();
    await trx.table('folios').where({ id: folioId }).update({ company_profile_id: companyProfileId, billed_to: company.name });
  } else {
    // A locking read (`.forUpdate()`), not a plain SELECT — the same reason
    // `ar/service.js`'s `recomputeArAccountBalance`/`generateInvoice` use one:
    // this bypasses a stale REPEATABLE READ snapshot AND takes the same row
    // locks `generateInvoice`'s own eligibility query takes on these exact
    // `folio_line_items`/`ar_invoice_lines` rows, so a concurrent
    // "generate invoice" for this folio's account and this un-bill attempt
    // genuinely serialize against each other rather than racing.
    const anyInvoiced = await trx
      .table('folio_line_items')
      .joinScoped('ar_invoice_lines', (join) => join.on('ar_invoice_lines.folio_line_item_id', '=', 'folio_line_items.id'))
      .where('folio_line_items.folio_id', folioId)
      .forUpdate()
      .first('folio_line_items.id');
    if (anyInvoiced) {
      throw new ValidationError('CANNOT_UNBILL_INVOICED_FOLIO', 'This folio has already had one or more charges invoiced through Accounts Receivable and cannot be un-billed.');
    }
    await trx.table('folios').where({ id: folioId }).update({ company_profile_id: null, billed_to: 'Guest' });
  }

  return trx.table('folios').where({ id: folioId }).first();
}

// ---------------------------------------------------------------------
// Charges & tax (ARCHITECTURE.md §12.1)
// ---------------------------------------------------------------------

/**
 * Posts a charge with tax computed and posted alongside it as its own
 * separate line(s) — PRODUCT_REQUIREMENTS.md §3.5: "must appear as clearly
 * labelled, itemized folio lines, never lumped into the room charge."
 * `type` is `room_charge` or `pos_charge` (the two real charge-generating
 * events this codebase has); a correction/discount/comp goes through
 * `postAdjustment` instead, which does not recompute tax.
 *
 * PLAN.md Phase 4 (Accounts Receivable): when the target folio is billed to
 * a company (`folio.company_profile_id`), the charge plus its own tax is
 * checked against that account's credit limit BEFORE either is inserted —
 * `arService.assertWithinCreditLimit` takes the account's row lock, so this
 * is also this account's own serialization point against a concurrent
 * `generateInvoice` call (see `ar/service.js`'s file header). `overrideCreditLimit`/
 * `overrideReason` are optional and only meaningful when a folio is
 * AR-billed — every existing caller of this function is unaffected.
 */
async function postCharge({ trx, folioId, type, description, amount, businessDate, userId, overrideCreditLimit, overrideReason }) {
  if (!CHARGE_TYPES.has(type)) {
    throw new ValidationError('INVALID_CHARGE_TYPE', `"${type}" is not a postable charge type — use "room_charge" or "pos_charge".`);
  }
  const folio = await lockFolio({ trx, folioId });
  if (!folio) throw new ValidationError('FOLIO_NOT_FOUND', 'The specified folio does not exist.');
  if (folio.status !== 'open') throw new FolioClosedError(folioId);

  const effectiveBusinessDate = businessDate ?? (await propertyBusinessDate({ trx, propertyId: folio.property_id }));

  const allTaxRows = await trx.table('taxes');
  const taxVersions = resolveApplicableTaxVersions({ allTaxRows, businessDate: effectiveBusinessDate, chargeType: type });
  const { netAmount, taxLines } = computeChargeWithTax({ baseAmount: amount, taxVersions });
  const totalTax = sumMoney(taxLines.map((t) => t.amount));

  let arCheck = null;
  if (folio.company_profile_id) {
    arCheck = await arService.assertWithinCreditLimit({
      trx,
      companyProfileId: folio.company_profile_id,
      additionalAmount: sumMoney([netAmount, totalTax]),
      overrideCreditLimit,
      overrideReason,
      userId,
    });
  }

  const [chargeLineId] = await trx.table('folio_line_items').insert({
    folio_id: folioId,
    type,
    description,
    amount: netAmount,
    currency: folio.currency,
    tax_amount: totalTax,
    business_date: effectiveBusinessDate,
    posted_by_user_id: userId ?? null,
  });

  for (const taxLine of taxLines) {
    await trx.table('folio_line_items').insert({
      folio_id: folioId,
      type: 'tax',
      description: `${taxLine.name} (${taxLine.taxCode})`,
      amount: taxLine.amount,
      currency: folio.currency,
      business_date: effectiveBusinessDate,
      posted_by_user_id: userId ?? null,
      related_line_item_id: chargeLineId,
    });
  }

  await recomputeFolioBalance({ trx, folioId });
  if (arCheck) await arService.recomputeArAccountBalance({ trx, arAccountId: arCheck.arAccountId });
  const chargeLine = await trx.table('folio_line_items').where({ id: chargeLineId }).first();
  const postedTaxLines = await trx.table('folio_line_items').where({ related_line_item_id: chargeLineId, type: 'tax' });
  return { chargeLine, taxLines: postedTaxLines };
}

/**
 * Gap closure (user-reported): posts one `room_charge` per night of a
 * reservation's stay — the only shape that doesn't double-bill once Night
 * Audit's own idempotency guard later walks the same nights (keyed on
 * `folio_id` + `business_date`). Extracted from `portal/service.js`'s own
 * inline loop (`createBookingWithPayment`) once the staff-side "let front
 * desk open a folio and take payment before check-in" need arrived as a
 * second, near-identical caller — the same "promote a one-off once a
 * second caller needs it" pattern this codebase already uses elsewhere
 * (`runIdempotentMutation`, `resolvePropertyBySlug`). Idempotent per
 * (folioId, business_date) itself, on top of that — skips a night that
 * already has a non-voided `room_charge` line, so calling this twice for
 * the same reservation (a staff member reopening the booking screen, say)
 * never double-posts.
 */
async function postRoomChargesForStay({ trx, reservationId, folioId, userId }) {
  const dailyRates = await trx.table('reservation_daily_rates').where({ reservation_id: reservationId });
  for (const dailyRate of dailyRates) {
    const alreadyPosted = await trx
      .table('folio_line_items')
      .where({ folio_id: folioId, type: 'room_charge', business_date: dailyRate.stay_date })
      .whereNull('voided_at')
      .first();
    if (alreadyPosted) continue;
    await postCharge({
      trx,
      folioId,
      type: 'room_charge',
      description: `Room charge — ${dailyRate.stay_date}`,
      amount: dailyRate.rate,
      businessDate: dailyRate.stay_date,
      userId: userId ?? null,
    });
  }
  return trx.table('folios').where({ id: folioId }).first();
}

/**
 * Room charges for nights whose night audit ALREADY ran — the nights Extend
 * Stay adds when the extension is made after the fact (user-reported: a stay
 * booked for one night was extended on the 18th to run through the 19th; the
 * 17th's audit had closed before the extension existed, so that night was
 * never billed, and nothing could bill it).
 *
 * Posted on the property's CURRENT business date, not back-dated to the night
 * itself: a closed day's `daily_reports` snapshot is the accounting truth and
 * is never reopened (ARCHITECTURE.md §6/§8), so the revenue lands in the open
 * day's report instead of vanishing from every report. The description names
 * the night ("Late room charge — 2026-09-17"), and Night Audit's own
 * once-per-night guard deliberately ignores these lines (see
 * `LATE_ROOM_CHARGE_PREFIX`), otherwise a late charge dated today would
 * suppress today's real room charge.
 *
 * Idempotent per night: a night that already has a non-voided late charge on
 * this folio is skipped, so a retried request never double-bills.
 *
 * @param {Array<{stayDate: string, rate: string}>} nights
 * @returns {Promise<Array<{stayDate: string, rate: string}>>} the nights actually charged now
 */
const LATE_ROOM_CHARGE_PREFIX = 'Late room charge —';

async function postLateRoomCharges({ trx, folioId, nights, businessDate, userId, overrideCreditLimit, overrideReason }) {
  const charged = [];
  for (const night of nights) {
    const description = `${LATE_ROOM_CHARGE_PREFIX} ${night.stayDate}`;
    const alreadyPosted = await trx
      .table('folio_line_items')
      .where({ folio_id: folioId, type: 'room_charge', description })
      .whereNull('voided_at')
      .first();
    if (alreadyPosted) continue;
    await postCharge({
      trx,
      folioId,
      type: 'room_charge',
      description,
      amount: night.rate,
      businessDate,
      userId: userId ?? null,
      overrideCreditLimit,
      overrideReason,
    });
    charged.push(night);
  }
  return charged;
}

/**
 * A correction, discount, or comp — ARCHITECTURE.md §8's own worked
 * example ("ADJUSTMENT -£100.00 ... reverses it"). `amount` is signed and
 * posted EXACTLY as given, with no tax recomputation (a correction to a
 * charge that already had its own tax posted separately must not double-tax
 * or silently drop the original tax line — reversing the charge and its tax
 * as two explicit adjustment lines, if that is the intent, is the caller's
 * job, not something this function infers). `reason` is mandatory —
 * CLAUDE.md's own frontend rule: "money confirmations require a reason
 * field that feeds the audit trail."
 *
 * PLAN.md Phase 4 (Accounts Receivable): the identical credit-limit check
 * `postCharge` applies — an adjustment on an AR-billed folio can move the
 * balance either way, and a negative (credit/discount) amount naturally
 * satisfies the check regardless of enforcement mode.
 */
async function postAdjustment({ trx, folioId, description, amount, relatedLineItemId, businessDate, userId, reason, overrideCreditLimit, overrideReason }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required for a folio adjustment.', [{ field: 'reason', issue: 'missing' }]);
  const folio = await lockFolio({ trx, folioId });
  if (!folio) throw new ValidationError('FOLIO_NOT_FOUND', 'The specified folio does not exist.');
  if (folio.status !== 'open') throw new FolioClosedError(folioId);

  const effectiveBusinessDate = businessDate ?? (await propertyBusinessDate({ trx, propertyId: folio.property_id }));

  let arCheck = null;
  if (folio.company_profile_id) {
    arCheck = await arService.assertWithinCreditLimit({
      trx,
      companyProfileId: folio.company_profile_id,
      additionalAmount: amount,
      overrideCreditLimit,
      overrideReason,
      userId,
    });
  }

  const [id] = await trx.table('folio_line_items').insert({
    folio_id: folioId,
    type: 'adjustment',
    description,
    amount,
    currency: folio.currency,
    business_date: effectiveBusinessDate,
    posted_by_user_id: userId ?? null,
    related_line_item_id: relatedLineItemId ?? null,
  });

  await recomputeFolioBalance({ trx, folioId });
  if (arCheck) await arService.recomputeArAccountBalance({ trx, arAccountId: arCheck.arAccountId });
  return trx.table('folio_line_items').where({ id }).first();
}

/**
 * ARCHITECTURE.md §8: void, never delete — mutates only the three audited
 * void fields. A charge's own tax lines (found via `related_line_item_id`)
 * are voided in the same operation: leaving tax posted against a voided
 * charge would tax something that no longer exists on the folio. A
 * `payment`/`refund` line cannot be voided directly — those follow the
 * `payments` state machine instead (`refundPayment`), since a payment
 * carries external-gateway state a bare line-item void cannot express.
 *
 * PLAN.md Phase 4 (Accounts Receivable): a line already present in
 * `ar_invoice_lines` (already invoiced) cannot be voided directly — doing
 * so would silently invalidate an already-issued invoice's own immutable
 * `total_amount`. The correction path is a fresh offsetting `postAdjustment`
 * on the same folio (ARCHITECTURE.md §8), which the next invoice run picks
 * up as its own new line.
 */
async function voidLineItem({ trx, lineItemId, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void a folio line.', [{ field: 'reason', issue: 'missing' }]);
  const peeked = await trx.table('folio_line_items').where({ id: lineItemId }).first();
  if (!peeked) throw new LineItemNotFoundError();
  // The folio is locked BEFORE the line is judged, and the line is re-read under that lock, so a void and a charge (or
  // two voids) on the same folio serialise and the second sees what the first did.
  await lockFolio({ trx, folioId: peeked.folio_id });
  const line = await trx.table('folio_line_items').where({ id: lineItemId }).forUpdate().first();
  if (!line) throw new LineItemNotFoundError();
  if (line.voided_at) throw new LineItemAlreadyVoidedError(lineItemId);
  if (line.type === 'payment' || line.type === 'refund') {
    throw new ValidationError('CANNOT_VOID_PAYMENT_LINE', 'A payment or refund line cannot be voided directly — use the refund action instead.');
  }
  // A locking read, not a plain SELECT — see `billFolioToCompany`'s identical
  // comment above for why: this contends for the same row `generateInvoice`'s
  // own eligibility query locks, so a concurrent invoice-generation and a void
  // attempt against the same line genuinely serialize rather than race.
  const invoicedAs = await trx.table('ar_invoice_lines').where({ folio_line_item_id: lineItemId }).forUpdate().first();
  if (invoicedAs) throw new CannotVoidInvoicedLineError(lineItemId);

  const now = new Date();
  await trx.table('folio_line_items').where({ id: lineItemId }).update({ voided_at: now, voided_by_user_id: userId, void_reason: reason });

  const dependentTaxLines = await trx.table('folio_line_items').where({ related_line_item_id: lineItemId, type: 'tax' }).whereNull('voided_at');
  for (const taxLine of dependentTaxLines) {
    await trx.table('folio_line_items').where({ id: taxLine.id }).update({ voided_at: now, voided_by_user_id: userId, void_reason: `Charge ${lineItemId} voided: ${reason}` });
  }

  await recomputeFolioBalance({ trx, folioId: line.folio_id });
  const folio = await trx.table('folios').where({ id: line.folio_id }).first();
  if (folio.company_profile_id) {
    const account = await arService.getActiveAccountForCompanyAtProperty({ trx, companyProfileId: folio.company_profile_id });
    if (account) await arService.recomputeArAccountBalance({ trx, arAccountId: account.id });
  }
  return trx.table('folio_line_items').where({ id: lineItemId }).first();
}

// ---------------------------------------------------------------------
// Payments — cash (real, synchronous) — ARCHITECTURE.md §7
// ---------------------------------------------------------------------

/**
 * PLAN.md Phase 4 (Accounts Receivable): a folio billed to a company
 * account (`folio.company_profile_id`) is rejected here outright — cash and
 * Paystack payment capture both route through this one guard, so neither
 * gateway path can settle part of what is meant to be collected through
 * Accounts Receivable instead. Allowing both would create two disagreeing
 * notions of what the company owes with no clean reconciliation rule.
 */
async function assertFolioOpenForPayment({ trx, folioId, amount, currency }) {
  // The amount is checked first and on every path, so a bad one is refused before anything is read or written.
  const checkedAmount = assertPaymentAmount(amount);
  const folio = await lockFolio({ trx, folioId });
  if (!folio) throw new ValidationError('FOLIO_NOT_FOUND', 'The specified folio does not exist.');
  if (folio.status !== 'open') throw new FolioClosedError(folioId);
  if (folio.company_profile_id) throw new CannotPayArBilledFolioDirectlyError(folioId);
  if (currency !== folio.currency) {
    throw new ValidationError('CURRENCY_MISMATCH', `A payment on this folio must be in ${folio.currency}.`, [{ field: 'currency', issue: 'mismatch' }]);
  }
  return { ...folio, checkedAmount };
}

/** No external gateway involved — cash is already physically collected by the time this is called, so capture is real and immediate, not a stub. */
async function captureCashPayment({ trx, folioId, amount, currency, idempotencyKey, userId, businessDate }) {
  const folio = await assertFolioOpenForPayment({ trx, folioId, amount, currency });
  amount = folio.checkedAmount;
  const effectiveBusinessDate = businessDate ?? (await propertyBusinessDate({ trx, propertyId: folio.property_id }));
  const reference = generateUlid();
  const now = new Date();

  const [paymentId] = await trx.table('payments').insert({
    folio_id: folioId,
    idempotency_key: idempotencyKey,
    provider: 'cash',
    provider_reference: reference,
    amount,
    currency,
    status: 'CAPTURED',
    captured_at: now,
  });

  await trx.table('folio_line_items').insert({
    folio_id: folioId,
    type: 'payment',
    description: 'Cash payment',
    amount: negateMoney(amount),
    currency,
    payment_method: 'cash',
    payment_id: paymentId,
    business_date: effectiveBusinessDate,
    posted_by_user_id: userId ?? null,
  });

  await recomputeFolioBalance({ trx, folioId });
  return trx.table('payments').where({ id: paymentId }).first();
}

/** The longest terminal reference kept (the same limit as a POS terminal sale's). */
const MAX_TERMINAL_REFERENCE = 60;

/**
 * A payment taken on the hotel's own physical card terminal. Lodgekeep RECORDS it (the terminal did the actual
 * charge): a synchronous CAPTURED payment with provider 'terminal' and the matching negative folio line, exactly like
 * cash, and no gateway call. The terminal's provider, reference and an account snapshot go to the side table
 * `payment_terminal_details`, so a cash or Paystack payment gains no column and every existing response keeps its shape.
 *
 * `terminal`: `{ accountId, reference }`, both optional. The account must exist at this property; its provider and
 * a display label + last 4 are snapshotted (no foreign key, so editing the account never rewrites history).
 */
async function captureTerminalPayment({ trx, folioId, amount, currency, idempotencyKey, userId, businessDate, terminal = {} }) {
  const reference = typeof terminal.reference === 'string' ? terminal.reference.trim() : '';
  if (reference.length > MAX_TERMINAL_REFERENCE) {
    throw new ValidationError('INVALID_TERMINAL_REFERENCE', `"reference" must be at most ${MAX_TERMINAL_REFERENCE} characters.`, [{ field: 'reference', issue: 'too_long' }]);
  }
  const folio = await assertFolioOpenForPayment({ trx, folioId, amount, currency });
  amount = folio.checkedAmount;
  const snapshot = terminal.accountId ? await terminalAccounts.snapshotAccount({ trx, accountId: terminal.accountId }) : null;
  const effectiveBusinessDate = businessDate ?? (await propertyBusinessDate({ trx, propertyId: folio.property_id }));

  const [paymentId] = await trx.table('payments').insert({
    folio_id: folioId,
    idempotency_key: idempotencyKey,
    provider: 'terminal',
    provider_reference: generateUlid(),
    amount,
    currency,
    status: 'CAPTURED',
    captured_at: new Date(),
  });
  await trx.table('payment_terminal_details').insert({
    payment_id: paymentId,
    terminal_provider: snapshot?.provider ?? null,
    terminal_reference: reference || null,
    terminal_account_label: snapshot?.label ?? null,
    terminal_account_last4: snapshot?.last4 ?? null,
  });
  await trx.table('folio_line_items').insert({
    folio_id: folioId,
    type: 'payment',
    description: 'Card payment (terminal)',
    amount: negateMoney(amount),
    currency,
    payment_method: 'terminal',
    payment_id: paymentId,
    business_date: effectiveBusinessDate,
    posted_by_user_id: userId ?? null,
  });

  await recomputeFolioBalance({ trx, folioId });
  const payment = await trx.table('payments').where({ id: paymentId }).first();
  const details = await trx.table('payment_terminal_details').where({ payment_id: paymentId }).first();
  return { ...payment, terminal: { provider: details.terminal_provider, reference: details.terminal_reference, account_label: details.terminal_account_label, account_last4: details.terminal_account_last4 } };
}

// ---------------------------------------------------------------------
// Payments — Paystack (real sandbox integration) — ARCHITECTURE.md §7
// ---------------------------------------------------------------------

// An unpaid folio card payment for the same amount is reopened rather than duplicated, but only while it is fresh.
const REUSABLE_INTENT_MAX_AGE_MS = 30 * 60 * 1000;

/** Phase 1 of 2 — the local intent row only, fully transactional. See file header for why the external call is NOT in here. */
async function initiatePaystackPaymentIntent({ trx, folioId, amount, currency, idempotencyKey, reuseOpen = false }) {
  const folio = await assertFolioOpenForPayment({ trx, folioId, amount, currency });
  amount = folio.checkedAmount;
  if (reuseOpen) {
    // The folio row is locked now, so two quick presses cannot both miss each other's row.
    const cutoff = new Date(Date.now() - REUSABLE_INTENT_MAX_AGE_MS);
    const open = await trx
      .table('payments')
      .where({ folio_id: folioId, provider: 'paystack', settlement_target: 'folio', currency })
      .whereNull('parent_payment_id')
      .whereIn('status', ['INITIATED', 'PENDING'])
      .where('created_at', '>', cutoff)
      .orderBy('id', 'desc')
      // A locking read: a plain read would keep the snapshot taken before the folio lock was granted and miss a row the other press just committed.
      .forUpdate();
    const same = open.find((row) => compareMoney(row.amount, amount) === 0);
    if (same) return { ...same, reused: true };
  }
  const reference = generateUlid();
  const [paymentId] = await trx.table('payments').insert({
    folio_id: folioId,
    idempotency_key: idempotencyKey,
    provider: 'paystack',
    provider_reference: reference,
    amount,
    currency,
    status: 'INITIATED',
  });
  return trx.table('payments').where({ id: paymentId }).first();
}

/**
 * PLAN.md Phase 6 (QR self-ordering gap closure) — the sibling of
 * `initiatePaystackPaymentIntent` for a guest QR order's card checkout:
 * the identical local-intent-only phase, but funding a `pos_orders` tab
 * (`settlement_target: 'pos_order'`) instead of a `folios` row. No
 * `assertFolioOpenForPayment`-equivalent AR/company check applies here —
 * a POS guest order has no company-billing concept at all — only that the
 * order itself is still genuinely open.
 */
async function initiatePosOrderPaystackPaymentIntent({ trx, posOrderId, amount, currency, idempotencyKey }) {
  const order = await trx.table('pos_orders').where({ id: posOrderId }).first();
  if (!order) throw new ValidationError('ORDER_NOT_FOUND', 'The specified order does not exist.');
  if (order.status !== 'open') throw new OrderNotOpenError(posOrderId, order.status);

  const reference = generateUlid();
  const [paymentId] = await trx.table('payments').insert({
    pos_order_id: posOrderId,
    settlement_target: 'pos_order',
    idempotency_key: idempotencyKey,
    provider: 'paystack',
    provider_reference: reference,
    amount,
    currency,
    status: 'INITIATED',
  });
  return trx.table('payments').where({ id: paymentId }).first();
}

/**
 * POS Register card/NQR checkout — the sibling of
 * `initiatePosOrderPaystackPaymentIntent` for a STAFF Register tab. The
 * payment funds exactly one check (`split_group`) and is never settled by
 * the gateway result itself (`applyGatewayResult`'s `pos_register` branch
 * only captures it): `pos/service.js`'s own `settleOrder` links it to a
 * settlement afterwards, once it has checked the captured amount covers
 * that check's exact total. `amount` is computed by the caller, server-side,
 * never taken from the request body.
 */
async function initiatePosRegisterPaymentIntent({ trx, posOrderId, splitGroup, tender, amount, currency, idempotencyKey }) {
  const reference = generateUlid();
  const [paymentId] = await trx.table('payments').insert({
    pos_order_id: posOrderId,
    settlement_target: 'pos_register',
    split_group: splitGroup ?? null,
    tender,
    idempotency_key: idempotencyKey,
    provider: 'paystack',
    provider_reference: reference,
    amount,
    currency,
    status: 'INITIATED',
  });
  return trx.table('payments').where({ id: paymentId }).first();
}

/**
 * Which Paystack subaccount a payment settles to: the outlet's own account when
 * the payment funds a POS order at an outlet that has one, else the property's,
 * else none (the caller refuses the checkout — never the platform account).
 * Folio and portal payments carry no `pos_order_id`, so they always take the
 * property's. `source` is stamped on the payment next to `subaccount_code`.
 */
async function resolvePayoutSubaccount(db, payment) {
  // A supermarket online sale has no POS tab until it is paid: its outlet comes from the pending sale.
  if (payment.settlement_target === 'supermarket_sale') {
    const intent = await db.table('supermarket_sale_intents').where({ payment_id: payment.id }).first('outlet_id');
    if (intent) {
      const outletRow = await db.table('pos_outlet_payment_subaccounts').where({ outlet_id: intent.outlet_id, is_active: true }).first();
      if (outletRow) return { row: outletRow, source: 'outlet' };
    }
  }
  if (payment.pos_order_id) {
    const order = await db.table('pos_orders').where({ id: payment.pos_order_id }).first('outlet_id');
    if (order) {
      const outletRow = await db.table('pos_outlet_payment_subaccounts').where({ outlet_id: order.outlet_id, is_active: true }).first();
      if (outletRow) return { row: outletRow, source: 'outlet' };
    }
  }
  const propertyRow = await db.table('property_payment_subaccounts').where({ property_id: payment.property_id, is_active: true }).first();
  return propertyRow ? { row: propertyRow, source: 'property' } : { row: null, source: null };
}

/**
 * Phase 2 of 2 — the real external call, deliberately OUTSIDE any
 * transaction (ARCHITECTURE.md §6.4). Idempotent by construction: a payment
 * not still `INITIATED` (already progressed by a prior successful call, a
 * webhook, or a manual verify) is a no-op, so retrying this after a prior
 * partial failure is always safe.
 *
 * Gap closure (user-reported): "can't it be done same page ... instead of a
 * url." `paystack.initializeTransaction` already captured `access_code` from
 * Paystack's own `/transaction/initialize` response — it just never left
 * this function. `accessCode` is now returned alongside `authorizationUrl`
 * so a caller can open Paystack's own embedded Inline JS popup
 * (`resumeTransaction(accessCode)`) INSTEAD of redirecting to the hosted
 * link, without a second call to Paystack — the same transaction, two ways
 * to complete it. `authorizationUrl` is kept, unchanged, for the case a
 * caller still wants a plain link (e.g. to send to a guest who isn't
 * physically present). Reconciliation is unchanged either way — a client
 * popup's own success callback is never trusted by itself (ARCHITECTURE.md
 * §7); the real state transition still only happens via the webhook or the
 * existing `POST /cashiering/payments/:id/verify`.
 *
 * Gap closure: guest card revenue must reach the property, not one shared
 * platform account. Before ever calling Paystack, this resolves the
 * property's own `property_payment_subaccounts` row and passes its
 * `subaccount_code` to `initializeTransaction` — Paystack then auto-splits
 * the charge at settlement per that subaccount's own `percentage_charge`.
 * A property with none configured gets a real, actionable
 * `PropertyPayoutNotConfiguredError` (422) rather than a silent fallback
 * to the old shared-key behaviour, which would reintroduce the exact
 * defect this pass exists to close. `subaccount_code` is stamped onto the
 * `payments` row at the same time — a snapshot of what THIS payment
 * actually used, never re-derived later (see that migration's own
 * header).
 */
async function startPaystackCheckout({ context, paymentId, guestEmail, callbackUrl, channels, resume = false }) {
  const db = scopedDb().for(context);
  const payment = await db.table('payments').where({ id: paymentId }).first();
  if (!payment) throw new ValidationError('PAYMENT_NOT_FOUND', 'The specified payment does not exist.');
  if (payment.status !== 'INITIATED') {
    // A Register payment whose popup was closed unpaid stays PENDING (see
    // `verifyPayment`); hand back its stored access code so the cashier's
    // retry reopens the SAME Paystack transaction rather than a second one.
    // `resume` (the staff folio capture, when it reused its own unpaid
    // payment) opts a folio payment into the same behaviour.
    const resumable = (RESUMABLE_TARGETS.has(payment.settlement_target) || resume) && payment.status === 'PENDING' ? payment.provider_access_code : null;
    // Paystack's hosted page for a transaction is always /<access_code>.
    const resumedUrl = resume && resumable ? `https://checkout.paystack.com/${resumable}` : null;
    return { payment, authorizationUrl: resumedUrl, accessCode: resumable ?? null };
  }

  // Security fix — `callback_url` used to reach Paystack unvalidated, a
  // classic open redirect (see `src/shared/callback-url.js`'s own header).
  await assertAllowedCallbackUrl(db, { callbackUrl });

  const { adapter } = await paystack.resolveAdapterForCurrency(db, payment.currency);
  const { row: subaccountRow, source: subaccountSource } = await resolvePayoutSubaccount(db, payment);
  if (!subaccountRow) throw new paystack.PropertyPayoutNotConfiguredError(payment.property_id);

  const init = await adapter.initializeTransaction({
    email: guestEmail,
    amount: payment.amount,
    currency: payment.currency,
    reference: payment.provider_reference,
    callbackUrl,
    channels,
    subaccount: subaccountRow.subaccount_code,
  });

  await db
    .table('payments')
    .where({ id: paymentId })
    .update({
      status: 'PENDING',
      provider_access_code: init.accessCode ?? null,
      subaccount_code: subaccountRow.subaccount_code,
      subaccount_source: subaccountSource,
      // Snapshot, not a live join — see that column's own migration header
      // (the payment reconciliation report's gap closure) for why this must
      // be captured now rather than re-derived from the property's current,
      // mutable config at report time.
      platform_fee_percentage: subaccountRow.percentage_charge,
    });
  const updated = await db.table('payments').where({ id: paymentId }).first();
  return { payment: updated, authorizationUrl: init.authorizationUrl, accessCode: init.accessCode };
}

const TERMINAL_PAYMENT_STATUSES = new Set(['CAPTURED', 'FAILED', 'EXPIRED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED']);

// Checkouts the payer may reopen, cancel locally and still pay later (a late
// capture is recorded so a refund can find it): the staff Register's, and the
// supermarket till's online sale.
const RESUMABLE_TARGETS = new Set(['pos_register', 'supermarket_sale']);
const LATE_CAPTURE_REASONS = {
  pos_register: 'Captured after its Register checkout was cancelled; no settlement uses it, so it needs a refund.',
  supermarket_sale: 'Captured after its supermarket checkout was cancelled; no sale uses it, so it needs a refund.',
};

/**
 * The supermarket module completes its own online sales on capture (see
 * `supermarket/paystack-sale.js`). It is registered from there at load time
 * rather than required here, because the supermarket module requires pos,
 * which requires this file. Without it a supermarket capture refuses to apply
 * (and is retried) rather than capture money with no sale.
 */
let supermarketCaptureFinalizer = null;
function setSupermarketCaptureFinalizer(fn) {
  supermarketCaptureFinalizer = fn;
}

/**
 * PLAN.md Phase 6 (QR self-ordering gap closure) — the pos_order-target
 * counterpart of `applyGatewayResult`'s success branch. A guest's card
 * order has no folio at all; capture means recording a real `card`
 * settlement against the `pos_orders` tab (the exact `subtotal`/
 * `tax_amount` split `settleOrder`'s own cash/card branch already
 * computes, replicated here since a guest order never goes through that
 * function directly) and flipping the tab to `settled`.
 *
 * Idempotent by construction, on top of `applyGatewayResult`'s own
 * conditional-UPDATE guard: locks the order first and no-ops if it is no
 * longer `open` (already settled by a concurrent path, or a stale/late
 * webhook for an order a manual reject already voided) — the same
 * "lock, then check, then write" discipline `pos/service.js`'s own
 * `settleOrder`/`lockOrderAndItem` already establish.
 */
async function finalizePosOrderCardCapture({ trx, payment, userId }) {
  const order = await trx.table('pos_orders').where({ id: payment.pos_order_id }).forUpdate().first();
  if (!order || order.status !== 'open') return;

  // Code-review fix (CRITICAL) — defense-in-depth beyond the order's own
  // `status` above: a Paystack webhook reaches this function WITHOUT ever
  // going through `qr-ordering/service.js`'s own `assertGuestOrderNotRejected`
  // guard (it arrives addressed only by payment reference, no guest-order
  // lookup involved), so it could theoretically land in the narrow window
  // where this order is still genuinely `open` but its guest-facing
  // `pos_guest_orders.status` has already flipped to `rejected`/
  // `auto_rejected` (`qr-ordering/service.js`'s `rejectGuestOrder`/
  // `tryAutoReject` flip that column before they cancel the payment/void
  // the order that follows). Never honor a capture in that window — the
  // caller (`applyGatewayResult`) already claimed `payment.status =
  // 'CAPTURED'` earlier in this SAME transaction, so undo that claim here
  // rather than commit a captured payment with no settlement and nothing
  // left to reverse it.
  const guestOrder = await trx.table('pos_guest_orders').where({ pos_order_id: order.id }).first();
  if (guestOrder && (guestOrder.status === 'rejected' || guestOrder.status === 'auto_rejected')) {
    await trx.table('payments').where({ id: payment.id }).update({ status: 'CANCELLED' });
    return;
  }

  const items = await trx.table('pos_order_items').where({ pos_order_id: order.id }).whereNull('voided_at');
  const baseAmount = sumMoney(items.map(computeItemLineTotal));

  const property = await trx.table('properties').where({ id: order.property_id }).first('current_business_date');
  const allTaxRows = await trx.table('taxes');
  const saleOutlet = await trx.table('pos_outlets').where({ id: order.outlet_id }).first('type');
  const taxVersions = resolveApplicableTaxVersions({ allTaxRows, businessDate: property?.current_business_date, chargeType: taxChargeTypeForOutlet(saleOutlet) });
  const { netAmount, taxLines } = computeChargeWithTax({ baseAmount, taxVersions });
  const taxAmount = sumMoney(taxLines.map((t) => t.amount));
  // A QR order pays the service charge frozen when the guest placed it (null = none), worked out from the net.
  const frozen = guestOrder ? await trx.table('pos_guest_order_service_charges').where({ pos_order_id: order.id }).first('service_charge_percent') : null;
  const serviceCharge = frozen ? percentOfMoney(netAmount, String(frozen.service_charge_percent)) : '0.00';

  const [settlementId] = await trx.table('pos_order_settlements').insert({
    pos_order_id: order.id,
    method: 'card',
    subtotal: netAmount,
    tax_amount: taxAmount,
    service_charge: serviceCharge,
    currency: payment.currency,
    payment_id: payment.id,
    tender: 'card',
    business_date: property?.current_business_date ?? null,
    settled_by_user_id: userId ?? null,
  });
  await trx.table('pos_orders').where({ id: order.id }).update({ status: 'settled', closed_at: new Date() });

  // Gap closure — the stock-out override guard. No human is present at
  // this call site (a Paystack webhook, or the guest's own confirm-payment
  // callback) and money has already been captured by the gateway by the
  // time this runs, so a rejection here would be strictly worse than
  // proceeding — always auto-overridden, `source: 'integration'`, the
  // correct one of the six fixed `audit_log.source` values for a
  // webhook-originated mutation.
  await stockService.assertStockAvailableOrOverridden({
    trx,
    lines: items.map((item) => ({ menuItemId: item.menu_item_id, quantity: item.quantity })),
    overrideReason: stockService.AUTOMATIC_OVERRIDE_REASON_CARD_CAPTURE,
    userId: userId ?? null,
    propertyId: order.property_id,
    outletId: order.outlet_id,
    source: 'integration',
  });

  // PLAN.md Phase 6 (POS inventory & stock control) — this settlement
  // writer has no split-group concept (it always settles the WHOLE
  // order's unvoided `items`, already fetched above), so it deducts stock
  // for every one of them in a single call, mirroring `pos/service.js`'s
  // own `settleOrder` hook exactly.
  await stockService.deductStockForSettlement({
    trx,
    orderId: order.id,
    settlementId,
    items,
    businessDate: property?.current_business_date,
    userId: userId ?? null,
  });

  const chargedTotal = sumMoney([netAmount, taxAmount, serviceCharge]);
  if (!guestOrder) {
    await notifyStaff({
      trx,
      eventType: 'pos.order_settled',
      payload: { orderId: order.id, tableLabel: order.table_label ?? null, total: chargedTotal, currency: payment.currency, methods: ['card'] },
    });
  }

  if (guestOrder) {
    await trx.table('pos_guest_orders').where({ id: guestOrder.id }).update({ payment_status: 'paid', status: 'received' });
    await notifyGuestOrderReceived({ db: trx, guestOrderId: guestOrder.id, total: chargedTotal, currency: payment.currency });
    // A receipt is genuinely optional — a large share of guest orders
    // supply no contact at all (`pos_guest_orders.guest_contact` is
    // nullable by design). Sent only when the contact actually looks like
    // an email — a phone number handed to the email adapter would just
    // fail delivery after retries for no benefit, and `guest_contact` is a
    // single free-text field that could hold either.
    if (guestOrder.guest_contact && guestOrder.guest_contact.includes('@')) {
      const property = await trx.table('properties').where({ id: order.property_id }).first('name');
      await writeOutboxEvent({
        trx,
        eventType: 'pos.guest_order_receipt',
        aggregateType: 'pos_guest_orders',
        aggregateId: guestOrder.id,
        propertyId: order.property_id,
        payload: { recipientEmail: guestOrder.guest_contact, amount: chargedTotal, currency: payment.currency, propertyName: property?.name ?? '' },
      });
    }
  }
}

/**
 * Applies a gateway's verification result (Paystack's `status: 'success'`/
 * `'failed'`/`'abandoned'`) to the local payment — shared by both
 * `verifyPayment` (manual sync) and `handlePaystackWebhook` (real-time),
 * since both converge on the exact same state transition + folio/order
 * effect, applied idempotently.
 *
 * PLAN.md Phase 6 (QR self-ordering gap closure) — a real, previously
 * latent race in this function's own guard, surfaced and fixed while
 * building the mandated "racing webhook + guest confirm-payment callback"
 * concurrency test: the ORIGINAL guard checked `payment.status` as PASSED
 * IN by the caller, not a fresh read — two racing callers (a webhook and a
 * guest's own confirm callback) can each read the same still-`PENDING`
 * snapshot before either writes, so both would pass this check and both
 * would apply the success effect below, double-posting it (a genuine bug
 * for the pre-existing folio path too, not only the new pos_order one).
 * Fixed with a conditional UPDATE + affected-row check (ARCHITECTURE.md
 * §5's own idiom) instead of trusting the in-memory value — the database,
 * not a stale object, now decides which of two racing callers actually
 * gets to apply the effect.
 */
async function applyGatewayResult({ trx, payment, gatewayStatus, providerPaymentId, channel, userId }) {
  // A Register checkout cancelled locally (tab voided, tender switched) is
  // still payable on Paystack's side. If the guest pays it anyway, the money
  // is real: record the capture rather than drop it, so a refund can find it.
  const lateRegisterCapture = RESUMABLE_TARGETS.has(payment.settlement_target) && payment.status === 'CANCELLED' && gatewayStatus === 'success';
  if (TERMINAL_PAYMENT_STATUSES.has(payment.status) && !lateRegisterCapture) {
    return trx.table('payments').where({ id: payment.id }).first();
  }

  if (gatewayStatus === 'success') {
    const now = new Date();
    const claimableStatuses = [...TERMINAL_PAYMENT_STATUSES].filter((status) => !(lateRegisterCapture && status === 'CANCELLED'));
    const claimed = await trx
      .table('payments')
      .where({ id: payment.id })
      .whereNotIn('status', claimableStatuses)
      .update({
        status: 'CAPTURED',
        captured_at: now,
        ...(channel ? { provider_channel: channel } : {}),
        ...(lateRegisterCapture ? { failure_reason: LATE_CAPTURE_REASONS[payment.settlement_target] } : {}),
        provider_payment_id: providerPaymentId ?? payment.provider_payment_id,
      });
    if (claimed === 0) {
      // A concurrent caller already claimed and applied this outcome —
      // the same idempotent no-op the TERMINAL_PAYMENT_STATUSES check
      // above covers, just decided by the database instead of a
      // possibly-stale in-memory value.
      return trx.table('payments').where({ id: payment.id }).first();
    }

    if (payment.settlement_target === 'pos_order') {
      await finalizePosOrderCardCapture({ trx, payment: { ...payment, provider_payment_id: providerPaymentId ?? payment.provider_payment_id }, userId });
    } else if (payment.settlement_target === 'pos_register') {
      // Capture only — the Register's own `settleOrder` links this payment
      // to a settlement once it has checked the amount (see
      // `initiatePosRegisterPaymentIntent`). No folio exists to post to.
    } else if (payment.settlement_target === 'supermarket_sale') {
      // The supermarket completes its sale in THIS transaction (exactly once:
      // the claim above already decided which caller applies the capture).
      if (!supermarketCaptureFinalizer) throw new Error('A supermarket payment was captured but the supermarket module is not loaded to complete its sale.');
      await supermarketCaptureFinalizer({ trx, payment: { ...payment, status: 'CAPTURED', provider_payment_id: providerPaymentId ?? payment.provider_payment_id }, lateCapture: lateRegisterCapture });
    } else {
      const folio = await lockFolio({ trx, folioId: payment.folio_id });
      const businessDate = await propertyBusinessDate({ trx, propertyId: folio.property_id });
      await trx.table('folio_line_items').insert({
        folio_id: payment.folio_id,
        type: 'payment',
        description: 'Paystack payment',
        amount: negateMoney(payment.amount),
        currency: payment.currency,
        payment_method: 'paystack',
        payment_id: payment.id,
        business_date: businessDate,
        posted_by_user_id: userId ?? null,
      });
      await recomputeFolioBalance({ trx, folioId: payment.folio_id });
    }
  } else {
    await trx
      .table('payments')
      .where({ id: payment.id })
      .whereNotIn('status', [...TERMINAL_PAYMENT_STATUSES])
      .update({
        status: 'FAILED',
        failed_at: new Date(),
        failure_reason: `Gateway reported status "${gatewayStatus}".`,
        provider_payment_id: providerPaymentId ?? payment.provider_payment_id,
      });
  }

  return trx.table('payments').where({ id: payment.id }).first();
}

const DEFAULT_RECORD_NOT_FOUND_MIN_AGE_DAYS = 7;

/** `PAYMENT_RECORD_NOT_FOUND_MIN_AGE_DAYS` (default 7); a garbage or non-positive value falls back to the default. */
function recordNotFoundMinAgeMs() {
  const days = Number(process.env.PAYMENT_RECORD_NOT_FOUND_MIN_AGE_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_RECORD_NOT_FOUND_MIN_AGE_DAYS) * 24 * 60 * 60 * 1000;
}

function isOlderThanRecordNotFoundAge(createdAt) {
  return Date.now() - new Date(createdAt).getTime() >= recordNotFoundMinAgeMs();
}

/**
 * Paystack definitively has no record of an old, unpaid payment: close it as CANCELLED. The update
 * is conditional on the payment still being unpaid, so a capture that lands meanwhile is never overwritten.
 */
async function closePaymentUnknownToGateway({ db, payment, userId }) {
  return db.transaction(async (trx) => {
    const closed = await trx
      .table('payments')
      .where({ id: payment.id })
      .whereIn('status', ['INITIATED', 'PENDING'])
      .update({ status: 'CANCELLED', failure_code: 'gateway_record_not_found', failure_reason: 'Paystack has no record of this payment.' });
    if (closed > 0) {
      await recordAuditEntry(trx, {
        entityType: 'payments',
        entityId: payment.id,
        propertyId: payment.property_id,
        userId: userId ?? null,
        action: 'gateway_payment_closed',
        source: 'api',
        beforeState: { status: payment.status },
        afterState: { status: 'CANCELLED', code: 'gateway_record_not_found' },
        reason: 'Paystack reported no such transaction for a payment older than the allowed age.',
      });
    }
    return trx.table('payments').where({ id: payment.id }).first();
  });
}

/** The manual/fallback sync path (`src/modules/cashiering/paystack-adapter.js`'s own header explains why this exists alongside the webhook). */
async function verifyPayment({ context, paymentId, userId }) {
  const db = scopedDb().for(context);
  const payment = await db.table('payments').where({ id: paymentId }).first();
  if (!payment) throw new ValidationError('PAYMENT_NOT_FOUND', 'The specified payment does not exist.');
  if (payment.provider !== 'paystack') {
    throw new ValidationError('NOT_A_GATEWAY_PAYMENT', 'Only a gateway-processed payment can be verified against the provider.');
  }
  if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) return payment;

  const { adapter } = await paystack.resolveAdapterForCurrency(db, payment.currency);
  let result;
  try {
    result = await adapter.verifyTransaction({ reference: payment.provider_reference });
  } catch (error) {
    // "Paystack has no such transaction" is definitive only for an OLD payment (e.g. one made
    // with a test key before a live cutover). A recent one may just not have propagated yet.
    if (interpretGatewayError(error) === 'record_not_found' && isOlderThanRecordNotFoundAge(payment.created_at)) {
      return closePaymentUnknownToGateway({ db, payment, userId });
    }
    throw error;
  }

  // Paystack's record must AGREE with the local payment before anything is
  // applied — the same check the webhook path makes (`src/shared/gateway-record.js`).
  // Only a disagreement stops here; how a not-yet-final status is treated below
  // is unchanged (portal and QR flows key off it). The payment is left as it was.
  const comparison = classifyGatewayRecord({
    record: result,
    local: { reference: payment.provider_reference, amount: payment.amount, currency: payment.currency },
  });
  if (comparison.verdict === 'mismatch') {
    await recordAuditEntry(db, {
      entityType: 'payments',
      entityId: payment.id,
      propertyId: payment.property_id,
      userId: userId ?? null,
      action: 'gateway_verification_rejected',
      source: 'api',
      afterState: { code: comparison.reasons[0].code, reasons: comparison.reasons, expected: comparison.expected, observed: comparison.observed },
      reason: 'The gateway record did not match the local payment on confirmation; nothing was applied.',
    });
    throw new PaymentGatewayRecordMismatchError(payment.id, comparison.reasons);
  }

  // A Register cashier verifies the moment the popup closes — often because
  // the guest closed it before paying ('abandoned') or is still mid-payment
  // ('ongoing'/'pending'). Only a definite gateway failure ends a Register
  // payment; anything else leaves it PENDING so a retry reopens the same
  // transaction (`startPaystackCheckout`) instead of charging twice.
  if (RESUMABLE_TARGETS.has(payment.settlement_target) && result.status !== 'success' && result.status !== 'failed') {
    return payment;
  }
  return db.transaction((trx) =>
    applyGatewayResult({
      trx,
      payment,
      gatewayStatus: result.status === 'success' ? 'success' : 'failed',
      providerPaymentId: result.providerPaymentId,
      channel: result.channel,
      userId,
    })
  );
}

/**
 * API.md §7: verified, persisted, deduplicated, processed idempotently,
 * `200` on persistence. `rawBody`/`signatureHeader` come straight from the
 * HTTP layer (`controller.js`'s `receivePaystackWebhook`) — this function
 * never trusts a parsed body for the signature check.
 *
 * ── THE SAME BOOTSTRAPPING PROBLEM `tenant-resolution.js`/THE OUTBOX SWEEP
 * ALREADY SOLVED ─────────────────────────────────────────────────────────
 *
 * A webhook arrives with no session and, crucially, no KNOWN tenant either
 * — `payment_webhook_events` (PLATFORM_SCOPED, reached via `systemContext()`)
 * is where the raw event is persisted regardless. But resolving WHICH
 * tenant's payment a reference belongs to is exactly the kind of read
 * `src/jobs/outbox-dispatcher.js`'s own header documents doing via `knex()`
 * directly: there is no context yet to scope the lookup by, because
 * discovering the tenant IS the lookup. Once the owning `payments` row is
 * found this way, everything else proceeds through the normal scoped
 * accessor via a real `workerContext({tenantId, propertyId})` — this raw
 * read is the one, deliberate exception, not a new escape hatch.
 *
 * ── MULTI-CURRENCY SIGNATURE VERIFICATION USES THE SAME "LOOK UP BY
 * REFERENCE FIRST" PATTERN, EXTENDED ─────────────────────────────────────
 *
 * Verifying now needs to know WHICH secret key to check the signature
 * against (one per settlement currency, `platform_payment_integrations`).
 * That currency is resolved the exact same way the tenant already was
 * ABOVE — by looking up the real `payments` row the payload's own
 * (as-yet-unverified) `reference` names, and reading that row's own
 * `currency` column. This never weakens the security guarantee: the
 * signature is still verified in full, against the secret this specific
 * transaction's currency actually resolves to, before ANYTHING from the
 * payload is acted on. A reference that matches no real payment simply
 * cannot be verified at all (there is no secret to check it against),
 * which is the same outcome as today for any other unmatched webhook.
 */
async function handlePaystackWebhook({ rawBody, signatureHeader, parsedBody }) {
  // A charge event names the transaction as `reference`; a refund event as `transaction_reference`.
  const reference = parsedBody?.data?.reference ?? parsedBody?.data?.transaction_reference;
  const rawPayment = reference ? await knex()('payments').where({ provider: 'paystack', provider_reference: reference }).first() : null;

  // Only "no credentials configured for this currency" means the event cannot be
  // verified. Any OTHER failure (a database blip, a decrypt error) is a real
  // error: it must surface as a 5xx so Paystack redelivers, rather than a
  // genuine event being persisted as unsigned and never processed.
  const verified = rawPayment
    ? (
        await paystack.resolveAdapterForCurrency(knex(), rawPayment.currency).catch((error) => {
          if (error?.code === 'PAYMENT_GATEWAY_NOT_CONFIGURED') return null;
          throw error;
        })
      )?.adapter.verifyWebhookSignature({ rawBody, signatureHeader }) ?? false
    : false;
  const providerEventId = webhookEventKey({ event: parsedBody?.event, id: parsedBody?.data?.id ?? parsedBody?.id, fallback: generateUlid() });

  // Persist FIRST (API.md §7). An unsigned request is kept as evidence but can
  // never block or alter a later signed event with the same id, and a signed
  // redelivery of an event that was persisted but never finalized is processed
  // again instead of being deduplicated away — see `src/shared/webhook-events.js`.
  const persisted = await persistWebhookEvent({
    events: paymentWebhookEvents,
    provider: 'paystack',
    providerEventId,
    payload: parsedBody,
    verified,
    attribution: rawPayment ? { tenant_id: rawPayment.tenant_id, property_id: rawPayment.property_id, related_payment_id: rawPayment.id } : {},
  });

  if (!verified) return { verified: false };
  if (!persisted.needsProcessing) return { deduplicated: true };

  const { outcome } = await processPaymentWebhookEvent({ eventId: persisted.id });
  return { verified: true, matched: Boolean(rawPayment), outcome };
}

/** A fresh PLATFORM_SCOPED table builder for the event table — `persistWebhookEvent`/`finalizeWebhookEvent` want one per call. */
function paymentWebhookEvents() {
  return scopedDb().for(systemContext()).table('payment_webhook_events');
}

/** The only Paystack events that may change a payment's state. Anything else is recorded and ignored. */
const WEBHOOK_CHARGE_EVENTS = new Set(['charge.success', 'charge.failed']);
/** A payment that already holds (or has held) the money: nothing a webhook says can change it. */
const SETTLED_PAYMENT_STATUSES = new Set(['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED']);

/**
 * Decides ONE persisted webhook event — ARCHITECTURE.md §7: the webhook is a
 * hint, Paystack's own record is the truth.
 *
 * A valid HMAC proves who SENT the event, not that what it CLAIMS is what
 * Paystack holds. So nothing in the body (status, amount, currency) is
 * trusted: this asks Paystack for its record of the transaction
 * (`verifyTransaction`, the same call the browser-confirmation path makes),
 * compares that record to the LOCAL payment (`classifyGatewayRecord`), and
 * applies the outcome the RECORD dictates, through `applyGatewayResult`
 * exactly as before. The amount credited was always the local
 * `payments.amount`; what is new is that money is only recorded when
 * Paystack confirms it collected that amount in that currency.
 *
 * Keyed by the persisted event row and safe to call any number of times,
 * concurrently or not: the inline webhook attempt, a Paystack redelivery and
 * the retry sweep (`src/jobs/payment-webhooks.js`) all land here.
 *
 * The verify call runs with NO database transaction open (ARCHITECTURE.md
 * §6.4); the apply is its own short transaction, untouched.
 *
 * Outcomes recorded on the event row:
 *   applied        state changed to what Paystack's record says
 *   ignored        not a charge event / no local payment / already settled / already terminal
 *   rejected       signed, but Paystack's record disagrees with the local payment (or has none).
 *                  Nothing is captured; the payment is left open so a genuine payment can still arrive.
 *   needs_review   Paystack confirms a matching payment but the local one was already
 *                  FAILED/EXPIRED/CANCELLED (the guest paid after the popup closed): flagged, ledger untouched
 *   (still NULL)   Paystack unreachable / transaction not final: scheduled for retry
 *   deferred_exhausted  gave up retrying
 */
async function decidePaymentWebhookEvent({ eventId, now = new Date() }) {
  const events = paymentWebhookEvents;
  const event = await events().where({ id: eventId }).first();
  if (!event) return { outcome: null, skipped: true };
  if (event.outcome != null || !event.verified) return { outcome: event.outcome, skipped: true };

  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
  const eventType = payload?.event;
  const reference = payload?.data?.reference;

  const finalize = async (outcome, detail, attribution) => {
    await finalizeWebhookEvent({ events, id: event.id, outcome, detail, attribution, now });
    return { outcome };
  };

  if (REFUND_WEBHOOK_EVENTS.has(eventType)) return decideRefundWebhookEvent({ event: { ...event, event: eventType }, payload, finalize });
  if (!WEBHOOK_CHARGE_EVENTS.has(eventType)) return finalize('ignored', { reason: 'event_not_handled', event: eventType ?? null });

  const payment = reference ? await knex()('payments').where({ provider: 'paystack', provider_reference: reference }).first() : null;
  if (!payment) return finalize('ignored', { reason: 'unknown_reference' });

  const attribution = { tenant_id: payment.tenant_id, property_id: payment.property_id, related_payment_id: payment.id };

  // A tenant being purged (or purged) accepts nothing: the event is recorded and
  // dropped, never applied to data that is about to be, or already was, deleted.
  const owner = await knex()('tenants').where({ id: payment.tenant_id }).first('status');
  if (!owner || ['purging', 'purged'].includes(owner.status)) return finalize('ignored', { reason: 'tenant_purging' }, attribution);

  if (SETTLED_PAYMENT_STATUSES.has(payment.status)) return finalize('ignored', { reason: 'already_settled', paymentStatus: payment.status }, attribution);

  // A Register checkout cancelled locally is still payable at Paystack; a late
  // capture of it is real money `applyGatewayResult` already knows how to record.
  const lateRegisterCapture = RESUMABLE_TARGETS.has(payment.settlement_target) && payment.status === 'CANCELLED';
  const terminalUnpaid = TERMINAL_PAYMENT_STATUSES.has(payment.status) && !lateRegisterCapture;
  if (terminalUnpaid && eventType === 'charge.failed') return finalize('ignored', { reason: 'already_terminal', paymentStatus: payment.status }, attribution);

  const defer = async (reason) => {
    const result = await deferWebhookEvent({ events, id: event.id, attemptCount: event.attempt_count, reason, now });
    if (result === 'deferred_exhausted') {
      await recordWebhookAudit({ payment, action: 'gateway_webhook_deferred_exhausted', detail: { eventId: event.id, reason } });
    }
    return { outcome: result };
  };

  let record;
  try {
    const { adapter } = await paystack.resolveAdapterForCurrency(knex(), payment.currency);
    record = await adapter.verifyTransaction({ reference: payment.provider_reference });
  } catch (error) {
    if (interpretGatewayError(error) === 'record_not_found') {
      // Not decided on the first look (read-after-write lag, a rotated key): retry a few
      // times, and only a persistent 404 is a rejection.
      if (event.attempt_count < RECORD_NOT_FOUND_GRACE_ATTEMPTS) return defer('record_not_found');
      const detail = { code: 'RECORD_NOT_FOUND', message: 'Paystack has no transaction with this reference.', httpStatus: 404 };
      await recordWebhookAudit({ payment, action: 'gateway_webhook_rejected', detail: { eventId: event.id, ...detail } });
      return finalize('rejected', detail, attribution);
    }
    // Paystack unreachable, rate-limited, or a bad/missing key: not a verdict.
    // Loud, because a misconfigured key must never look like a quiet rejection.
    console.error(`[payment-webhook] could not verify ${payment.provider_reference} with Paystack (event ${event.id}): ${error?.message ?? error}`);
    return defer(`verify_failed: ${error?.message ?? 'unknown error'}`);
  }

  const result = classifyGatewayRecord({
    record,
    local: { reference: payment.provider_reference, amount: payment.amount, currency: payment.currency },
  });

  if (result.verdict === 'mismatch') {
    const detail = { code: result.reasons[0].code, reasons: result.reasons, expected: result.expected, observed: result.observed };
    console.error(`[payment-webhook] REJECTED signed event ${event.id} for ${payment.provider_reference}: ${result.reasons.map((r) => r.code).join(', ')}`);
    await recordWebhookAudit({ payment, action: 'gateway_webhook_rejected', detail: { eventId: event.id, ...detail } });
    return finalize('rejected', detail, attribution);
  }

  if (result.verdict === 'not_final') {
    if (terminalUnpaid) return finalize('ignored', { reason: 'already_terminal', paymentStatus: payment.status }, attribution);
    return defer(`transaction_not_final: ${record.status}`);
  }

  if (terminalUnpaid) {
    if (result.verdict === 'failed') return finalize('ignored', { reason: 'already_terminal', paymentStatus: payment.status }, attribution);
    // Paystack confirms a matching payment, but locally it was already failed /
    // expired / cancelled — possibly with a booking abandoned around it. Money is
    // at Paystack with nothing in the ledger. Flag it; do not reverse product
    // decisions (inventory release, cancellation) automatically.
    const detail = { reason: 'paid_after_terminal', paymentStatus: payment.status, providerPaymentId: record.providerPaymentId };
    await recordWebhookAudit({ payment, action: 'gateway_webhook_needs_review', detail: { eventId: event.id, ...detail } });
    return finalize('needs_review', detail, attribution);
  }

  try {
    const context = workerContext({ tenantId: payment.tenant_id, propertyId: payment.property_id });
    await scopedDb()
      .for(context)
      .transaction((trx) =>
        applyGatewayResult({
          trx,
          payment,
          gatewayStatus: result.verdict === 'confirmed' ? 'success' : String(record.status).toLowerCase(),
          providerPaymentId: record.providerPaymentId,
          channel: record.channel,
        })
      );
  } catch (error) {
    console.error(`[payment-webhook] applying event ${event.id} for ${payment.provider_reference} failed: ${error?.message ?? error}`);
    return defer(`apply_failed: ${error?.message ?? 'unknown error'}`);
  }

  return finalize('applied', { appliedStatus: result.verdict === 'confirmed' ? 'success' : 'failed', paystackStatus: record.status }, attribution);
}

/**
 * The public entry point for deciding one persisted event: the inline webhook
 * attempt, a Paystack redelivery and the retry sweep all call this. It NEVER
 * throws — an unexpected error is logged and the event is deferred under the
 * normal attempt cap (`deferred_exhausted` after `MAX_ATTEMPTS`), so a poison
 * event can neither 500 the webhook (API.md §7: only a failure to persist is
 * non-2xx) nor loop in the sweep forever.
 */
async function processPaymentWebhookEvent({ eventId, now = new Date() }) {
  try {
    return await decidePaymentWebhookEvent({ eventId, now });
  } catch (error) {
    console.error(`[payment-webhook] unexpected error deciding event ${eventId}: ${error?.message ?? error}`);
    try {
      const event = await paymentWebhookEvents().where({ id: eventId }).first();
      if (event && event.outcome == null) {
        await deferWebhookEvent({ events: paymentWebhookEvents, id: event.id, attemptCount: event.attempt_count, reason: `unexpected_error: ${error?.message ?? 'unknown'}`, now });
      }
    } catch (deferError) {
      console.error(`[payment-webhook] could not defer event ${eventId}: ${deferError?.message ?? deferError}`);
    }
    return { outcome: null, error: true };
  }
}

/** One `audit_log` row for a webhook decision that deserves a human's attention. Written before the event is finalized, so a crash retries rather than losing it. */
async function recordWebhookAudit({ payment, action, detail }) {
  const context = workerContext({ tenantId: payment.tenant_id, propertyId: payment.property_id });
  await scopedDb()
    .for(context)
    .transaction((trx) =>
      recordAuditEntry(trx, {
        entityType: 'payments',
        entityId: payment.id,
        propertyId: payment.property_id,
        action,
        source: 'integration',
        afterState: detail,
        reason: 'A signed gateway webhook could not be applied as-is; see the event row outcome.',
      })
    );
}

// ---------------------------------------------------------------------
// Refunds — ARCHITECTURE.md §7 ("CAPTURED -> REFUNDED / PARTIALLY_REFUNDED")
// ---------------------------------------------------------------------

/** Refund rows that count against a payment: settled ones, and ones still in flight (their amount is RESERVED until the gateway answers). */
const REFUND_RESERVING_STATUSES = ['INITIATED', 'PENDING', 'CAPTURED'];

/**
 * What has been refunded (or is being refunded) against a payment. A LOCKING read: the caller holds the payment's row
 * lock, and a plain read here would show the transaction's snapshot, which can predate a refund another request has
 * since committed. Counts refunds still in flight (INITIATED / PENDING) as well as settled ones, so an amount Paystack
 * has accepted but not yet processed cannot be refunded a second time.
 */
async function refundedSoFar({ trx, paymentId, statuses = REFUND_RESERVING_STATUSES }) {
  const refunds = await trx.table('payments').where({ parent_payment_id: paymentId }).whereIn('status', statuses).forUpdate();
  return sumMoney(refunds.map((r) => r.amount));
}

/** Locks the payment being refunded and re-checks, under that lock, that it can still be refunded and by how much. */
async function lockRefundablePayment({ trx, paymentId, refundAmount, amountSupplied }) {
  const original = await trx.table('payments').where({ id: paymentId }).forUpdate().first();
  if (!original) throw new ValidationError('PAYMENT_NOT_FOUND', 'The specified payment does not exist.');
  if (original.status !== 'CAPTURED' && original.status !== 'PARTIALLY_REFUNDED') {
    throw new InvalidPaymentTransitionError(original.status, 'REFUNDED');
  }
  const reserved = await refundedSoFar({ trx, paymentId });
  const available = sumMoney([original.amount, negateMoney(reserved)]);
  const amount = amountSupplied ? refundAmount : available;
  if (compareMoney(available, '0.00') <= 0 || compareMoney(amount, available) > 0) {
    throw new RefundExceedsCapturedAmountError(paymentId, amount, available);
  }
  return { original, refundAmount: amount };
}

/** A gateway failure whose outcome we know: Paystack looked at the request and said no (an HTTP 4xx other than a timeout), so no refund exists. */
function gatewayRefusedDefinitively(error) {
  const status = error?.details?.httpStatus;
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;
}

/**
 * The refund request left us but we cannot say whether Paystack acted on it (a timeout, a dropped connection, a 5xx, or
 * a failure writing the result down). The intent stays PENDING, so the amount STAYS reserved, and it is marked for a
 * human to reconcile against Paystack. Releasing it would let the same refund be sent twice.
 */
async function flagRefundOutcomeUnknown({ db, intent, original, userId, error }) {
  const detail = `Outcome unknown, awaiting reconciliation with Paystack: ${error?.message ?? 'no response'}`.slice(0, 500);
  await db.transaction(async (trx) => {
    // Conditional: a sweep or webhook that already settled this intent (CAPTURED / FAILED) must not be walked back.
    const flagged = await trx.table('payments').where({ id: intent.id }).whereIn('status', ['INITIATED', 'PENDING']).update({ status: 'PENDING', failure_reason: detail });
    if (!flagged) return;
    await recordAuditEntry(trx, {
      entityType: 'payments',
      entityId: intent.id,
      propertyId: original.property_id,
      userId,
      action: 'refund_outcome_unknown',
      source: 'api',
      afterState: { originalPaymentId: original.id, amount: intent.amount, currency: original.currency },
      reason: detail,
    });
  });
}

const RESERVING_REFUND_STATUSES = ['INITIATED', 'PENDING'];

/** One `refund_reconciliations` row per refund intent, created on first use. The caller holds the refunded payment's row lock. */
async function ensureRefundReconciliation({ trx, intent, userId = null, reason = null }) {
  const existing = await trx.table('refund_reconciliations').where({ payment_id: intent.id }).forUpdate().first();
  if (existing) return existing;
  const [id] = await trx.table('refund_reconciliations').insert({
    payment_id: intent.id,
    requested_by_user_id: userId,
    reason: reason ? String(reason).slice(0, 500) : null,
  });
  return trx.table('refund_reconciliations').where({ id }).first();
}

/**
 * The effects of a refund that Paystack has PROCESSED, applied exactly once by whichever path first sees it: the
 * refund call itself, the reconciliation sweep, a refund webhook or a manager. The caller holds the original payment's
 * row lock and has just claimed the intent (INITIATED/PENDING -> CAPTURED).
 *
 * A Register / QR card payment has no folio: a FULL refund voids the settlement it funded (and puts its stock back); a
 * partial one leaves the sale standing. Anything else posts a refund line to the folio. A subaccount-split payment
 * records the shortfall the property now owes back.
 */
async function applyProcessedRefundEffects({ trx, intent, original, reason, userId }) {
  const isPosOrderTarget = intent.settlement_target === 'pos_order' || intent.settlement_target === 'pos_register';
  const refundAmount = intent.amount;
  const capturedTotal = await refundedSoFar({ trx, paymentId: original.id, statuses: ['CAPTURED'] });
  const fullyRefunded = compareMoney(capturedTotal, original.amount) === 0;

  if (isPosOrderTarget) {
    // PLAN.md Phase 6 (QR self-ordering gap closure) — no folio exists for a guest order's card payment at all; the
    // real reversal is voiding the `card` settlement itself, but ONLY once the payment has been refunded in full: a
    // partial refund hands part of the money back and leaves the sale standing. Replicated inline (`pos/service.js`'s
    // own `voidSettlement` shape: lock the parent order, re-check `voided_at` under a locking read, then write) rather
    // than imported — see this file's own header comment on why `pos/service.js` is never required from here.
    //
    // This MUST stay in lockstep with `voidSettlement`'s own invariants: (1) an already-voided settlement is a real
    // `409` conflict, never a silent no-op; (2) a `tip_service_charge_line_item_id` is voided alongside the settlement.
    const settlement = await trx.table('pos_order_settlements').where({ payment_id: original.id }).first();
    if (settlement && fullyRefunded) {
      await trx.table('pos_orders').where({ id: settlement.pos_order_id }).forUpdate().first();
      const lockedSettlement = await trx.table('pos_order_settlements').where({ id: settlement.id }).forUpdate().first();
      if (lockedSettlement.voided_at) throw new SettlementAlreadyVoidedError(settlement.id);

      if (lockedSettlement.tip_service_charge_line_item_id) {
        await voidLineItem({ trx, lineItemId: lockedSettlement.tip_service_charge_line_item_id, reason, userId });
      }
      await trx.table('pos_order_settlements').where({ id: settlement.id }).update({
        voided_at: new Date(),
        void_reason: reason,
        voided_by_user_id: userId,
      });
      // The sale is void, so the stock it took goes back — the same reversal `pos/service.js voidSettlement` makes.
      // Only a FULL refund reaches this branch; a partial amount says nothing about which line came back.
      await stockService.reverseStockForSettlement({ trx, settlementId: settlement.id, userId });
      // The sale is void, so a voucher on it gives its use back, in this same transaction. A PARTIAL refund keeps the
      // sale (the branch below) and so keeps the use.
      await voucherStore.restoreForSettlement(trx, { settlementId: settlement.id, userId });
    } else if (settlement) {
      // Flagged, not hidden: money went back but the sale stands, and NO stock is put back — a partial amount says
      // nothing about which line the guest returned.
      await recordAuditEntry(trx, {
        entityType: 'payments',
        entityId: intent.id,
        propertyId: original.property_id,
        userId,
        action: 'refund_partial_settlement_kept',
        source: 'api',
        afterState: { settlementId: String(settlement.id), originalPaymentId: String(original.id), refundAmount, refundedSoFar: capturedTotal, paymentAmount: original.amount, currency: original.currency },
        reason: 'A partial refund does not void the sale it paid for; the settlement and its stock movements are unchanged.',
      });
    }
  } else {
    const folio = await lockFolio({ trx, folioId: original.folio_id });
    const businessDate = await propertyBusinessDate({ trx, propertyId: folio.property_id });
    await trx.table('folio_line_items').insert({
      folio_id: original.folio_id,
      type: 'refund',
      description: `Paystack refund of payment ${original.id}`,
      amount: refundAmount,
      currency: original.currency,
      payment_method: 'paystack',
      payment_id: intent.id,
      business_date: businessDate,
      posted_by_user_id: userId ?? null,
    });
    await recomputeFolioBalance({ trx, folioId: original.folio_id });
  }
  await trx.table('payments').where({ id: original.id }).update({ status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' });

  // Gap closure — confirmed LIVE against the real sandbox before this shipped, not assumed: a Paystack refund debits
  // the FULL original amount from the PLATFORM's own balance immediately, with nothing automatically clawed back from
  // the subaccount's own share, even though that share may already have been paid to the hotel's bank. User-confirmed
  // scope ("record and flag only"): no automatic recovery/netting is built — this is a real, audited fact that the
  // property now owes this amount back to the platform. Every property subaccount is seeded at 0% platform fee today,
  // so 100% of any split charge — and of any refund of it — was the property's own share.
  if (original.subaccount_code) {
    await recordAuditEntry(trx, {
      entityType: 'payments',
      entityId: intent.id,
      propertyId: original.property_id,
      userId,
      action: 'refund_subaccount_shortfall',
      source: 'api',
      afterState: {
        originalPaymentId: original.id,
        subaccountCode: original.subaccount_code,
        amountOwedBackByProperty: refundAmount,
        currency: original.currency,
      },
      reason:
        'Paystack refunds a split payment from the platform\'s own balance only — this amount is not yet automatically recovered from the property.',
    });
  }
}

/**
 * The ONE place a refund intent leaves INITIATED/PENDING. Every path that learns Paystack's answer — the refund call
 * itself, the reconciliation sweep, a refund webhook, the manager "clear" — comes through here, so the same refund can
 * never be applied twice: the original payment is locked first, the intent is re-read under that lock, and a claim on
 * an intent that is no longer in flight changes nothing.
 *
 *   outcome 'processed'  claim CAPTURED and apply the effects (folio line / settlement void + stock / balances)
 *   outcome 'pending'    Paystack has it but has not finished: stays PENDING, remembers the refund id
 *   outcome 'failed'     Paystack failed or reversed it: FAILED, the reserved amount is released and the
 *                        Idempotency-Key is given back
 *
 * Returns `{ applied, intent }`; `applied` is false when another path got there first. Never releases an amount on doubt:
 * a caller with no clear answer does not call this.
 */
async function settleRefundIntent({ trx, intentId, outcome, refundId = null, reason = null, userId = null, failureReason = null }) {
  const peek = await trx.table('payments').where({ id: intentId }).first();
  if (!peek) return { applied: false, intent: null };
  const original = await trx.table('payments').where({ id: peek.parent_payment_id }).forUpdate().first();
  const intent = await trx.table('payments').where({ id: intentId }).forUpdate().first();
  if (!original || !RESERVING_REFUND_STATUSES.includes(intent.status)) return { applied: false, intent };

  if (outcome === 'failed') {
    await trx.table('payments').where({ id: intent.id }).update({
      status: 'FAILED',
      failed_at: new Date(),
      failure_reason: String(failureReason ?? 'Paystack reported the refund failed.').slice(0, 500),
      provider_payment_id: refundId ?? intent.provider_payment_id ?? null,
      idempotency_key: `${String(intent.idempotency_key).slice(0, 150)}~failed-${intent.id}`,
    });
  } else if (outcome === 'processed') {
    await trx.table('payments').where({ id: intent.id }).update({
      status: 'CAPTURED',
      captured_at: new Date(),
      provider_payment_id: refundId ?? intent.provider_payment_id ?? null,
      failure_reason: null,
    });
    await applyProcessedRefundEffects({ trx, intent, original, reason: reason ?? 'Refund confirmed by Paystack', userId });
  } else {
    await trx.table('payments').where({ id: intent.id }).update({ status: 'PENDING', provider_payment_id: refundId ?? intent.provider_payment_id ?? null });
  }
  return { applied: true, intent: await trx.table('payments').where({ id: intent.id }).first() };
}

/**
 * `amount` omitted means a full refund of whatever remains. Every path takes the PAYMENT'S ROW LOCK first and works
 * out what is left to refund under it (F-04), so two requests — with different idempotency keys, from a double click
 * or two cashiers — cannot both refund the same money. Lock order, module-wide: payment, then (AR account and) folios
 * in ascending id.
 *
 * Cash and a physical card terminal reverse locally in ONE transaction. Paystack: (1) one short transaction locks the
 * payment, re-checks, and writes the refund as an INITIATED intent, which RESERVES its amount; (2) Paystack is asked,
 * outside any transaction (§6.4); (3) a second short transaction records the answer. A definite refusal marks the
 * intent FAILED and releases the amount. An answer we never got keeps it reserved and flags it for reconciliation.
 * `reason` is mandatory.
 */
async function refundPayment({ context, paymentId, amount, reason, idempotencyKey, userId, approve = null }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required for a refund.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);

  // A first, unlocked look only to route the request; everything that matters is re-read under the lock below.
  const peeked = await db.table('payments').where({ id: paymentId }).first();
  if (!peeked) throw new ValidationError('PAYMENT_NOT_FOUND', 'The specified payment does not exist.');
  // A supermarket online sale is refunded by voiding the sale (it also returns
  // the stock and marks the sale void), never through this generic refund.
  if (peeked.settlement_target === 'supermarket_sale') {
    throw new ValidationError('USE_SUPERMARKET_VOID', 'Refund a supermarket online sale by voiding the sale on the Supermarket screen.', [{ field: 'payment_id', issue: 'supermarket_sale' }]);
  }
  if (peeked.status !== 'CAPTURED' && peeked.status !== 'PARTIALLY_REFUNDED') {
    throw new InvalidPaymentTransitionError(peeked.status, 'REFUNDED');
  }
  // A supplied refund amount gets the same validation as a payment (positive, 2 decimals); omitted means the full remainder.
  const amountSupplied = !(amount === undefined || amount === null || amount === '');
  const suppliedAmount = amountSupplied ? assertPaymentAmount(amount) : null;

  const reference = generateUlid();
  // `approve(trx, payment)` — a manager's approval (`src/modules/approvals`), passed by the refund route, which
  // claims one for a POS payment only (a folio refund is a no-op there); the QR order rejection passes none.
  // Called after every check, inside the refund's own transaction (cash/terminal) or the intent's transaction (Paystack).

  // Cash and a physical-terminal card payment both reverse LOCALLY, with no gateway: the money goes back through
  // the till or the terminal itself, which is the staff's to do. Anything else is a Paystack payment.
  if (peeked.provider === 'cash' || peeked.provider === 'terminal') {
    const isTerminal = peeked.provider === 'terminal';
    return db.transaction(async (trx) => {
      const { original, refundAmount } = await lockRefundablePayment({ trx, paymentId, refundAmount: suppliedAmount, amountSupplied });
      const alreadyRefunded = await refundedSoFar({ trx, paymentId, statuses: ['CAPTURED'] });
      const folio = await lockFolio({ trx, folioId: original.folio_id });
      if (approve) await approve(trx, original);
      const [refundPaymentId] = await trx.table('payments').insert({
        folio_id: original.folio_id,
        idempotency_key: idempotencyKey,
        provider: original.provider,
        provider_reference: reference,
        amount: refundAmount,
        currency: original.currency,
        status: 'CAPTURED',
        captured_at: new Date(),
        parent_payment_id: original.id,
      });
      const businessDate = await propertyBusinessDate({ trx, propertyId: folio.property_id });
      await trx.table('folio_line_items').insert({
        folio_id: original.folio_id,
        type: 'refund',
        description: `${isTerminal ? 'Card (terminal) refund' : 'Cash refund'} of payment ${original.id}`,
        amount: refundAmount,
        currency: original.currency,
        payment_method: original.provider,
        payment_id: refundPaymentId,
        business_date: businessDate,
        posted_by_user_id: userId ?? null,
      });
      if (isTerminal) {
        // The refund carries the same terminal details as the payment, so its reconciliation line is complete.
        const details = await trx.table('payment_terminal_details').where({ payment_id: original.id }).first();
        if (details) {
          await trx.table('payment_terminal_details').insert({
            payment_id: refundPaymentId,
            terminal_provider: details.terminal_provider,
            terminal_reference: details.terminal_reference,
            terminal_account_label: details.terminal_account_label,
            terminal_account_last4: details.terminal_account_last4,
          });
        }
      }
      await recomputeFolioBalance({ trx, folioId: original.folio_id });
      const fullyRefunded = compareMoney(sumMoney([alreadyRefunded, refundAmount]), original.amount) === 0;
      await trx.table('payments').where({ id: original.id }).update({ status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' });
      return trx.table('payments').where({ id: refundPaymentId }).first();
    });
  }

  // Paystack. The adapter is resolved first: a missing gateway fails before anything is reserved.
  const { adapter } = await paystack.resolveAdapterForCurrency(db, peeked.currency);
  // A Register payment reverses the same way a guest QR order's does: the settlement it funded is voided (once the
  // payment is refunded in full). Neither has a folio to post a refund line to.
  const isPosOrderTarget = peeked.settlement_target === 'pos_order' || peeked.settlement_target === 'pos_register';

  // (1) Reserve: lock the payment, re-check, write the INITIATED intent.
  const { intent, original, refundAmount } = await db.transaction(async (trx) => {
    const locked = await lockRefundablePayment({ trx, paymentId, refundAmount: suppliedAmount, amountSupplied });
    if (approve) await approve(trx, locked.original);
    const [intentId] = await trx.table('payments').insert({
      folio_id: isPosOrderTarget ? null : locked.original.folio_id,
      pos_order_id: isPosOrderTarget ? locked.original.pos_order_id : null,
      settlement_target: isPosOrderTarget ? locked.original.settlement_target : 'folio',
      idempotency_key: idempotencyKey,
      provider: 'paystack',
      provider_reference: reference,
      amount: locked.refundAmount,
      currency: locked.original.currency,
      status: 'INITIATED',
      parent_payment_id: locked.original.id,
    });
    const created = await trx.table('payments').where({ id: intentId }).first();
    // Who asked and why, kept for whichever path later learns Paystack's answer (the sweep, a webhook, a manager).
    await ensureRefundReconciliation({ trx, intent: created, userId, reason });
    return { intent: created, original: locked.original, refundAmount: locked.refundAmount };
  });

  // (2) Ask Paystack, outside any transaction. The call is bounded; a timeout is "outcome unknown", never a refusal.
  let gatewayResult;
  try {
    gatewayResult = await adapter.refundTransaction({ reference: original.provider_reference, amount: amountSupplied ? refundAmount : undefined });
  } catch (error) {
    if (gatewayRefusedDefinitively(error)) {
      // The failed intent gives its idempotency key back, so the cashier can retry the same action under the same key.
      // Conditional: if a sweep or webhook already settled the intent it is left alone.
      await db.table('payments').where({ id: intent.id }).whereIn('status', RESERVING_REFUND_STATUSES).update({
        status: 'FAILED',
        failed_at: new Date(),
        failure_reason: `Paystack refused the refund: ${error.message}`.slice(0, 500),
        idempotency_key: `${String(idempotencyKey).slice(0, 150)}~failed-${intent.id}`,
      });
    } else {
      await flagRefundOutcomeUnknown({ db, intent, original, userId, error });
    }
    throw error;
  }
  const processed = gatewayResult.status === 'processed' || gatewayResult.status === 'success';

  // (3) Record the answer. A failure here leaves the refund sent but unrecorded, so it is flagged, never released.
  try {
    return await db.transaction(async (trx) => {
      const settled = await settleRefundIntent({ trx, intentId: intent.id, outcome: processed ? 'processed' : 'pending', refundId: gatewayResult.refundId ?? null, reason, userId });
      return settled.intent;
    });
  } catch (error) {
    await flagRefundOutcomeUnknown({ db, intent, original, userId, error }).catch((flagError) => {
      console.error(`[refund] could not flag refund ${intent.id} for reconciliation: ${flagError?.message ?? flagError}`);
    });
    throw error;
  }
}

/**
 * Non-room, non-POS income posted to folios, for the P&L's "Other income"
 * lines: the non-voided `adjustment` lines whose `business_date` is in range
 * (checkout fees, staff adjustments and discounts). Signed, so a fee adds
 * and a discount subtracts. Adjustments carry no tax, so the amount is the
 * whole income.
 *
 * Deliberately NOT counted (each is already counted elsewhere or is not
 * income): `room_charge` (room revenue), `pos_charge` (counted once as a POS
 * settlement), `tax`, `payment`/`refund`, voided lines, and any adjustment
 * linked to a `pos_charge` line (the POS tip/service charge, which POS
 * revenue also leaves out). Lines in a currency other than `baseCurrency`
 * are not summed into the single-currency statement; they are counted in
 * `otherCurrencyLineCount` so the report can say so.
 */
async function listOtherFolioIncome({ db, dateFrom, dateTo, baseCurrency }) {
  const adjustments = await db
    .table('folio_line_items')
    .where({ type: 'adjustment' })
    .whereNull('voided_at')
    .whereBetween('business_date', [dateFrom, dateTo])
    .select('id', 'amount', 'currency', 'related_line_item_id');

  const relatedIds = [...new Set(adjustments.map((row) => row.related_line_item_id).filter((id) => id != null))];
  const related = relatedIds.length ? await db.table('folio_line_items').whereIn('id', relatedIds).select('id', 'type') : [];
  const relatedTypeById = new Map(related.map((row) => [String(row.id), row.type]));

  const fees = [];
  const discounts = [];
  let otherCurrencyLineCount = 0;
  for (const row of adjustments) {
    if (row.related_line_item_id != null && relatedTypeById.get(String(row.related_line_item_id)) === 'pos_charge') continue;
    if (baseCurrency && row.currency !== baseCurrency) {
      otherCurrencyLineCount += 1;
      continue;
    }
    if (compareMoney(row.amount, '0.00') >= 0) fees.push(row.amount);
    else discounts.push(row.amount);
  }
  const feesTotal = sumMoney(fees);
  const discountsTotal = sumMoney(discounts);
  return { fees: feesTotal, discounts: discountsTotal, total: sumMoney([feesTotal, discountsTotal]), otherCurrencyLineCount };
}

/**
 * Room charges actually posted to folios, per business date, for the given
 * dates only — the "actual" the P&L compares a still-unaudited day's
 * booked-rate estimate against. Non-voided `room_charge` lines in
 * `baseCurrency`. `Late room charge` lines (an Extend Stay posting nights
 * whose audit already ran) are left out: they are dated on the day they were
 * posted but belong to an earlier night, whose revenue is already counted at
 * that night through its booked rate, so including them would manufacture a
 * variance on the day they happened to be posted.
 */
async function sumPostedRoomChargesByDate({ db, dates, baseCurrency }) {
  const wanted = new Set(dates);
  if (wanted.size === 0) return new Map();
  const sorted = [...wanted].sort();
  const lines = await db
    .table('folio_line_items')
    .where({ type: 'room_charge' })
    .whereNull('voided_at')
    .whereBetween('business_date', [sorted[0], sorted[sorted.length - 1]])
    .select('amount', 'currency', 'description', 'business_date');

  const amountsByDate = new Map();
  for (const line of lines) {
    const date = String(line.business_date);
    if (!wanted.has(date)) continue;
    if (baseCurrency && line.currency !== baseCurrency) continue;
    if (String(line.description ?? '').startsWith(LATE_ROOM_CHARGE_PREFIX)) continue;
    if (!amountsByDate.has(date)) amountsByDate.set(date, []);
    amountsByDate.get(date).push(line.amount);
  }
  return new Map([...amountsByDate.entries()].map(([date, amounts]) => [date, sumMoney(amounts)]));
}


// ---------------------------------------------------------------------
// Refund reconciliation — a refund Paystack accepted but we never saw finish, or one whose outcome we never learned
// ---------------------------------------------------------------------

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Read per call so a test (or an operator) can change them without a restart. */
function refundReconcileConfig() {
  return {
    /** A refund intent is first checked once it is this old, and re-checked this often. */
    minAgeMinutes: positiveIntEnv('REFUND_RECONCILE_MIN_AGE_MINUTES', 5),
    /** A manager may clear a stuck refund only after this many checks AND once the refund is this old. */
    clearMinChecks: positiveIntEnv('REFUND_CLEAR_MIN_CHECKS', 3),
    clearMinMinutes: positiveIntEnv('REFUND_CLEAR_MIN_MINUTES', 30),
  };
}

/** What Paystack's refund status means for us. `null`: not a status we recognise, so no decision may be taken on it. */
function classifyRefundStatus(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'processed' || value === 'success') return 'processed';
  if (value === 'failed' || value === 'reversed') return 'failed';
  if (value === 'pending' || value === 'processing' || value === 'needs-attention') return 'pending';
  return null;
}

/** A Paystack refund intent still in flight that the generic reconciliation owns (a supermarket void has its own sweep). */
function isReconcilableRefund(intent) {
  return Boolean(
    intent &&
      intent.parent_payment_id &&
      intent.provider === 'paystack' &&
      RESERVING_REFUND_STATUSES.includes(intent.status) &&
      intent.settlement_target !== 'supermarket_sale'
  );
}

/**
 * Asks Paystack what really happened to one refund intent. Read-only, no transaction open. Returns
 * `{ result, refundId?, detail }` where `result` is `processed | failed | pending` (a clear answer) or `unreachable |
 * ambiguous | not_found` (NO answer: the caller must not release anything on these).
 *
 * An intent that has a refund id is looked up by it. One that never got an id (the refund call timed out or dropped) is
 * found among the refunds Paystack holds for the original transaction: the match must be unique (same amount, created
 * after the intent, not already claimed by another local refund), otherwise it is "ambiguous" or "not_found".
 */
async function lookUpRefundAtPaystack({ db, intent, original }) {
  let adapter;
  try {
    ({ adapter } = await paystack.resolveAdapterForCurrency(db, intent.currency));
  } catch (error) {
    return { result: 'unreachable', detail: `Paystack is not available: ${error?.message ?? error}`.slice(0, 500) };
  }
  try {
    if (intent.provider_payment_id) {
      const found = await adapter.fetchRefund({ refundId: intent.provider_payment_id });
      const kind = classifyRefundStatus(found.status);
      if (!kind) return { result: 'ambiguous', detail: `Paystack reported a refund status we do not recognise: "${found.status}".` };
      return { result: kind, refundId: found.refundId, detail: `Paystack refund status: ${found.status}.` };
    }
    if (!original.provider_payment_id) {
      return { result: 'not_found', detail: 'The original payment has no Paystack transaction id on record, so its refunds cannot be listed.' };
    }
    const refunds = await adapter.listRefundsForTransaction({ transactionId: original.provider_payment_id });
    const wanted = paystack.toSubunit(intent.amount);
    const claimedRows = await db.table('payments').where({ parent_payment_id: original.id }).whereNotNull('provider_payment_id').select('id', 'provider_payment_id');
    const claimed = new Set(claimedRows.filter((row) => String(row.id) !== String(intent.id)).map((row) => String(row.provider_payment_id)));
    const startedMs = new Date(intent.created_at).getTime();
    const candidates = refunds.filter((row) => {
      if (row.amountSubunit !== wanted || claimed.has(String(row.refundId))) return false;
      const createdMs = row.createdAt ? Date.parse(row.createdAt) : NaN;
      return Number.isNaN(createdMs) || createdMs >= startedMs - 120_000;
    });
    if (candidates.length === 0) return { result: 'not_found', detail: 'Paystack lists no refund of this amount for the original transaction.' };
    const rivals = await db
      .table('payments')
      .where({ parent_payment_id: original.id, provider: 'paystack', amount: intent.amount })
      .whereIn('status', RESERVING_REFUND_STATUSES)
      .whereNull('provider_payment_id')
      .select('id');
    const otherRivals = rivals.filter((row) => String(row.id) !== String(intent.id));
    if (candidates.length !== 1 || otherRivals.length > 0) {
      return { result: 'ambiguous', detail: `Paystack lists ${candidates.length} possible refund(s) of this amount and ${otherRivals.length + 1} local refund(s) are waiting; they cannot be told apart.` };
    }
    const pick = candidates[0];
    const kind = classifyRefundStatus(pick.status);
    if (!kind) return { result: 'ambiguous', detail: `Paystack reported a refund status we do not recognise: "${pick.status}".` };
    return { result: kind, refundId: pick.refundId, detail: `Matched Paystack refund ${pick.refundId} (${pick.status}).` };
  } catch (error) {
    return { result: 'unreachable', detail: `Paystack could not be asked: ${error?.message ?? error}`.slice(0, 500) };
  }
}

/** Whether a manager may clear this refund: only once reconciliation has checked Paystack enough times and still cannot confirm. */
function refundClearEligibility({ intent, reconciliation, now = new Date() }) {
  const config = refundReconcileConfig();
  if (!isReconcilableRefund(intent)) return { eligible: false, reason: 'not_in_flight' };
  const attempts = Number(reconciliation?.attempts ?? 0);
  if (attempts < config.clearMinChecks) return { eligible: false, reason: 'not_enough_checks', attempts, needed: config.clearMinChecks };
  const ageMinutes = (now.getTime() - new Date(intent.created_at).getTime()) / 60_000;
  if (ageMinutes < config.clearMinMinutes) return { eligible: false, reason: 'too_recent', needed: config.clearMinMinutes };
  if (!['unreachable', 'ambiguous', 'not_found'].includes(reconciliation?.last_result)) {
    return { eligible: false, reason: 'paystack_reports_pending' };
  }
  return { eligible: true, reason: null };
}

/**
 * Checks one refund intent against Paystack and settles it if Paystack gives a clear answer. Safe to call from the
 * sweep, a webhook and a manager at once: Paystack is asked outside any transaction, and the answer is applied through
 * `settleRefundIntent`, which claims the intent under the original payment's row lock, so a refund is applied once.
 *
 *   processed  -> CAPTURED, with exactly the effects the normal path applies
 *   failed     -> FAILED, the reserved amount is released and a manager is told (the guest has not been repaid)
 *   pending    -> left alone, to be checked again
 *   no answer  -> left alone, nothing released; the check is recorded so a manager can clear it after enough of them
 */
async function reconcileRefundIntent({ context, intentId, source = 'sweep', now = new Date() }) {
  const db = scopedDb().for(context);
  const intent = await db.table('payments').where({ id: intentId }).first();
  if (!isReconcilableRefund(intent)) return { skipped: true, status: intent?.status ?? null };
  const original = await db.table('payments').where({ id: intent.parent_payment_id }).first();

  const found = await lookUpRefundAtPaystack({ db, intent, original });
  const auditSource = source === 'webhook' ? 'integration' : source === 'manager' ? 'api' : 'job';

  return db.transaction(async (trx) => {
    await trx.table('payments').where({ id: original.id }).forUpdate().first(); // lock order: the refunded payment first
    const reconciliation = await ensureRefundReconciliation({ trx, intent });
    let settled = { applied: false };
    if (found.result === 'processed' || found.result === 'failed' || found.result === 'pending') {
      settled = await settleRefundIntent({
        trx,
        intentId: intent.id,
        outcome: found.result,
        refundId: found.refundId ?? null,
        reason: reconciliation.reason ?? 'Refund confirmed by Paystack (reconciliation)',
        userId: reconciliation.requested_by_user_id ?? null,
        failureReason: `Paystack reported the refund failed; the guest has not been repaid. ${found.detail ?? ''}`.trim(),
      });
      // Another path (the refund call itself, a webhook, a manager) settled it first: nothing left to do or record.
      if (!settled.applied) return { skipped: true, status: settled.intent?.status ?? null, result: found.result };
    }

    const attempts = Number(reconciliation.attempts) + 1;
    await trx.table('refund_reconciliations').where({ id: reconciliation.id }).update({
      attempts,
      first_checked_at: reconciliation.first_checked_at ?? now,
      last_checked_at: now,
      last_result: found.result,
      last_detail: String(found.detail ?? '').slice(0, 500),
      updated_at: now,
    });

    const resolved = found.result === 'processed' || found.result === 'failed';
    if (resolved) {
      await recordAuditEntry(trx, {
        entityType: 'payments',
        entityId: intent.id,
        propertyId: original.property_id,
        action: found.result === 'processed' ? 'refund_reconciled' : 'refund_reconciled_failed',
        source: auditSource,
        afterState: { originalPaymentId: original.id, amount: intent.amount, currency: intent.currency, refundId: found.refundId ?? null, attempts, via: source },
        reason: found.detail ?? null,
      });
    }
    if (found.result === 'failed') {
      await notifyStaff({
        trx,
        eventType: 'payments.refund_needs_attention',
        payload: { paymentId: original.id, refundPaymentId: intent.id, amount: intent.amount, currency: intent.currency, kind: 'failed' },
        dedupKey: `refund-attention:${intent.id}:failed`,
      });
    }
    if (!resolved && found.result !== 'pending') {
      const eligibility = refundClearEligibility({ intent, reconciliation: { attempts, last_result: found.result }, now });
      if (eligibility.eligible) {
        await notifyStaff({
          trx,
          eventType: 'payments.refund_needs_attention',
          payload: { paymentId: original.id, refundPaymentId: intent.id, amount: intent.amount, currency: intent.currency, kind: 'stuck' },
          dedupKey: `refund-attention:${intent.id}:stuck`,
        });
      }
    }
    return { skipped: false, result: found.result, detail: found.detail, applied: resolved, attempts };
  });
}

/**
 * Manager "Clear stuck refund": gives up on a refund reconciliation cannot confirm, releasing its reserved amount so the
 * money can be refunded another way. Allowed ONLY after reconciliation has checked Paystack enough times and could not
 * confirm; and it asks Paystack one last time first — a refund that turns out to be processed is applied, not cleared,
 * and one Paystack still reports as pending is refused, so clearing can never cause a double refund.
 */
async function clearStuckRefund({ context, paymentId, reason, userId, approve = null, now = new Date() }) {
  const cleanReason = String(reason ?? '').trim();
  if (!cleanReason) throw new ValidationError('MISSING_FIELD', '"reason" is required to clear a stuck refund.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);
  const peek = await db.table('payments').where({ id: paymentId }).first();
  if (!peek || !peek.parent_payment_id || peek.provider !== 'paystack') throw new ValidationError('PAYMENT_NOT_FOUND', 'The specified refund does not exist.');
  if (!isReconcilableRefund(peek)) throw new RefundNotStuckError(peek.status, 'This refund is not waiting on Paystack.');

  // Eligibility is judged on the checks made BEFORE this request: the sweep must already have failed to confirm it.
  const before = await db.table('refund_reconciliations').where({ payment_id: paymentId }).first();
  const eligibility = refundClearEligibility({ intent: peek, reconciliation: before, now });
  if (!eligibility.eligible) throw new RefundNotStuckError(peek.status, `Reconciliation has not yet finished checking this refund (${eligibility.reason}).`, eligibility);

  // One last look at Paystack, outside any transaction.
  const checked = await reconcileRefundIntent({ context, intentId: paymentId, source: 'manager', now });
  if (!checked.skipped && (checked.result === 'processed' || checked.result === 'failed')) {
    return { cleared: false, resolved: checked.result, intent: await db.table('payments').where({ id: paymentId }).first() };
  }
  if (!checked.skipped && checked.result === 'pending') {
    throw new RefundNotStuckError(peek.status, 'Paystack reports this refund is still being processed, so it cannot be cleared.', { reason: 'paystack_reports_pending' });
  }

  return db.transaction(async (trx) => {
    const original = await trx.table('payments').where({ id: peek.parent_payment_id }).forUpdate().first();
    const intent = await trx.table('payments').where({ id: paymentId }).forUpdate().first();
    if (!isReconcilableRefund(intent)) return { cleared: false, resolved: intent.status.toLowerCase(), intent };
    const reconciliation = await ensureRefundReconciliation({ trx, intent });
    if (!refundClearEligibility({ intent, reconciliation, now }).eligible) {
      throw new RefundNotStuckError(intent.status, 'Reconciliation has not yet finished checking this refund.');
    }
    if (approve) await approve(trx, original);
    await trx.table('payments').where({ id: intent.id }).update({
      status: 'FAILED',
      failed_at: now,
      failure_reason: `Cleared by a manager after reconciliation could not confirm it: ${cleanReason}`.slice(0, 500),
      idempotency_key: `${String(intent.idempotency_key).slice(0, 150)}~failed-${intent.id}`,
    });
    await trx.table('refund_reconciliations').where({ id: reconciliation.id }).update({ last_result: 'cleared', last_detail: cleanReason.slice(0, 500), updated_at: now });
    await recordAuditEntry(trx, {
      entityType: 'payments',
      entityId: intent.id,
      propertyId: original.property_id,
      userId,
      action: 'refund_stuck_cleared',
      source: 'api',
      beforeState: { status: intent.status, attempts: reconciliation.attempts, lastResult: reconciliation.last_result, lastDetail: reconciliation.last_detail },
      afterState: { originalPaymentId: original.id, amount: intent.amount, currency: intent.currency, status: 'FAILED' },
      reason: cleanReason,
    });
    return { cleared: true, intent: await trx.table('payments').where({ id: intent.id }).first() };
  });
}

/** Adds what the screens need to show a stuck refund on a payment row: only rows that are in-flight Paystack refunds gain a field. */
async function annotateStuckRefunds({ db, payments, now = new Date() }) {
  const inFlight = payments.filter(isReconcilableRefund);
  if (inFlight.length === 0) return payments;
  const rows = await db.table('refund_reconciliations').whereIn('payment_id', inFlight.map((row) => row.id));
  const byPayment = new Map(rows.map((row) => [String(row.payment_id), row]));
  return payments.map((payment) => {
    if (!isReconcilableRefund(payment)) return payment;
    const reconciliation = byPayment.get(String(payment.id)) ?? null;
    const eligibility = refundClearEligibility({ intent: payment, reconciliation, now });
    return {
      ...payment,
      refundReconciliation: {
        attempts: Number(reconciliation?.attempts ?? 0),
        lastCheckedAt: reconciliation?.last_checked_at ?? null,
        lastResult: reconciliation?.last_result ?? null,
        lastDetail: reconciliation?.last_detail ?? null,
        canClear: eligibility.eligible,
        clearBlockedBy: eligibility.eligible ? null : eligibility.reason,
      },
    };
  });
}

/** `refund.*` webhook events are a hint: the real status is re-read from Paystack through the same reconciliation. */
const REFUND_WEBHOOK_EVENTS = new Set(['refund.pending', 'refund.processing', 'refund.processed', 'refund.failed']);

async function decideRefundWebhookEvent({ event, payload, finalize }) {
  const data = payload?.data ?? {};
  const refundId = data.id != null ? String(data.id) : null;
  const transactionReference = data.transaction_reference ?? data.transaction?.reference ?? null;
  let candidates = [];
  if (refundId) {
    candidates = await knex()('payments').where({ provider: 'paystack', provider_payment_id: refundId }).whereNotNull('parent_payment_id').whereIn('status', RESERVING_REFUND_STATUSES);
  }
  if (candidates.length === 0 && transactionReference) {
    const original = await knex()('payments').where({ provider: 'paystack', provider_reference: transactionReference }).first();
    if (original) candidates = await knex()('payments').where({ parent_payment_id: original.id, provider: 'paystack' }).whereIn('status', RESERVING_REFUND_STATUSES);
  }
  candidates = candidates.filter(isReconcilableRefund);
  if (candidates.length === 0) return finalize('ignored', { reason: 'no_refund_in_flight', event: event.event ?? null });

  const attribution = { tenant_id: candidates[0].tenant_id, property_id: candidates[0].property_id, related_payment_id: candidates[0].id };
  let resolved = 0;
  for (const intent of candidates) {
    const owner = await knex()('tenants').where({ id: intent.tenant_id }).first('status');
    if (!owner || ['purging', 'purged'].includes(owner.status)) continue;
    const outcome = await reconcileRefundIntent({ context: workerContext({ tenantId: intent.tenant_id, propertyId: intent.property_id }), intentId: intent.id, source: 'webhook' });
    if (outcome.applied) resolved += 1;
  }
  // Only a refund Paystack's own record says is finished counts as applied; anything else is left to the sweep.
  return finalize(resolved > 0 ? 'applied' : 'ignored', { reason: resolved > 0 ? 'refund_reconciled' : 'refund_not_final', event: payload?.event ?? null }, attribution);
}

module.exports = {
  settleRefundIntent,
  reconcileRefundIntent,
  clearStuckRefund,
  refundClearEligibility,
  annotateStuckRefunds,
  isReconcilableRefund,
  refundReconcileConfig,
  RefundNotStuckError,
  lockFolio,
  lockFoliosForMutation,
  resolveClientBusinessDate,
  captureTerminalPayment,
  setSupermarketCaptureFinalizer,
  resolvePayoutSubaccount,
  TERMINAL_PAYMENT_STATUSES,
  LATE_ROOM_CHARGE_PREFIX,
  sumPostedRoomChargesByDate,
  listOtherFolioIncome,
  postLateRoomCharges,
  recomputeFolioBalance,
  getFolio,
  listFoliosForReservation,
  listLineItems,
  listPaymentsForFolio,
  getPayment,
  ensurePrimaryFolio,
  openAdditionalFolio,
  moveLineItem,
  billFolioToCompany,
  postCharge,
  postRoomChargesForStay,
  postAdjustment,
  voidLineItem,
  captureCashPayment,
  initiatePaystackPaymentIntent,
  initiatePosOrderPaystackPaymentIntent,
  initiatePosRegisterPaymentIntent,
  startPaystackCheckout,
  applyGatewayResult,
  finalizePosOrderCardCapture,
  verifyPayment,
  handlePaystackWebhook,
  processPaymentWebhookEvent,
  refundPayment,
};
