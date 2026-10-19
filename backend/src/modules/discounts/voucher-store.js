'use strict';

/**
 * The database helpers the settlement, void and refund paths call for vouchers. Like `store.js`, this file requires
 * nothing from pos or cashiering, so `pos/service.js`, `cashiering/service.js` and the supermarket can use it without a
 * cycle.
 *
 * A voucher is a `discounts` row (kind `voucher`) that prices exactly like any other order-level discount, plus a
 * `voucher_redemptions` row that links it to its voucher. A use is CONSUMED only at settlement, by one conditional
 * UPDATE under the order's lock; it is GIVEN BACK only when that sale is voided (or fully refunded), by a guarded
 * decrement that touches nothing but the count.
 */

const { recordAuditEntry } = require('../../audit');
const errors = require('./errors');

const VOUCHER_KIND = 'voucher';

/** Why a voucher cannot be used at an outlet on a business date, or null when it can. Pure: no database. */
function problemFor(voucher, { outletId, businessDate, outletIds }) {
  if (!voucher) return 'missing';
  if (voucher.status !== 'active') return 'disabled';
  const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
  if (businessDate && day(voucher.valid_from) > businessDate) return 'not_yet';
  if (businessDate && day(voucher.valid_to) < businessDate) return 'expired';
  if (voucher.max_total_uses !== null && voucher.max_total_uses !== undefined && Number(voucher.used_count) >= Number(voucher.max_total_uses)) return 'used_up';
  if (outletIds.length > 0 && !outletIds.map(String).includes(String(outletId))) return 'wrong_outlet';
  return null;
}

async function outletIdsOf(db, voucherId) {
  return (await db.table('voucher_outlets').where({ voucher_id: voucherId })).map((row) => row.outlet_id);
}

async function propertyBusinessDate(db, propertyId) {
  const property = await db.table('properties').where({ id: propertyId }).first('current_business_date');
  return property?.current_business_date ? String(property.current_business_date).slice(0, 10) : null;
}

/** The voucher rows on an order that are live (active) and their redemption + voucher, oldest first. */
async function liveVoucherDiscounts(db, orderId, { lock = false } = {}) {
  let query = db.table('discounts').where({ pos_order_id: orderId, kind: VOUCHER_KIND, status: 'active' }).orderBy('id', 'asc');
  if (lock) query = query.forShare();
  return query;
}

/**
 * Whether a voucher on this check can still be redeemed. Read-only; used by the settlement preview and by the payment
 * step BEFORE any money is taken, so the failure at settlement is the rare one. Returns `{discountId, reason}` or null.
 */
async function previewProblem(db, { orderId, outletId, propertyId }) {
  const discounts = await liveVoucherDiscounts(db, orderId);
  if (discounts.length === 0) return null;
  const businessDate = await propertyBusinessDate(db, propertyId);
  for (const discount of discounts) {
    const link = await db.table('voucher_redemptions').where({ discount_id: discount.id }).first();
    const voucher = link ? await db.table('vouchers').where({ id: link.voucher_id }).first() : null;
    const reason = problemFor(voucher, { outletId, businessDate, outletIds: voucher ? await outletIdsOf(db, voucher.id) : [] });
    if (reason) return { discountId: String(discount.id), reason };
  }
  return null;
}

/**
 * Locks the vouchers a check carries, in ascending id, as the FIRST thing a settlement does after the order lock. This
 * order matters: the settlement then reads the check's discounts with a locking read, which takes next-key (gap) locks
 * on the discounts index, and writes them (`applied`) later. Settlements of different checks that share a voucher queue
 * on the voucher here, holding no gap lock yet; if they queued on it AFTER the discounts read, the winner's update would
 * need a gap the waiter holds and the waiter would be waiting for the winner (a deadlock, seen on real connections).
 * A plain read finds which vouchers; `redeemForOrder` re-reads each under its lock.
 */
