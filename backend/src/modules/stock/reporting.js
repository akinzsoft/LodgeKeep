'use strict';

/**
 * Stock reporting — PLAN.md Phase 6. Both reads are `pos.stock_manage`-gated
 * (route layer) — a cost/margin figure is a manager-tier concern, matching
 * this pass's own confirmed RBAC split (stock CRUD/goods-received/stock-take
 * lifecycle are all `pos.stock_manage` too).
 */

const { scopedDb } = require('../../db');
const { sumMoney, negateMoney } = require('../../shared/money');
const { sumQuantity } = require('../../shared/quantity');

/**
 * Cost of sales — the real cost side of every `sold`/`sale_reversal`
 * `stock_movements` row in range. `sale_reversal` is included
 * deliberately, not just `sold`: a settlement voided mid-period must
 * reduce the period's cost-of-sales exactly as much as the original sale
 * increased it (the two rows are, by construction, equal and opposite —
 * `reverseStockForSettlement` preserves the original's own cost basis).
 * Grouped both per stock item (drill-down) and per day (trend), the same
 * "a breakdown alongside a total" shape `reporting/service.js`'s own
 * `computeOccupancy`/`computeRevenue` already establish.
 *
 * `stock_movements.total_cost` is signed to match `quantity` — a `sold`
 * row's own total_cost is negative (it decreases current_quantity). This
 * report negates the aggregate so the reported figure reads as a
 * conventional positive cost, not the ledger's own signed convention.
 */
async function computeCostOfSales({ context, dateFrom, dateTo, outletId }) {
  const db = scopedDb().for(context);
  let query = db
    .table('stock_movements')
    .whereIn('type', ['sold', 'sale_reversal'])
    .whereBetween('business_date', [dateFrom, dateTo]);
  if (outletId) query = query.where({ outlet_id: outletId });
  const rows = await query.select('stock_item_id', 'business_date', 'total_cost');

  const byItem = new Map();
  const byDay = new Map();
  for (const row of rows) {
    const cost = row.total_cost ?? '0.00';
    const itemKey = String(row.stock_item_id);
    byItem.set(itemKey, sumMoney([byItem.get(itemKey) ?? '0.00', cost]));
    const dayKey = String(row.business_date);
    byDay.set(dayKey, sumMoney([byDay.get(dayKey) ?? '0.00', cost]));
  }

  // `stockItemId` stays a STRING throughout, matching ARCHITECTURE.md §10
  // ("IDs are serialized as strings in JSON") and this connection's own
  // `bigNumberStrings: true` setting — every BIGINT id already round-trips
  // as a string end to end, so coercing it to a JS number here would make
  // this one field the odd one out against every id a caller already
  // holds from an earlier response.
  const byItemArray = [...byItem.entries()]
    .map(([stockItemId, total]) => ({ stockItemId, cost: negateMoney(total) }))
    .sort((a, b) => Number(a.stockItemId) - Number(b.stockItemId));
  const byDayArray = [...byDay.entries()]
    .map(([date, total]) => ({ date, cost: negateMoney(total) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totalCost = negateMoney(sumMoney(rows.map((row) => row.total_cost ?? '0.00')));

  return { dateFrom, dateTo, outletId: outletId ?? null, totalCost, byItem: byItemArray, byDay: byDayArray };
}

/**
 * Stock variance — every COMPLETED stock take's own lines in range
 * (`stock_takes.business_date`, set only at completion — an open or
 * cancelled take contributes nothing). Individual lines for drill-down,
 * plus a per-item summary total variance across every completed take in
 * range, the same "breakdown plus summary" shape `computeCostOfSales`
 * above uses.
 */
async function computeStockVariance({ context, dateFrom, dateTo, outletId }) {
  const db = scopedDb().for(context);
  let query = db
    .table('stock_take_lines')
    .joinScoped('stock_takes', (join) => join.on('stock_takes.id', '=', 'stock_take_lines.stock_take_id'))
    .where('stock_takes.status', 'completed')
    .whereBetween('stock_takes.business_date', [dateFrom, dateTo]);
  if (outletId) query = query.where('stock_takes.outlet_id', outletId);

  const rows = await query.select(
    'stock_take_lines.id as line_id',
    'stock_take_lines.stock_take_id as stock_take_id',
    'stock_take_lines.stock_item_id as stock_item_id',
    'stock_take_lines.counted_quantity as counted_quantity',
    'stock_take_lines.theoretical_quantity as theoretical_quantity',
    'stock_take_lines.variance as variance',
    'stock_takes.business_date as business_date'
  );

  const summaryByItem = new Map();
  for (const row of rows) {
    const key = String(row.stock_item_id);
    summaryByItem.set(key, sumQuantity([summaryByItem.get(key) ?? '0.000', row.variance ?? '0.000']));
  }

  return {
    dateFrom,
    dateTo,
    outletId: outletId ?? null,
    lines: rows,
    summaryByItem: [...summaryByItem.entries()]
      .map(([stockItemId, totalVariance]) => ({ stockItemId, totalVariance }))
      .sort((a, b) => Number(a.stockItemId) - Number(b.stockItemId)),
  };
}

module.exports = { computeCostOfSales, computeStockVariance };
