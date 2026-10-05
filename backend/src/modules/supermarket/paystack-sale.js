'use strict';

/**
 * Supermarket online (Paystack) sales — card today, bank transfer later.
 *
 * SUPERMARKET-ONLY. Its payments carry `settlement_target = 'supermarket_sale'`
 * and nothing here reads or writes a folio, a hotel tab or a Register payment.
 * The shared cashiering code touches this module at exactly one point: when a
 * `supermarket_sale` payment captures, `applyGatewayResult` calls
 * `finalizeCapturedOnlineSale` (registered at the bottom of this file), inside
 * the transaction that claimed the capture.
 *
 * Flow:
 *   1. `startOnlineSale` (inside the request's idempotency transaction) prices
 *      the cart server-side — menu prices, the supermarket's own tax row, no
 *      service charge — checks the oversell confirmation, and writes a pending
 *      `supermarket_sale_intents` row plus an INITIATED payment. No tab,
 *      settlement, stock movement or receipt number exists yet.
 *   2. `startOnlineCheckout` (outside any transaction) opens the Paystack
 *      checkout on the outlet's payout subaccount (else the property's),
 *      restricted to the tender's channels, and returns the access code (for
 *      the on-screen popup) and the checkout link with a QR code of it (for
 *      the customer's own phone).
 *   3. Whichever comes first — Paystack's webhook, or the till checking
 *      (`checkOnlineSale`) — verifies the payment against Paystack's own
 *      record. The capture claim is a conditional UPDATE, so exactly one of
 *      them applies it, and in that same transaction the sale is completed:
 *      tab + items (at the prices frozen at the start), card settlement on
 *      this payment, stock deducted, gapless receipt number, receipt snapshot.
 *   4. A capture that cannot complete the sale (the sale was cancelled or had
 *      expired first, or the tax changed since the start so the amount paid no
 *      longer matches) KEEPS the money: the intent becomes `needs_review`, a
 *      manager is belled, and `refundOnlinePayment` returns it.
 *
 * Cancel and expiry ask Paystack first: a payment that already captured
 * completes its sale instead of being cancelled.
 *
 * Void of a completed online sale (`voidOnlineSale`, one manager action with
 * a reason) = full Paystack refund + stock back + sale void. A refund Paystack
 * accepts but has not processed yet voids the sale at once; the refund's
 * status is re-checked (`refreshOnlineRefunds`) until processed or failed
 * (failed bells a manager). No partial refunds.
 *
 * Lock order everywhere: the payment row, then the intent row — the order the
 * capture path takes them in (`applyGatewayResult` claims the payment with an
 * UPDATE, then the finalizer locks the intent).
 */

const QRCode = require('qrcode');
const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { sumMoney, compareMoney } = require('../../shared/money');
const { computeItemLineTotal } = require('../../shared/pos-pricing');
const { generateUlid } = require('../../shared/ulid');
const { taxChargeTypeForOutlet } = require('../../shared/outlet-types');
const { outletScopeForUser, scopeCovers } = require('../../shared/outlet-assignments');
const { recordAuditEntry } = require('../../audit');
const { resolveApplicableTaxVersions, computeChargeWithTax } = require('../cashiering/tax-engine');
const cashieringService = require('../cashiering/service');
const paystack = require('../cashiering/paystack-adapter');
const posService = require('../pos/service');
const stockService = require('../stock/service');
const { notifyStaff } = require('../notifications/staff-notifications');
const service = require('./service');
const errors = require('./errors');

/**
 * Paystack channels per online tender. Adding bank transfer later is one entry
 * here (`transfer: ['bank_transfer']`) plus its button on the till.
 */
const ONLINE_TENDERS = Object.freeze({ card: ['card'] });
const INTENT_LIFETIME_MINUTES = Number(process.env.SUPERMARKET_ONLINE_SALE_MINUTES || 30);
const CHECKOUT_URL_BASE = 'https://checkout.paystack.com/';
const UNPAID_STATUSES = ['INITIATED', 'PENDING'];

// ---------------------------------------------------------------- pricing

