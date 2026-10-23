'use strict';

/**
 * Refunding a card sale that was already SETTLED on a Register (or guest-order) tab.
 *
 * Nothing here moves money itself: the refund is Cashiering's own `refundPayment` (Paystack, full amount, the
 * `pos.refund_payment` manager-PIN claim, the settlement void, stock and voucher reversal, the reconcile sweep and
 * webhook). This file only (a) lists settled card sales with where their refund stands, and (b) checks, on the server,
 * that the sale really is a refundable settled card sale before handing over. The client never sends an amount: the
 * refund is always exactly what was captured.
 *
 * "Refund pending" and "refunded" are derived from the refund's own `payments` row (INITIATED/PENDING vs CAPTURED) and
 * the original payment's status, so no column is added anywhere.
 */

const { scopedDb } = require('../../db');
const { AppError, ValidationError } = require('../../shared/errors');
const cashieringService = require('../cashiering/service');

/** Refundable tenders: Register card / NQR payments, and guest QR-order card payments. */
const POS_TARGETS = ['pos_register', 'pos_order'];

/** The reason picker. The label is what lands in the refund's reason; `other` needs a note. */
const REFUND_REASONS = {
  customer_request: 'Customer requested a refund',
  wrong_charge: 'Wrong item or overcharged',
  duplicate_payment: 'Duplicate payment',
  service_issue: 'Service or quality complaint',
  order_cancelled: 'Order cancelled',
  other: 'Other',
};

class CardSaleNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_CARD_SALE_NOT_FOUND', 'No settled card sale found with that id.', 404);
  }
}

class CardSaleAlreadyRefundedError extends AppError {
  constructor() {
    super('CONFLICT_CARD_SALE_ALREADY_REFUNDED', 'This card sale has already been refunded.', 409);
  }
}

class CardSaleRefundPendingError extends AppError {
  constructor() {
    super('CONFLICT_CARD_SALE_REFUND_PENDING', 'A refund for this card sale is already waiting on Paystack.', 409);
  }
}

class CardSaleNotRefundableError extends AppError {
  constructor(message) {
    super('BUSINESS_RULE_CARD_SALE_NOT_REFUNDABLE', message, 422);
  }
}

/** Turns the picker's code (and note) into the reason text stored with the refund. */
function buildRefundReason({ reasonCode, reasonNote }) {
  if (!Object.prototype.hasOwnProperty.call(REFUND_REASONS, reasonCode ?? '')) {
    throw new ValidationError('INVALID_REASON_CODE', `"reason_code" must be one of: ${Object.keys(REFUND_REASONS).join(', ')}.`, [{ field: 'reason_code', issue: 'invalid' }]);
  }
  const note = typeof reasonNote === 'string' ? reasonNote.trim() : '';
  if (reasonCode === 'other' && !note) {
    throw new ValidationError('MISSING_FIELD', 'Please say why this card sale is being refunded.', [{ field: 'reason_note', issue: 'missing' }]);
  }
  const text = note ? `${REFUND_REASONS[reasonCode]}: ${note}` : REFUND_REASONS[reasonCode];
  if (text.length > 500) throw new ValidationError('REASON_TOO_LONG', 'The reason is too long (500 characters at most).', [{ field: 'reason_note', issue: 'too_long' }]);
  return text;
}

function describeState(payment, children, standing) {
  const inFlight = children.find((child) => child.status === 'INITIATED' || child.status === 'PENDING');
  const captured = children.find((child) => child.status === 'CAPTURED');
  if (inFlight) return { state: 'refund_pending', refundStatus: 'pending', refund: inFlight, disabledReason: 'A refund for this sale is waiting on Paystack.' };
  if (payment.status === 'REFUNDED') return { state: 'refunded', refundStatus: 'completed', refund: captured ?? null, disabledReason: 'This sale has already been refunded.' };
  if (payment.status === 'PARTIALLY_REFUNDED') {
    return { state: 'partially_refunded', refundStatus: 'completed', refund: captured ?? null, disabledReason: 'This sale was refunded in part. Refunding the rest is not available here yet.' };
  }
  if (!standing) return { state: 'not_refundable', refundStatus: null, refund: null, disabledReason: 'This sale is no longer standing.' };
  if (payment.status !== 'CAPTURED') return { state: 'not_refundable', refundStatus: null, refund: null, disabledReason: 'The card payment was not captured.' };
  return { state: 'refundable', refundStatus: null, refund: null, disabledReason: null };
}

/**
 * Settled card sales on business dates in the range, each with its refund state. Newest first. A sale refunded in full
 * is still listed (its settlement is voided but the sale happened) so the refund's status stays visible.
 *
 * @param {object} p
 * @param {Array<string>|null} p.outletIds  The caller's outlet scope (`null` = every outlet).
 */
