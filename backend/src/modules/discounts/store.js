'use strict';

/**
 * The small database helpers the POS and supermarket settlement paths call. They live apart from `service.js` so
 * `pos/service.js` can use them without requiring the discounts service (which in turn needs pos code): this file
 * requires nothing from pos.
 *
 * Only ACTIVE discounts are ever priced; a pending one is ignored until a manager approves it.
 */

const { sumMoney } = require('../../shared/money');
const { applyDiscounts, isWithinPercentLimit } = require('../../shared/discount-pricing');
const errors = require('./errors');

/** The most a role may discount without a manager's approval, until a property sets its own. */
const DEFAULT_LIMITS = Object.freeze({ pos_operator: '5.00', manager: '25.00', admin: '50.00', super_admin: '100.00' });
/** The roles the limits screen lists (the ones that can hold `discount.apply`). */
const LIMIT_ROLES = Object.freeze(['pos_operator', 'manager', 'admin', 'super_admin']);

const DEFAULT_REASONS = Object.freeze([
  { code: 'staff_meal', name: 'Staff meal', kind: 'comp' },
  { code: 'managers_gift', name: "Manager's gift", kind: 'both' },
  { code: 'complaint', name: 'Customer complaint', kind: 'both' },
  { code: 'promo', name: 'Promotion', kind: 'discount' },
  { code: 'damaged_goods', name: 'Damaged goods', kind: 'both' },
]);

/** The percent limit for a role: the property's own row, else the built-in default (0 for any other role). */
async function limitPercentFor(db, role) {
  const row = await db.table('discount_limits').where({ role_code: role }).first('max_percent');
  if (row) return String(row.max_percent);
  return DEFAULT_LIMITS[role] ?? '0.00';
}

/**
 * The active discounts that price an order, oldest first. Inside a transaction that holds the order's lock, pass
 * `lock: true`: a plain read keeps the snapshot taken before that lock was granted and would miss a discount a
 * concurrent request just approved or removed (the REPEATABLE READ trap documented in `closeShift`).
 */
function activeForOrder(db, orderId, { lock = false } = {}) {
  const query = db.table('discounts').where({ pos_order_id: orderId, status: 'active' }).orderBy('id', 'asc');
  return lock ? query.forShare() : query;
}

/**
 * True when a Register card/NQR payment for this check has been captured but not settled yet: changing the total now
 * would leave money taken for a different amount.
 */
async function hasCapturedUnsettledPayment(db, orderId) {
  const captured = await db.table('payments').where({ pos_order_id: orderId, settlement_target: 'pos_register', status: 'CAPTURED' }).select('id');
  if (captured.length === 0) return false;
  const settled = await db.table('pos_order_settlements').whereIn('payment_id', captured.map((row) => row.id)).whereNull('voided_at').select('payment_id');
  const settledIds = new Set(settled.map((row) => String(row.payment_id)));
  return captured.some((row) => !settledIds.has(String(row.id)));
}

/** Names for the reasons used by these discount rows. */
async function reasonNamesFor(db, rows) {
  const ids = [...new Set(rows.map((row) => row.reason_id))];
  if (ids.length === 0) return new Map();
  const reasons = await db.table('discount_reasons').whereIn('id', ids).select('id', 'name');
  return new Map(reasons.map((reason) => [String(reason.id), reason.name]));
}

/**
 * A discount nobody approved was allowed because it was within its giver's limit WHEN GIVEN. A fixed amount can grow
 * past that limit if the check shrinks afterwards (an item is voided), so this runs again at settlement: an
 * unapproved discount whose effective percent now exceeds its giver's limit stops the sale.
 */
async function assertUnapprovedWithinLimit(trx, { rows, pricing, propertyId }) {
  const amounts = new Map(pricing.discounts.map((entry) => [String(entry.discountId), entry]));
  for (const row of rows) {
    if (row.approved_by_user_id) continue;
    const entry = amounts.get(String(row.id));
    if (!entry) continue;
    const access = await trx.table('user_property_access').where({ user_id: row.applied_by_user_id, property_id: propertyId }).first('role');
    const limit = access ? await limitPercentFor(trx, access.role) : '0.00';
    if (!isWithinPercentLimit({ amount: entry.amount, base: entry.baseBefore, limitPercent: limit })) throw new errors.DiscountNeedsApprovalError(row.id);
  }
}

/**
 * Writes one `settlement_discounts` row per discount part in a settled group: the amounts as the server worked them
 * out, plus the reason name and who gave and approved it, frozen so later edits never rewrite a sale.
 */
async function recordSettlementDiscounts(trx, { settlementId, group, rows, reasonNames, outletId, businessDate, currency }) {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const part of group.parts) {
    const row = byId.get(String(part.discountId));
    await trx.table('settlement_discounts').insert({
      settlement_id: settlementId,
      discount_id: row.id,
      outlet_id: outletId,
      scope: row.scope,
      kind: row.kind,
      type: row.type,
      value: row.value,
      base_before: part.baseBefore,
      amount: part.amount,
      reason_id: row.reason_id,
      reason_name: reasonNames.get(String(row.reason_id)) ?? '',
      applied_by_user_id: row.applied_by_user_id,
      approved_by_user_id: row.approved_by_user_id ?? null,
      approval_id: row.approval_id ?? null,
      business_date: businessDate ?? null,
      currency,
    });
  }
}

async function markApplied(trx, ids) {
  if (ids.length === 0) return;
  await trx.table('discounts').whereIn('id', ids).where({ status: 'active' }).update({ status: 'applied' });
}

/** Prices items with the active discounts, or returns null when there are none (callers then keep today's exact path). */
function priceOrNull(items, rows) {
  return rows.length ? applyDiscounts({ items, discounts: rows }) : null;
}

/**
 * Discount and comp totals for a shift's settlements, or null when the shift gave none (so the cash-up response keeps
 * its old shape). Voided settlements are excluded.
 */
async function summaryForShift(db, shiftId) {
  const rows = await db
    .table('settlement_discounts')
    .joinScoped('pos_order_settlements', (join) => join.on('pos_order_settlements.id', '=', 'settlement_discounts.settlement_id'))
    .where({ 'pos_order_settlements.pos_shift_id': shiftId })
    .whereNull('pos_order_settlements.voided_at')
    .select('settlement_discounts.kind', 'settlement_discounts.amount');
  if (rows.length === 0) return null;
  const of = (kind) => rows.filter((row) => row.kind === kind);
  return {
    count: rows.length,
    total: sumMoney(rows.map((row) => row.amount)),
    discounts: sumMoney(of('discount').map((row) => row.amount)),
    comps: sumMoney(of('comp').map((row) => row.amount)),
    compCount: of('comp').length,
    // Only a shift that redeemed a voucher gains these, so every other cash-up keeps its shape.
    ...(of('voucher').length ? { vouchers: sumMoney(of('voucher').map((row) => row.amount)), voucherCount: of('voucher').length } : {}),
  };
}

module.exports = {
  DEFAULT_LIMITS,
  LIMIT_ROLES,
  DEFAULT_REASONS,
  limitPercentFor,
  activeForOrder,
  hasCapturedUnsettledPayment,
  reasonNamesFor,
  assertUnapprovedWithinLimit,
  recordSettlementDiscounts,
  markApplied,
  priceOrNull,
  summaryForShift,
};