/** Net + tax for a frozen cart at the outlet, with the tax rows in force on the property's business date. */
async function priceCart(trx, outlet, rows) {
  const property = await trx.table('properties').where({ id: outlet.property_id }).first('current_business_date', 'base_currency');
  const taxVersions = resolveApplicableTaxVersions({ allTaxRows: await trx.table('taxes'), businessDate: property?.current_business_date, chargeType: taxChargeTypeForOutlet(outlet) });
  const baseAmount = sumMoney(rows.map((row) => computeItemLineTotal({ unit_price: row.unit_price, quantity: row.quantity, modifiers: [] })));
  const { netAmount, taxLines } = computeChargeWithTax({ baseAmount, taxVersions });
  return { total: sumMoney([netAmount, ...taxLines.map((line) => line.amount)]), currency: property?.base_currency };
}

function parseLines(intent) {
  return typeof intent.lines_json === 'string' ? JSON.parse(intent.lines_json) : intent.lines_json;
}

// ---------------------------------------------------------------- reads

async function assertCoversOutlet(db, context, outletId) {
  if (context.isImpersonation) return;
  const scope = await outletScopeForUser(db, context.userId);
  if (!scopeCovers(scope, [outletId])) throw new errors.OnlineSaleNotFoundError();
}

async function loadIntent(db, context, intentId) {
  const intent = intentId ? await db.table('supermarket_sale_intents').where({ id: intentId }).first() : null;
  if (!intent) throw new errors.OnlineSaleNotFoundError();
  await assertCoversOutlet(db, context, intent.outlet_id);
  return intent;
}

/** What the till shows: status, amount, lines, the payment's state and — once completed — the receipt. */
async function intentView(db, intent) {
  const payment = intent.payment_id ? await db.table('payments').where({ id: intent.payment_id }).first('id', 'status', 'provider_channel', 'provider_access_code') : null;
  const sale = intent.sale_id ? await service.getSaleWith(db, intent.sale_id) : null;
  return {
    id: intent.id,
    outlet_id: intent.outlet_id,
    status: intent.status,
    tender: intent.tender,
    total: intent.expected_total,
    currency: intent.currency,
    lines: parseLines(intent),
    expires_at: intent.expires_at,
    created_by_user_id: intent.created_by_user_id,
    cancel_reason: intent.cancel_reason,
    review_reason: intent.review_reason,
    payment: payment ? { id: payment.id, status: payment.status, channel: payment.provider_channel } : null,
    sale,
  };
}

async function getOnlineSale({ context, intentId }) {
  const db = scopedDb().for(context);
  return intentView(db, await loadIntent(db, context, intentId));
}

/** The caller's own pending online sale at this outlet, if any (expired ones are settled first). */
async function getMyPendingOnlineSale({ context, outletId }) {
  const db = scopedDb().for(context);
  const intent = await db.table('supermarket_sale_intents').where({ outlet_id: outletId, created_by_user_id: context.userId, status: 'pending' }).orderBy('id', 'desc').first();
  if (!intent) return null;
  const view = await checkOnlineSale({ context, intentId: intent.id, userId: context.userId });
  return view.status === 'pending' ? view : null;
}

/** Online sales a manager must act on (paid, no sale) — oldest first. */
async function listOnlineSalesNeedingReview({ context, outletId }) {
  const db = scopedDb().for(context);
  const query = db.table('supermarket_sale_intents').where({ status: 'needs_review' }).orderBy('id');
  if (outletId) query.where({ outlet_id: outletId });
  const scope = context.isImpersonation ? null : await outletScopeForUser(db, context.userId);
  const rows = (await query).filter((row) => scopeCovers(scope, [row.outlet_id]));
  const views = [];
  for (const row of rows) views.push(await intentView(db, row));
  return views;
}

// ---------------------------------------------------------------- start

/**
 * Local half, inside the request's idempotency transaction. `lines` are the
 * same `[{barcode | menu_item_id, quantity}]` a cash sale takes.
 */