async function listCardSales({ context, dateFrom, dateTo, outletId = null, outletIds = null }) {
  const db = scopedDb().for(context);
  let query = db
    .table('pos_order_settlements')
    .joinScoped('payments', (join) => join.on('payments.id', '=', 'pos_order_settlements.payment_id'))
    .joinScoped('pos_orders', (join) => join.on('pos_orders.id', '=', 'pos_order_settlements.pos_order_id'))
    .whereBetween('pos_order_settlements.business_date', [dateFrom, dateTo])
    .whereIn('payments.settlement_target', POS_TARGETS)
    .whereNull('payments.parent_payment_id')
    .where((group) => group.whereNull('pos_order_settlements.voided_at').orWhere('payments.status', 'REFUNDED'));
  if (outletId) query = query.where('pos_orders.outlet_id', outletId);
  if (outletIds) query = query.whereIn('pos_orders.outlet_id', outletIds);
  const rows = await query
    .select(
      'payments.id as payment_id',
      'payments.status as payment_status',
      'payments.tender as tender',
      'payments.amount as amount',
      'payments.currency as currency',
      'payments.provider_reference as provider_reference',
      'payments.provider_channel as provider_channel',
      'pos_order_settlements.pos_order_id as order_id',
      'pos_order_settlements.business_date as business_date',
      'pos_order_settlements.settled_at as settled_at',
      'pos_order_settlements.voided_at as voided_at',
      'pos_orders.table_label as table_label',
      'pos_orders.outlet_id as outlet_id'
    )
    .orderBy('pos_order_settlements.settled_at', 'desc');
  if (rows.length === 0) return [];

  const paymentIds = [...new Set(rows.map((row) => String(row.payment_id)))];
  const children = await db.table('payments').whereIn('parent_payment_id', paymentIds).select('id', 'parent_payment_id', 'status', 'amount', 'captured_at');
  const childrenByPayment = new Map();
  for (const child of children) childrenByPayment.set(String(child.parent_payment_id), [...(childrenByPayment.get(String(child.parent_payment_id)) ?? []), child]);

  const seen = new Set();
  const sales = [];
  for (const row of rows) {
    const key = String(row.payment_id);
    if (seen.has(key)) continue; // one payment can back more than one check; one line per payment
    seen.add(key);
    const { state, refundStatus, refund, disabledReason } = describeState({ status: row.payment_status }, childrenByPayment.get(key) ?? [], !row.voided_at);
    sales.push({
      paymentId: row.payment_id,
      orderId: row.order_id,
      tableLabel: row.table_label,
      outletId: row.outlet_id,
      tender: row.tender,
      amount: row.amount,
      currency: row.currency,
      providerReference: row.provider_reference,
      providerChannel: row.provider_channel,
      businessDate: row.business_date,
      settledAt: row.settled_at,
      state,
      refundStatus,
      refundPaymentId: refund?.id ?? null,
      refundedAt: refundStatus === 'completed' ? refund?.captured_at ?? null : null,
      disabledReason,
    });
  }
  return sales;
}

/**
 * The server-side gate before a refund: the payment must be a Paystack card/NQR payment on a POS tab, still standing as a
 * settlement, fully captured, with no refund started. These checks give clear answers; the authority on double refunds
 * is still `refundPayment`, which re-checks under the payment's row lock.
 */
async function assertRefundableCardSale({ context, paymentId }) {
  const db = scopedDb().for(context);
  const payment = await db.table('payments').where({ id: paymentId }).first();
  if (!payment || !POS_TARGETS.includes(payment.settlement_target) || payment.parent_payment_id) throw new CardSaleNotFoundError();
  if (payment.provider !== 'paystack') throw new CardSaleNotRefundableError('Only Paystack card payments can be refunded here.');

  const children = await db.table('payments').where({ parent_payment_id: payment.id }).select('id', 'status');
  if (children.some((child) => child.status === 'INITIATED' || child.status === 'PENDING')) throw new CardSaleRefundPendingError();
  if (payment.status === 'REFUNDED') throw new CardSaleAlreadyRefundedError();
  if (payment.status === 'PARTIALLY_REFUNDED') throw new CardSaleNotRefundableError('This sale was refunded in part. Refunding the rest is not available here yet.');
  if (payment.status !== 'CAPTURED') throw new CardSaleNotRefundableError('The card payment was not captured, so there is nothing to refund.');

  const settlement = await db.table('pos_order_settlements').where({ payment_id: payment.id }).whereNull('voided_at').first('id');
  if (!settlement) {
    throw new CardSaleNotRefundableError('This payment has no settled sale. If the guest paid but the tab was never settled, refund it from "Card payments to refund".');
  }
  return payment;
}

/**
 * Refunds a settled card sale in full. No amount is accepted: the refund is the whole captured payment.
 */
async function refundCardSale({ context, paymentId, reason, idempotencyKey, userId, approve }) {
  await assertRefundableCardSale({ context, paymentId });
  return cashieringService.refundPayment({ context, paymentId, reason, idempotencyKey, userId, approve });
}

module.exports = {
  REFUND_REASONS,
  buildRefundReason,
  listCardSales,
  assertRefundableCardSale,
  refundCardSale,
  CardSaleNotFoundError,
  CardSaleAlreadyRefundedError,
  CardSaleRefundPendingError,
  CardSaleNotRefundableError,
};
