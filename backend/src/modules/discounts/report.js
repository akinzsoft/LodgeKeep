'use strict';

/**
 * Discounts and comps given, from the amounts frozen on each settlement (`settlement_discounts`) for settlements that
 * are still standing (a voided one drops out). Grouped by reason, giver, approver, outlet and kind, with each as a
 * share of what was sold, so a manager can see who gives what and why. Read-only; nothing is recomputed.
 */

const { ValidationError } = require('../../shared/errors');
const { sumMoney, toCents, fromCents } = require('../../shared/money');
const { effectivePercent } = require('../../shared/discount-pricing');

const MAX_RANGE_DAYS = 92;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertRange(dateFrom, dateTo) {
  if (!ISO_DATE.test(dateFrom ?? '') || !ISO_DATE.test(dateTo ?? '')) {
    throw new ValidationError('INVALID_DATE_RANGE', '"date_from" and "date_to" are required, as YYYY-MM-DD.', [{ field: 'date_from', issue: 'invalid' }]);
  }
  if (dateFrom > dateTo) throw new ValidationError('INVALID_DATE_RANGE', '"date_from" must not be after "date_to".', [{ field: 'date_from', issue: 'after_date_to' }]);
  const days = (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_RANGE_DAYS) throw new ValidationError('INVALID_DATE_RANGE', `The range may be at most ${MAX_RANGE_DAYS} days.`, [{ field: 'date_to', issue: 'too_long' }]);
}

function group(rows, keyOf, labelOf) {
  const map = new Map();
  for (const row of rows) {
    const key = String(keyOf(row));
    const entry = map.get(key) ?? { key, label: labelOf(row), count: 0, total: 0n };
    entry.count += 1;
    entry.total += toCents(row.amount);
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => (a.total === b.total ? a.label.localeCompare(b.label) : a.total > b.total ? -1 : 1)).map((e) => ({ key: e.key, label: e.label, count: e.count, total: fromCents(e.total) }));
}

async function computeDiscountReport({ db, dateFrom, dateTo, outletId = null }) {
  assertRange(dateFrom, dateTo);
  let query = db
    .table('settlement_discounts')
    .joinScoped('pos_order_settlements', (join) => join.on('pos_order_settlements.id', '=', 'settlement_discounts.settlement_id'))
    .whereNull('pos_order_settlements.voided_at')
    .whereBetween('settlement_discounts.business_date', [dateFrom, dateTo])
    .select('settlement_discounts.*', 'pos_order_settlements.pos_order_id as order_id');
  if (outletId) query = query.where({ 'settlement_discounts.outlet_id': outletId });
  const rows = await query.orderBy('settlement_discounts.id', 'asc');

  const userIds = [...new Set(rows.flatMap((row) => [row.applied_by_user_id, row.approved_by_user_id]).filter(Boolean).map(String))];
  const users = userIds.length ? await db.table('users').whereIn('id', userIds).select('id', 'first_name', 'last_name', 'email') : [];
  const userName = new Map(users.map((u) => [String(u.id), [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email]));
  const outletIds = [...new Set(rows.map((row) => String(row.outlet_id)))];
  const outlets = outletIds.length ? await db.table('pos_outlets').whereIn('id', outletIds).select('id', 'name') : [];
  const outletName = new Map(outlets.map((o) => [String(o.id), o.name]));

  let salesQuery = db
    .table('pos_order_settlements')
    .whereNull('voided_at')
    .whereBetween('business_date', [dateFrom, dateTo]);
  if (outletId) {
    const orders = await db.table('pos_orders').where({ outlet_id: outletId }).select('id');
    salesQuery = salesQuery.whereIn('pos_order_id', orders.map((o) => o.id));
  }
  const settlements = await salesQuery.select('subtotal');
  const netSales = sumMoney(settlements.map((s) => s.subtotal));

  const total = sumMoney(rows.map((row) => row.amount));
  const comps = rows.filter((row) => row.kind === 'comp');
  const lines = rows.map((row) => ({
    settlement_id: String(row.settlement_id),
    order_id: String(row.order_id),
    business_date: row.business_date instanceof Date ? row.business_date.toISOString().slice(0, 10) : String(row.business_date ?? ''),
    outlet: outletName.get(String(row.outlet_id)) ?? '',
    kind: row.kind,
    scope: row.scope,
    type: row.type,
    value: String(row.value),
    base_before: String(row.base_before),
    amount: String(row.amount),
    reason: row.reason_name,
    given_by: userName.get(String(row.applied_by_user_id)) ?? '',
    approved_by: row.approved_by_user_id ? userName.get(String(row.approved_by_user_id)) ?? '' : '',
    currency: row.currency,
  }));

  return {
    dateFrom,
    dateTo,
    currency: rows[0]?.currency ?? null,
    summary: {
      count: rows.length,
      total,
      discounts: sumMoney(rows.filter((row) => row.kind === 'discount').map((row) => row.amount)),
      comps: sumMoney(comps.map((row) => row.amount)),
      compCount: comps.length,
      netSales,
      // Of what would have been sold at full price: the discount over (net sales + discounts).
      percentOfSales: effectivePercent({ amount: total, base: sumMoney([netSales, total]) }),
    },
    byReason: group(rows, (r) => r.reason_id, (r) => r.reason_name),
    byGiver: group(rows, (r) => r.applied_by_user_id, (r) => userName.get(String(r.applied_by_user_id)) ?? ''),
    byApprover: group(rows.filter((r) => r.approved_by_user_id), (r) => r.approved_by_user_id, (r) => userName.get(String(r.approved_by_user_id)) ?? ''),
    byOutlet: group(rows, (r) => r.outlet_id, (r) => outletName.get(String(r.outlet_id)) ?? ''),
    byKind: group(rows, (r) => r.kind, (r) => (r.kind === 'comp' ? 'Comps' : 'Discounts')),
    lines,
  };
}

const CSV_COLUMNS = ['business_date', 'outlet', 'kind', 'scope', 'type', 'value', 'base_before', 'amount', 'currency', 'reason', 'given_by', 'approved_by', 'settlement_id', 'order_id'];

module.exports = { computeDiscountReport, CSV_COLUMNS, MAX_RANGE_DAYS };