async function startOnlineSale({ trx, context, userId, outletId, lines, tender, confirmOversell = false, customerEmail, idempotencyKey }) {
  if (!Object.hasOwn(ONLINE_TENDERS, tender ?? '')) {
    throw new ValidationError('INVALID_TENDER', '"tender" must be "card".', [{ field: 'tender', issue: 'invalid' }]);
  }
  const email = customerEmail ? String(customerEmail).trim() : '';
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new ValidationError('INVALID_EMAIL', 'That email address is not valid.', [{ field: 'customer_email', issue: 'invalid' }]);
  }
  const outlet = await service.requireSupermarketOutlet({ db: trx, context, outletId });

  const pending = await trx.table('supermarket_sale_intents').where({ outlet_id: outlet.id, created_by_user_id: userId, status: 'pending' }).first('id');
  if (pending) throw new errors.OnlineSalePendingError(pending.id);

  const resolved = await service.resolveSaleLines(trx, outlet, lines);
  const shortfalls = await stockService.findStockShortfalls({
    trx,
    lines: resolved.map((line) => ({ menuItemId: line.menuItem.id, quantity: line.quantity })),
    outletId: outlet.id,
  });
  if (shortfalls.length > 0 && confirmOversell !== true) throw new errors.OversellNotConfirmedError(shortfalls);

  const frozen = resolved.map((line) => ({ menu_item_id: String(line.menuItem.id), item_name: line.menuItem.name, barcode: line.barcode, quantity: line.quantity, unit_price: line.menuItem.price }));
  const { total, currency } = await priceCart(trx, outlet, frozen);
  if (compareMoney(total, '0.00') <= 0) throw new ValidationError('NOTHING_TO_PAY', 'This sale has nothing to pay online.', [{ field: 'items', issue: 'zero_total' }]);

  const [paymentId] = await trx.table('payments').insert({
    settlement_target: 'supermarket_sale',
    tender,
    idempotency_key: idempotencyKey,
    provider: 'paystack',
    provider_reference: generateUlid(),
    amount: total,
    currency,
    status: 'INITIATED',
  });
  const [intentId] = await trx.table('supermarket_sale_intents').insert({
    outlet_id: outlet.id,
    payment_id: paymentId,
    created_by_user_id: userId ?? null,
    tender,
    status: 'pending',
    lines_json: JSON.stringify(frozen),
    expected_total: total,
    currency,
    confirm_oversell: shortfalls.length > 0,
    customer_email: email || null,
    expires_at: new Date(Date.now() + INTENT_LIFETIME_MINUTES * 60_000),
  });
  return intentView(trx, await trx.table('supermarket_sale_intents').where({ id: intentId }).first());
}

/**
 * External half: opens (or reopens) the Paystack checkout. Paystack needs an
 * email for its receipt; without the customer's, the cashier's stands in.
 * Returns the access code (popup), the checkout link and a QR code of it.
 */
async function startOnlineCheckout({ context, intentId }) {
  const db = scopedDb().for(context);
  const intent = await loadIntent(db, context, intentId);
  if (intent.status !== 'pending') return { intent: await intentView(db, intent), accessCode: null, checkoutUrl: null, qrDataUrl: null };
  const staff = intent.customer_email ? null : await db.table('users').where({ id: intent.created_by_user_id ?? context.userId }).first('email');
  const { accessCode, authorizationUrl } = await cashieringService.startPaystackCheckout({
    context,
    paymentId: intent.payment_id,
    guestEmail: intent.customer_email || staff?.email,
    channels: ONLINE_TENDERS[intent.tender],
  });
  const checkoutUrl = authorizationUrl || (accessCode ? `${CHECKOUT_URL_BASE}${accessCode}` : null);
  const qrDataUrl = checkoutUrl ? await QRCode.toDataURL(checkoutUrl, { margin: 1, width: 320 }) : null;
  const fresh = await db.table('supermarket_sale_intents').where({ id: intent.id }).first();
  return { intent: await intentView(db, fresh), accessCode: accessCode ?? null, checkoutUrl, qrDataUrl };
}

// ---------------------------------------------------------------- check, cancel, expiry

