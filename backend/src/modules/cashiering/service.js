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
const { sumMoney, negateMoney, compareMoney } = require('../../shared/money');
const { resolveApplicableTaxVersions, computeChargeWithTax } = require('./tax-engine');
const paystack = require('./paystack-adapter');
const {
  FolioClosedError,
  LineItemAlreadyVoidedError,
  InvalidPaymentTransitionError,
  RefundExceedsCapturedAmountError,
  CrossReservationFolioMoveError,
  LineItemNotFoundError,
} = require('./errors');

const CHARGE_TYPES = new Set(['room_charge', 'pos_charge']);

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

async function recomputeFolioBalance({ trx, folioId }) {
  const lines = await trx.table('folio_line_items').where({ folio_id: folioId }).whereNull('voided_at');
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
  return db.table('payments').where({ folio_id: folioId }).orderBy('id');
}

async function getPayment({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('payments').where({ id }).first();
}

async function propertyBusinessDate({ trx, propertyId }) {
  const property = await trx.table('properties').where({ id: propertyId }).first();
  return property?.current_business_date ?? null;
}

// ---------------------------------------------------------------------
// Folios — split billing (PRODUCT_REQUIREMENTS.md §3.5)
// ---------------------------------------------------------------------

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
  const line = await trx.table('folio_line_items').where({ id: lineItemId }).first();
  if (!line) throw new LineItemNotFoundError();
  if (line.voided_at) throw new LineItemAlreadyVoidedError(lineItemId);

  const [sourceFolio, destinationFolio] = await Promise.all([
    trx.table('folios').where({ id: line.folio_id }).first(),
    trx.table('folios').where({ id: destinationFolioId }).first(),
  ]);
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
 */
async function postCharge({ trx, folioId, type, description, amount, businessDate, userId }) {
  if (!CHARGE_TYPES.has(type)) {
    throw new ValidationError('INVALID_CHARGE_TYPE', `"${type}" is not a postable charge type — use "room_charge" or "pos_charge".`);
  }
  const folio = await trx.table('folios').where({ id: folioId }).first();
  if (!folio) throw new ValidationError('FOLIO_NOT_FOUND', 'The specified folio does not exist.');
  if (folio.status !== 'open') throw new FolioClosedError(folioId);

  const effectiveBusinessDate = businessDate ?? (await propertyBusinessDate({ trx, propertyId: folio.property_id }));

  const allTaxRows = await trx.table('taxes');
  const taxVersions = resolveApplicableTaxVersions({ allTaxRows, businessDate: effectiveBusinessDate, chargeType: type });
  const { netAmount, taxLines } = computeChargeWithTax({ baseAmount: amount, taxVersions });
  const totalTax = sumMoney(taxLines.map((t) => t.amount));

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
  const chargeLine = await trx.table('folio_line_items').where({ id: chargeLineId }).first();
  const postedTaxLines = await trx.table('folio_line_items').where({ related_line_item_id: chargeLineId, type: 'tax' });
  return { chargeLine, taxLines: postedTaxLines };
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
 */
async function postAdjustment({ trx, folioId, description, amount, relatedLineItemId, businessDate, userId, reason }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required for a folio adjustment.', [{ field: 'reason', issue: 'missing' }]);
  const folio = await trx.table('folios').where({ id: folioId }).first();
  if (!folio) throw new ValidationError('FOLIO_NOT_FOUND', 'The specified folio does not exist.');
  if (folio.status !== 'open') throw new FolioClosedError(folioId);

  const effectiveBusinessDate = businessDate ?? (await propertyBusinessDate({ trx, propertyId: folio.property_id }));

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
 */
async function voidLineItem({ trx, lineItemId, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void a folio line.', [{ field: 'reason', issue: 'missing' }]);
  const line = await trx.table('folio_line_items').where({ id: lineItemId }).first();
  if (!line) throw new LineItemNotFoundError();
  if (line.voided_at) throw new LineItemAlreadyVoidedError(lineItemId);
  if (line.type === 'payment' || line.type === 'refund') {
    throw new ValidationError('CANNOT_VOID_PAYMENT_LINE', 'A payment or refund line cannot be voided directly — use the refund action instead.');
  }

  const now = new Date();
  await trx.table('folio_line_items').where({ id: lineItemId }).update({ voided_at: now, voided_by_user_id: userId, void_reason: reason });

  const dependentTaxLines = await trx.table('folio_line_items').where({ related_line_item_id: lineItemId, type: 'tax' }).whereNull('voided_at');
  for (const taxLine of dependentTaxLines) {
    await trx.table('folio_line_items').where({ id: taxLine.id }).update({ voided_at: now, voided_by_user_id: userId, void_reason: `Charge ${lineItemId} voided: ${reason}` });
  }

  await recomputeFolioBalance({ trx, folioId: line.folio_id });
  return trx.table('folio_line_items').where({ id: lineItemId }).first();
}

// ---------------------------------------------------------------------
// Payments — cash (real, synchronous) — ARCHITECTURE.md §7
// ---------------------------------------------------------------------

async function assertFolioOpenForPayment({ trx, folioId }) {
  const folio = await trx.table('folios').where({ id: folioId }).first();
  if (!folio) throw new ValidationError('FOLIO_NOT_FOUND', 'The specified folio does not exist.');
  if (folio.status !== 'open') throw new FolioClosedError(folioId);
  return folio;
}

/** No external gateway involved — cash is already physically collected by the time this is called, so capture is real and immediate, not a stub. */
async function captureCashPayment({ trx, folioId, amount, currency, idempotencyKey, userId, businessDate }) {
  const folio = await assertFolioOpenForPayment({ trx, folioId });
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

// ---------------------------------------------------------------------
// Payments — Paystack (real sandbox integration) — ARCHITECTURE.md §7
// ---------------------------------------------------------------------

/** Phase 1 of 2 — the local intent row only, fully transactional. See file header for why the external call is NOT in here. */
async function initiatePaystackPaymentIntent({ trx, folioId, amount, currency, idempotencyKey }) {
  await assertFolioOpenForPayment({ trx, folioId });
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
 * Phase 2 of 2 — the real external call, deliberately OUTSIDE any
 * transaction (ARCHITECTURE.md §6.4). Idempotent by construction: a payment
 * not still `INITIATED` (already progressed by a prior successful call, a
 * webhook, or a manual verify) is a no-op, so retrying this after a prior
 * partial failure is always safe.
 */
async function startPaystackCheckout({ context, paymentId, guestEmail, callbackUrl }) {
  const db = scopedDb().for(context);
  const payment = await db.table('payments').where({ id: paymentId }).first();
  if (!payment) throw new ValidationError('PAYMENT_NOT_FOUND', 'The specified payment does not exist.');
  if (payment.status !== 'INITIATED') return { payment, authorizationUrl: null };

  const init = await paystack.initializeTransaction({
    email: guestEmail,
    amount: payment.amount,
    currency: payment.currency,
    reference: payment.provider_reference,
    callbackUrl,
  });

  await db.table('payments').where({ id: paymentId }).update({ status: 'PENDING' });
  const updated = await db.table('payments').where({ id: paymentId }).first();
  return { payment: updated, authorizationUrl: init.authorizationUrl };
}

const TERMINAL_PAYMENT_STATUSES = new Set(['CAPTURED', 'FAILED', 'EXPIRED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED']);

/**
 * Applies a gateway's verification result (Paystack's `status: 'success'`/
 * `'failed'`/`'abandoned'`) to the local payment — shared by both
 * `verifyPayment` (manual sync) and `handlePaystackWebhook` (real-time),
 * since both converge on the exact same state transition + folio effect,
 * applied idempotently (a payment already in a terminal state is left
 * untouched — applying the same result twice must never double-post the
 * folio effect).
 */
async function applyGatewayResult({ trx, payment, gatewayStatus, providerPaymentId, userId }) {
  if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
    return trx.table('payments').where({ id: payment.id }).first();
  }

  if (gatewayStatus === 'success') {
    const now = new Date();
    await trx.table('payments').where({ id: payment.id }).update({
      status: 'CAPTURED',
      captured_at: now,
      provider_payment_id: providerPaymentId ?? payment.provider_payment_id,
    });

    const folio = await trx.table('folios').where({ id: payment.folio_id }).first();
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
  } else {
    await trx.table('payments').where({ id: payment.id }).update({
      status: 'FAILED',
      failed_at: new Date(),
      failure_reason: `Gateway reported status "${gatewayStatus}".`,
      provider_payment_id: providerPaymentId ?? payment.provider_payment_id,
    });
  }

  return trx.table('payments').where({ id: payment.id }).first();
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

  const result = await paystack.verifyTransaction({ reference: payment.provider_reference });
  return db.transaction((trx) =>
    applyGatewayResult({
      trx,
      payment,
      gatewayStatus: result.status === 'success' ? 'success' : 'failed',
      providerPaymentId: result.providerPaymentId,
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
 */
async function handlePaystackWebhook({ rawBody, signatureHeader, parsedBody }) {
  const platformDb = scopedDb().for(systemContext());

  const verified = paystack.verifyWebhookSignature({ rawBody, signatureHeader });
  const providerEventId = String(parsedBody?.data?.id ?? parsedBody?.id ?? generateUlid());

  const existing = await platformDb.table('payment_webhook_events').where({ provider: 'paystack', provider_event_id: providerEventId }).first();
  if (existing) return { deduplicated: true };

  const [eventRowId] = await platformDb.table('payment_webhook_events').insert({
    provider: 'paystack',
    provider_event_id: providerEventId,
    payload: JSON.stringify(parsedBody ?? {}),
    verified,
  });

  if (!verified) return { verified: false };

  const reference = parsedBody?.data?.reference;
  const gatewayStatus = parsedBody?.data?.status === 'success' || parsedBody?.event === 'charge.success' ? 'success' : 'failed';
  const rawPayment = reference ? await knex()('payments').where({ provider: 'paystack', provider_reference: reference }).first() : null;

  if (rawPayment) {
    const context = workerContext({ tenantId: rawPayment.tenant_id, propertyId: rawPayment.property_id });
    const scopedForTenant = scopedDb().for(context);
    await scopedForTenant.transaction((trx) =>
      applyGatewayResult({ trx, payment: rawPayment, gatewayStatus, providerPaymentId: String(parsedBody?.data?.id ?? '') })
    );
    await platformDb.table('payment_webhook_events').where({ id: eventRowId }).update({
      tenant_id: rawPayment.tenant_id,
      property_id: rawPayment.property_id,
      related_payment_id: rawPayment.id,
      processed_at: new Date(),
    });
  }

  return { verified: true, matched: Boolean(rawPayment) };
}

// ---------------------------------------------------------------------
// Refunds — ARCHITECTURE.md §7 ("CAPTURED -> REFUNDED / PARTIALLY_REFUNDED")
// ---------------------------------------------------------------------

async function refundedSoFar({ trx, paymentId }) {
  const refunds = await trx.table('payments').where({ parent_payment_id: paymentId, status: 'CAPTURED' });
  // A refund itself is recorded as its own payment row (see below) whose
  // own status settles to CAPTURED once applied — summing its amount is
  // what "already refunded" means.
  return sumMoney(refunds.map((r) => r.amount));
}

/**
 * `amount` omitted means a full refund of whatever remains uncaptured-back.
 * Cash: real, synchronous, complete in this one transaction. Paystack: a
 * real refund API call (`src/modules/cashiering/paystack-adapter.js`) —
 * made OUTSIDE this transaction (§6.4), with the folio effect posted in a
 * short follow-up transaction once Paystack's own response confirms it
 * processed. `reason` is mandatory (CLAUDE.md: "money confirmations require
 * a reason field").
 */
async function refundPayment({ context, paymentId, amount, reason, idempotencyKey, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required for a refund.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);

  const original = await db.table('payments').where({ id: paymentId }).first();
  if (!original) throw new ValidationError('PAYMENT_NOT_FOUND', 'The specified payment does not exist.');
  if (original.status !== 'CAPTURED' && original.status !== 'PARTIALLY_REFUNDED') {
    throw new InvalidPaymentTransitionError(original.status, 'REFUNDED');
  }

  const alreadyRefunded = await refundedSoFar({ trx: db, paymentId });
  const available = sumMoney([original.amount, negateMoney(alreadyRefunded)]);
  const refundAmount = amount ?? available;
  if (compareMoney(refundAmount, available) > 0) {
    throw new RefundExceedsCapturedAmountError(paymentId, refundAmount, available);
  }

  const reference = generateUlid();

  if (original.provider === 'cash') {
    return db.transaction(async (trx) => {
      const [refundPaymentId] = await trx.table('payments').insert({
        folio_id: original.folio_id,
        idempotency_key: idempotencyKey,
        provider: 'cash',
        provider_reference: reference,
        amount: refundAmount,
        currency: original.currency,
        status: 'CAPTURED',
        captured_at: new Date(),
        parent_payment_id: original.id,
      });
      const businessDate = await propertyBusinessDate({ trx, propertyId: (await trx.table('folios').where({ id: original.folio_id }).first()).property_id });
      await trx.table('folio_line_items').insert({
        folio_id: original.folio_id,
        type: 'refund',
        description: `Cash refund of payment ${original.id}`,
        amount: refundAmount,
        currency: original.currency,
        payment_method: 'cash',
        payment_id: refundPaymentId,
        business_date: businessDate,
        posted_by_user_id: userId ?? null,
      });
      await recomputeFolioBalance({ trx, folioId: original.folio_id });
      const fullyRefunded = compareMoney(sumMoney([alreadyRefunded, refundAmount]), original.amount) === 0;
      await trx.table('payments').where({ id: original.id }).update({ status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' });
      return trx.table('payments').where({ id: refundPaymentId }).first();
    });
  }

  // Paystack — the real external call, outside a transaction (§6.4).
  const gatewayResult = await paystack.refundTransaction({ reference: original.provider_reference, amount: amount ?? undefined });
  const processed = gatewayResult.status === 'processed' || gatewayResult.status === 'success';

  return db.transaction(async (trx) => {
    const [refundPaymentId] = await trx.table('payments').insert({
      folio_id: original.folio_id,
      idempotency_key: idempotencyKey,
      provider: 'paystack',
      provider_reference: reference,
      amount: refundAmount,
      currency: original.currency,
      status: processed ? 'CAPTURED' : 'PENDING',
      captured_at: processed ? new Date() : null,
      parent_payment_id: original.id,
    });

    if (processed) {
      const businessDate = await propertyBusinessDate({ trx, propertyId: (await trx.table('folios').where({ id: original.folio_id }).first()).property_id });
      await trx.table('folio_line_items').insert({
        folio_id: original.folio_id,
        type: 'refund',
        description: `Paystack refund of payment ${original.id}`,
        amount: refundAmount,
        currency: original.currency,
        payment_method: 'paystack',
        payment_id: refundPaymentId,
        business_date: businessDate,
        posted_by_user_id: userId ?? null,
      });
      await recomputeFolioBalance({ trx, folioId: original.folio_id });
      const fullyRefunded = compareMoney(sumMoney([alreadyRefunded, refundAmount]), original.amount) === 0;
      await trx.table('payments').where({ id: original.id }).update({ status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' });
    }

    return trx.table('payments').where({ id: refundPaymentId }).first();
  });
}

module.exports = {
  recomputeFolioBalance,
  getFolio,
  listFoliosForReservation,
  listLineItems,
  listPaymentsForFolio,
  getPayment,
  openAdditionalFolio,
  moveLineItem,
  postCharge,
  postAdjustment,
  voidLineItem,
  captureCashPayment,
  initiatePaystackPaymentIntent,
  startPaystackCheckout,
  applyGatewayResult,
  verifyPayment,
  handlePaystackWebhook,
  refundPayment,
};
