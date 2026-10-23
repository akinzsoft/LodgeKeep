'use strict';

/**
 * Register card/NQR payments Paystack captured that no standing settlement uses while their tab is
 * still open: the customer paid, but the cashier's settle call never succeeded (browser closed, the
 * total changed). A Register capture is deliberately capture-only (`applyGatewayResult`), so nothing
 * on the server settles it. This is detection only: it never settles anything.
 *
 * Used by the sweep (`jobs/payment-webhooks.js`) for the manager alert and by the Register banner.
 * Reads only; "stranded" is always derived, so a settle or a refund clears it with no bookkeeping.
 */

/** Minutes a capture may wait for its cashier before it counts as stranded. */
function strandedMinAgeMinutes() {
  const value = Number(process.env.STRANDED_REGISTER_PAYMENT_MIN_AGE_MINUTES);
  return Number.isFinite(value) && value > 0 ? value : 15;
}

/** @returns {Promise<Array>} newest first; each row carries the tab's label and outlet. */
async function listStrandedRegisterPayments({ db, outletId = null, outletIds = null, now = new Date() }) {
  const cutoff = new Date(now.getTime() - strandedMinAgeMinutes() * 60_000);
  let query = db
    .table('payments')
    .joinScoped('pos_orders', (join) => join.on('pos_orders.id', '=', 'payments.pos_order_id'))
    .where({ 'payments.settlement_target': 'pos_register', 'payments.status': 'CAPTURED', 'pos_orders.status': 'open' })
    .whereNull('payments.parent_payment_id')
    .where('payments.captured_at', '<=', cutoff);
  if (outletId) query = query.where('pos_orders.outlet_id', outletId);
  if (outletIds) query = query.whereIn('pos_orders.outlet_id', outletIds);
  const payments = await query
    .select(
      'payments.id as id',
      'payments.pos_order_id as pos_order_id',
      'payments.amount as amount',
      'payments.currency as currency',
      'payments.tender as tender',
      'payments.captured_at as captured_at',
      'pos_orders.table_label as table_label',
      'pos_orders.outlet_id as outlet_id'
    )
    .orderBy('payments.id', 'desc');
  if (payments.length === 0) return [];
  // A voided settlement no longer accounts for its payment.
  const used = await db.table('pos_order_settlements').whereIn('payment_id', payments.map((p) => p.id)).whereNull('voided_at').select('payment_id');
  const usedIds = new Set(used.map((row) => String(row.payment_id)));
  return payments.filter((p) => !usedIds.has(String(p.id)));
}

module.exports = { listStrandedRegisterPayments, strandedMinAgeMinutes };