/** Asks Paystack about an unpaid, started payment; a capture completes the sale (via the finalizer). */
async function syncWithPaystack({ context, intent, userId }) {
  const db = scopedDb().for(context);
  const payment = await db.table('payments').where({ id: intent.payment_id }).first('id', 'status');
  // INITIATED = the checkout was never opened, so Paystack has no such transaction.
  if (!payment || payment.status !== 'PENDING') return payment;
  return cashieringService.verifyPayment({ context, paymentId: payment.id, userId });
}

async function cancelLocally({ context, intentId, reason, userId }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const intentRow = await trx.table('supermarket_sale_intents').where({ id: intentId }).first('payment_id');
    const payment = await trx.table('payments').where({ id: intentRow.payment_id }).forUpdate().first();
    const intent = await trx.table('supermarket_sale_intents').where({ id: intentId }).forUpdate().first();
    if (intent.status !== 'pending' || payment.status === 'CAPTURED') return intent;
    await trx.table('payments').where({ id: payment.id }).whereIn('status', UNPAID_STATUSES).update({ status: 'CANCELLED', failure_reason: `Supermarket online sale cancelled: ${reason}` });
    await trx.table('supermarket_sale_intents').where({ id: intentId }).update({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: reason.slice(0, 255) });
    await recordAuditEntry(trx, {
      entityType: 'supermarket_sale_intents',
      entityId: intentId,
      propertyId: intent.property_id,
      userId: userId ?? null,
      action: 'cancel_online_sale',
      source: 'api',
      afterState: { paymentId: payment.id, paymentStatus: payment.status },
      reason,
    });
    return trx.table('supermarket_sale_intents').where({ id: intentId }).first();
  });
}

/**
 * The till's check (and the place expiry happens): syncs with Paystack, then
 * cancels the intent if the payment definitely failed or its time ran out.
 * A Paystack outage leaves everything as it was and says so (`checkError`).
 */
async function checkOnlineSale({ context, intentId, userId }) {
  const db = scopedDb().for(context);
  let intent = await loadIntent(db, context, intentId);
  let checkError = null;
  if (intent.status === 'pending') {
    let payment = null;
    try {
      payment = await syncWithPaystack({ context, intent, userId });
    } catch (error) {
      checkError = error.message;
    }
    intent = await db.table('supermarket_sale_intents').where({ id: intent.id }).first();
    if (intent.status === 'pending' && !checkError) {
      if (payment?.status === 'FAILED') {
        intent = await cancelLocally({ context, intentId: intent.id, reason: 'The online payment failed.', userId });
      } else if (new Date(intent.expires_at).getTime() <= Date.now()) {
        intent = await cancelLocally({ context, intentId: intent.id, reason: 'Expired before it was paid.', userId });
      }
    }
  }
  return { ...(await intentView(db, intent)), checkError };
}

/** Cashier cancel. Asks Paystack first: a payment already made completes the sale instead. */
async function cancelOnlineSale({ context, intentId, userId, reason }) {
  const db = scopedDb().for(context);
  const intent = await loadIntent(db, context, intentId);
  if (intent.status !== 'pending') throw new errors.OnlineSaleStateError(intent.status, 'cancelled');
  await syncWithPaystack({ context, intent, userId }); // a Paystack outage refuses the cancel rather than guess
  await cancelLocally({ context, intentId: intent.id, reason: String(reason || '').trim() || 'Cancelled at the till.', userId });
  return intentView(db, await db.table('supermarket_sale_intents').where({ id: intent.id }).first());
}

// ---------------------------------------------------------------- finalize on capture

async function markNeedsReview(trx, { intent, payment, reason }) {
  await trx.table('supermarket_sale_intents').where({ id: intent.id }).update({ status: 'needs_review', review_reason: reason.slice(0, 255) });
  await trx.table('payments').where({ id: payment.id }).update({ failure_reason: `Captured with no supermarket sale (${reason}); refund it on the Supermarket screen.`.slice(0, 500) });
  await recordAuditEntry(trx, {
    entityType: 'supermarket_sale_intents',
    entityId: intent.id,
    propertyId: intent.property_id,
    userId: null,
    action: 'online_payment_needs_review',
    source: 'job',
    afterState: { paymentId: payment.id, amount: payment.amount, currency: payment.currency },
    reason,
  });
  await notifyStaff({
    trx,
    eventType: 'supermarket.online_payment_needs_review',
    payload: { intentId: intent.id, paymentId: payment.id, outletId: intent.outlet_id, total: payment.amount, currency: payment.currency, reason },
    dedupKey: `supermarket-online-review:${intent.id}`,
    outletIds: [intent.outlet_id],
  });
}