async function lockVouchersFirst(trx, orderId) {
  const discounts = await trx.table('discounts').where({ pos_order_id: orderId, kind: VOUCHER_KIND, status: 'active' }).select('id');
  if (discounts.length === 0) return;
  const links = await trx.table('voucher_redemptions').whereIn('discount_id', discounts.map((row) => row.id)).select('voucher_id');
  const ids = [...new Set(links.map((row) => String(row.voucher_id)))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  for (const id of ids) await trx.table('vouchers').where({ id }).forUpdate().first('id');
}

/**
 * Consumes one use of each voucher on a check, inside the settlement transaction (the order is locked). ONE
 * row lock decides it: the voucher is read under `FOR UPDATE` and only counts a use if it is still active, in its dates and
 * under its use limit, so two registers redeeming the last use at the same moment cannot both win. A refusal throws with nothing
 * written (the whole settlement rolls back) and leaves the discount active, so the cashier can remove it.
 */
async function redeemForOrder(trx, { discountRows, pricing, orderId, outletId, propertyId, userId }) {
  const vouchers = discountRows.filter((row) => row.kind === VOUCHER_KIND);
  if (vouchers.length === 0) return [];
  const businessDate = await propertyBusinessDate(trx, propertyId);
  const amounts = new Map(pricing.discounts.map((entry) => [String(entry.discountId), entry.amount]));
  const redeemed = [];
  for (const discount of vouchers) {
    const link = await trx.table('voucher_redemptions').where({ discount_id: discount.id }).forUpdate().first();
    if (!link || link.status !== 'attached') throw new errors.VoucherNoLongerAvailableError('missing', discount.id);
    const outletIds = await outletIdsOf(trx, link.voucher_id);
    // The voucher row is locked for the rest of this transaction, so two registers redeeming the last use serialise here:
    // the second sees the first's count and is refused. (A locking read: a plain one would show the transaction's older
    // snapshot, taken before the lock was granted.)
    const voucher = await trx.table('vouchers').where({ id: link.voucher_id }).forUpdate().first();
    const reason = problemFor(voucher, { outletId, businessDate, outletIds });
    if (reason) throw new errors.VoucherNoLongerAvailableError(reason, discount.id);
    await trx.table('vouchers').where({ id: voucher.id }).update({ used_count: Number(voucher.used_count) + 1 });
    await trx.table('voucher_redemptions').where({ id: link.id }).update({ status: 'redeemed', amount: amounts.get(String(discount.id)) ?? '0.00', redeemed_at: new Date() });
    await recordAuditEntry(trx, {
      entityType: 'vouchers',
      entityId: link.voucher_id,
      propertyId,
      userId,
      action: 'voucher_redeemed',
      source: 'api',
      afterState: { discountId: String(discount.id), orderId: String(orderId), code: link.code, amount: amounts.get(String(discount.id)) ?? '0.00' },
    });
    redeemed.push({ discountId: discount.id, voucherId: link.voucher_id });
  }
  return redeemed;
}

/** Records which settlement a redeemed voucher paid for (the check's first), once the settlement row exists. */
async function linkSettlement(trx, { discountIds, settlementId }) {
  if (discountIds.length === 0) return;
  await trx.table('voucher_redemptions').whereIn('discount_id', discountIds).whereNull('settlement_id').update({ settlement_id: settlementId });
}

/**
 * Called wherever a settlement is voided (a Register void, a full gateway refund, an online sale void). Gives the use
 * back when this was the last standing settlement carrying the voucher (a split check shares one use). The decrement is
 * guarded (never below zero) and changes nothing but the count: a voucher that expired or was disabled meanwhile stays
 * exactly as invalid as it was.
 */
async function restoreForSettlement(trx, { settlementId, userId = null }) {
  const frozen = await trx.table('settlement_discounts').where({ settlement_id: settlementId, kind: VOUCHER_KIND });
  for (const part of frozen) {
    const standing = await trx
      .table('settlement_discounts')
      .joinScoped('pos_order_settlements', (join) => join.on('pos_order_settlements.id', '=', 'settlement_discounts.settlement_id'))
      .where({ 'settlement_discounts.discount_id': part.discount_id })
      .whereNot('settlement_discounts.settlement_id', settlementId)
      .whereNull('pos_order_settlements.voided_at')
      .first('settlement_discounts.id');
    if (standing) continue;
    const link = await trx.table('voucher_redemptions').where({ discount_id: part.discount_id, status: 'redeemed' }).forUpdate().first();
    if (!link) continue;
    await trx.table('voucher_redemptions').where({ id: link.id }).update({ status: 'reversed', reversed_at: new Date() });
    // Locked, and floored at zero. Only the count moves: dates, state and use limit are never touched, so a voucher that
    // expired or was disabled meanwhile is exactly as unusable as it was.
    const voucher = await trx.table('vouchers').where({ id: link.voucher_id }).forUpdate().first();
    await trx.table('vouchers').where({ id: voucher.id }).update({ used_count: Math.max(0, Number(voucher.used_count) - 1) });
    await recordAuditEntry(trx, {
      entityType: 'vouchers',
      entityId: link.voucher_id,
      propertyId: part.property_id,
      userId,
      action: 'voucher_redemption_reversed',
      source: userId ? 'api' : 'job',
      afterState: { discountId: String(part.discount_id), settlementId: String(settlementId), code: link.code, amount: link.amount },
    });
  }
}

/** A voucher taken off the check before it settled frees its attachment (no use was ever counted). */
async function releaseForDiscount(trx, discountId) {
  await trx.table('voucher_redemptions').where({ discount_id: discountId, status: 'attached' }).update({ status: 'released' });
}

/** Voucher codes by discount id, for receipts and reports. */
async function codesForDiscounts(db, discountIds) {
  if (discountIds.length === 0) return new Map();
  const rows = await db.table('voucher_redemptions').whereIn('discount_id', discountIds).select('discount_id', 'code');
  return new Map(rows.map((row) => [String(row.discount_id), row.code]));
}

module.exports = { VOUCHER_KIND, problemFor, previewProblem, lockVouchersFirst, redeemForOrder, linkSettlement, restoreForSettlement, releaseForDiscount, liveVoucherDiscounts, outletIdsOf, propertyBusinessDate, codesForDiscounts };