/** `settleOrder`'s claim for an online sale's card settlement: this captured, unused payment, for exactly the total. */
async function claimOnlineSalePayment({ trx, paymentId, total, currency }) {
  const payment = await trx.table('payments').where({ id: paymentId }).forUpdate().first();
  if (!payment || payment.settlement_target !== 'supermarket_sale' || payment.status !== 'CAPTURED') throw new Error(`Online sale payment ${paymentId} is not a captured supermarket payment.`);
  if (await trx.table('pos_order_settlements').where({ payment_id: payment.id }).first('id')) throw new Error(`Online sale payment ${paymentId} already settles a sale.`);
  if (payment.currency !== currency || compareMoney(payment.amount, total) !== 0) throw new Error(`Online sale payment ${paymentId} does not match the sale total.`);
  return payment;
}

/**
 * Called by `applyGatewayResult` in the transaction that claimed the capture
 * (so it runs once per payment). Completes the sale, or keeps the money and
 * flags it for a refund. Throws only on an unexpected failure, which rolls the
 * capture back so the webhook retry or the next check tries again.
 */
async function finalizeCapturedOnlineSale({ trx, payment, lateCapture }) {
  const intent = await trx.table('supermarket_sale_intents').where({ payment_id: payment.id }).forUpdate().first();
  if (!intent) throw new Error(`Captured supermarket payment ${payment.id} has no online sale.`);
  if (intent.status === 'completed') return;
  if (lateCapture || intent.status !== 'pending') {
    await markNeedsReview(trx, { intent, payment, reason: intent.status === 'cancelled' ? `paid after the sale was cancelled (${intent.cancel_reason ?? 'cancelled'})` : 'paid after the sale was closed' });
    return;
  }

  const outlet = await trx.table('pos_outlets').where({ id: intent.outlet_id }).first();
  const frozen = parseLines(intent);
  const { total, currency } = await priceCart(trx, outlet, frozen);
  if (currency !== payment.currency || compareMoney(total, payment.amount) !== 0) {
    await markNeedsReview(trx, { intent, payment, reason: `the amount due changed after the payment started (${payment.amount} paid, ${total} due now)` });
    return;
  }

  const shortfalls = await stockService.findStockShortfalls({ trx, lines: frozen.map((line) => ({ menuItemId: line.menu_item_id, quantity: line.quantity })), outletId: outlet.id });
  let stockOverrideReason = stockService.AUTOMATIC_OVERRIDE_REASON_SUPERMARKET;
  if (shortfalls.length > 0) stockOverrideReason = intent.confirm_oversell ? stockService.CONFIRMED_OVERSELL_REASON_SUPERMARKET : stockService.AUTOMATIC_OVERRIDE_REASON_CARD_CAPTURE;

  const userId = intent.created_by_user_id;
  const { orderId, itemRows } = await service.openQuickSaleOrder(trx, { outlet, userId, rows: frozen });
  await trx.table('payments').where({ id: payment.id }).update({ pos_order_id: orderId });
  const { settlements } = await posService.settleOrder({
    trx,
    orderId,
    settledByUserId: userId,
    settlements: [{ splitGroup: null, method: 'card', paymentId: payment.id }],
    stockOverrideReason,
    claimPayment: claimOnlineSalePayment,
  });
  const saleId = await service.recordReceiptedSale(trx, { outlet, orderId, settlement: settlements[0], userId, method: 'card', itemRows });
  await trx.table('supermarket_sale_intents').where({ id: intent.id }).update({ status: 'completed', sale_id: saleId, completed_at: new Date() });
}

cashieringService.setSupermarketCaptureFinalizer(finalizeCapturedOnlineSale);

// ---------------------------------------------------------------- refunds

/**
 * Full Paystack refund of a captured online-sale payment, in three steps so a
 * refund is never sent twice: (1) record the refund as INITIATED under the
 * payment's lock (refused if one is already in progress or done); (2) ask
 * Paystack, outside any transaction; (3) record the result and run `apply`
 * (void the sale, or close the needs-review intent) in one transaction. A
 * Paystack refusal marks the refund FAILED and changes nothing else.
 */
async function issueRefund({ context, payment, reason, userId, idempotencyKey, apply }) {
  const db = scopedDb().for(context);
  const refundPaymentId = await db.transaction(async (trx) => {
    const locked = await trx.table('payments').where({ id: payment.id }).forUpdate().first();
    if (locked.status !== 'CAPTURED') throw new errors.OnlineSaleStateError(`payment ${locked.status.toLowerCase()}`, 'refunded');
    const children = await trx.table('payments').where({ parent_payment_id: payment.id }).whereIn('status', ['INITIATED', 'PENDING', 'CAPTURED']).first('id');
    if (children) throw new errors.OnlineRefundInProgressError(payment.id);
    const [id] = await trx.table('payments').insert({
      pos_order_id: locked.pos_order_id,
      settlement_target: 'supermarket_sale',
      tender: locked.tender,
      idempotency_key: idempotencyKey,
      provider: 'paystack',
      provider_reference: generateUlid(),
      amount: locked.amount,
      currency: locked.currency,
      status: 'INITIATED',
      parent_payment_id: locked.id,
    });
    return id;
  });

  let result;
  try {
    const { adapter } = await paystack.resolveAdapterForCurrency(db, payment.currency);
    result = await adapter.refundTransaction({ reference: payment.provider_reference });
  } catch (error) {
    await db.table('payments').where({ id: refundPaymentId }).update({ status: 'FAILED', failed_at: new Date(), failure_reason: `Paystack refused the refund: ${error.message}`.slice(0, 500) });
    throw error;
  }

  const processed = result.status === 'processed' || result.status === 'success';
  return db.transaction(async (trx) => {
    await trx
      .table('payments')
      .where({ id: refundPaymentId })
      .update({ status: processed ? 'CAPTURED' : 'PENDING', captured_at: processed ? new Date() : null, provider_payment_id: result.refundId ?? null });
    if (processed) await trx.table('payments').where({ id: payment.id }).update({ status: 'REFUNDED' });
    await apply(trx);
    if (payment.subaccount_code) {
      // As for hotel refunds: Paystack takes the whole refund from the platform balance; record what the property owes back.
      await recordAuditEntry(trx, {
        entityType: 'payments',
        entityId: refundPaymentId,
        propertyId: payment.property_id,
        userId,
        action: 'refund_subaccount_shortfall',
        source: 'api',
        afterState: { originalPaymentId: payment.id, subaccountCode: payment.subaccount_code, amountOwedBackByProperty: payment.amount, currency: payment.currency },
        reason: "Paystack refunds a split payment from the platform's own balance only — this amount is not yet automatically recovered from the property.",
      });
    }
    return trx.table('payments').where({ id: refundPaymentId }).first();
  });
}

/**
 * Void of a completed online sale: full refund + stock back + sale void, one
 * manager action with a reason. (Cash and terminal sales keep `voidSale`.)
 */
async function voidOnlineSale({ context, saleId, reason, userId, idempotencyKey }) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void a sale.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);
  const sale = await db.table('supermarket_sales').where({ id: saleId }).first();
  if (!sale) throw new errors.SupermarketSaleNotFoundError();
  if (sale.voided_at) throw new errors.SupermarketSaleAlreadyVoidedError();
  const settlement = await db.table('pos_order_settlements').where({ id: sale.settlement_id }).first();
  const payment = settlement?.payment_id ? await db.table('payments').where({ id: settlement.payment_id }).first() : null;
  if (!payment || payment.settlement_target !== 'supermarket_sale') throw new ValidationError('NOT_AN_ONLINE_SALE', 'This sale was not paid online.', [{ field: 'sale_id', issue: 'not_online' }]);

  const refund = await issueRefund({
    context,
    payment,
    reason: cleanReason,
    userId,
    idempotencyKey,
    apply: async (trx) => {
      await trx.table('pos_orders').where({ id: settlement.pos_order_id }).forUpdate().first();
      const lockedSale = await trx.table('supermarket_sales').where({ id: saleId }).forUpdate().first();
      if (lockedSale.voided_at) throw new errors.SupermarketSaleAlreadyVoidedError();
      await stockService.reverseStockForSettlement({ trx, settlementId: settlement.id, userId });
      await trx.table('pos_order_settlements').where({ id: settlement.id }).update({ voided_at: new Date(), void_reason: cleanReason, voided_by_user_id: userId });
      await trx.table('supermarket_sales').where({ id: saleId }).update({ voided_at: new Date() });
    },
  });
  return { sale: await service.getSaleWith(db, saleId), refund };
}

/** Manager refund of a paid online sale that never completed (`needs_review`). */
async function refundOnlinePayment({ context, intentId, reason, userId, idempotencyKey }) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw new ValidationError('MISSING_FIELD', '"reason" is required for a refund.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);
  const intent = await loadIntent(db, context, intentId);
  if (intent.status !== 'needs_review') throw new errors.OnlineSaleStateError(intent.status, 'refunded');
  const payment = await db.table('payments').where({ id: intent.payment_id }).first();
  const refund = await issueRefund({
    context,
    payment,
    reason: cleanReason,
    userId,
    idempotencyKey,
    apply: async (trx) => {
      await trx.table('supermarket_sale_intents').where({ id: intent.id }).update({ status: 'refunded' });
    },
  });
  return { intent: await intentView(db, await db.table('supermarket_sale_intents').where({ id: intent.id }).first()), refund };
}

/**
 * Re-checks refunds Paystack accepted but had not processed. Processed → the
 * original payment becomes REFUNDED; failed → the refund is FAILED and a
 * manager is belled (the customer has not been repaid). Never throws.
 */
async function refreshOnlineRefunds({ context, limit = 20 }) {
  const db = scopedDb().for(context);
  const pending = await db.table('payments').where({ settlement_target: 'supermarket_sale', status: 'PENDING' }).whereNotNull('parent_payment_id').whereNotNull('provider_payment_id').orderBy('id').limit(limit);
  let changed = 0;
  for (const refund of pending) {
    try {
      const { adapter } = await paystack.resolveAdapterForCurrency(db, refund.currency);
      const { status } = await adapter.fetchRefund({ refundId: refund.provider_payment_id });
      if (status === 'processed' || status === 'success') {
        await db.transaction(async (trx) => {
          const claimed = await trx.table('payments').where({ id: refund.id, status: 'PENDING' }).update({ status: 'CAPTURED', captured_at: new Date() });
          if (claimed) await trx.table('payments').where({ id: refund.parent_payment_id }).update({ status: 'REFUNDED' });
        });
        changed += 1;
      } else if (status === 'failed') {
        await db.transaction(async (trx) => {
          const claimed = await trx.table('payments').where({ id: refund.id, status: 'PENDING' }).update({ status: 'FAILED', failed_at: new Date(), failure_reason: 'Paystack reported the refund failed; the customer has not been repaid.' });
          if (!claimed) return;
          await notifyStaff({
            trx,
            eventType: 'supermarket.online_refund_failed',
            payload: { paymentId: refund.parent_payment_id, refundPaymentId: refund.id, total: refund.amount, currency: refund.currency },
            dedupKey: `supermarket-refund-failed:${refund.id}`,
          });
        });
        changed += 1;
      }
    } catch (error) {
      console.error(`Supermarket refund ${refund.id}: status check failed:`, error.message);
    }
  }
  return changed;
}

module.exports = {
  ONLINE_TENDERS,
  INTENT_LIFETIME_MINUTES,
  startOnlineSale,
  startOnlineCheckout,
  getOnlineSale,
  getMyPendingOnlineSale,
  listOnlineSalesNeedingReview,
  checkOnlineSale,
  cancelOnlineSale,
  finalizeCapturedOnlineSale,
  voidOnlineSale,
  refundOnlinePayment,
  refreshOnlineRefunds,
};
