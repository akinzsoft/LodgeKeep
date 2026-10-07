'use strict';

/**
 * Expense/profit reporting — lives here, in `expenses`, not in the generic
 * `reporting` module, mirroring `stock/reporting.js`'s own precedent
 * exactly: "profit" is fundamentally this module's own reason to exist
 * (the whole feature was requested specifically to produce a profit view),
 * so the composed report belongs with expenses, reaching into
 * `reporting/service.js` (`computeRevenue`) and `pos/sales-report.js`
 * (`computeDailyPosRevenueTotals`) the same one-way direction
 * `stock/reporting.js` already reaches into `pos`. Neither `reporting/service.js`
 * nor `pos/sales-report.js` requires anything from `expenses` — no cycle.
 *
 * Confirmed scope for the P&L statement (`computeProfitAndLoss`, restructured
 * on the user's own explicit follow-up request, "restructure it like a
 * proper P&L statement"): the standard shape — Revenue, Cost of Sales,
 * Gross Profit, Operating Expenses (itemized by category), Net Profit —
 * for ONE consolidated period, not a day-by-day table. Cost of Sales is
 * real data already tracked (`stock/reporting.js`'s `computeCostOfSales`,
 * summed across every outlet), composed in here rather than duplicated —
 * this is the one place in this codebase POS's cost-of-sales figure and
 * expense tracking's own operating-expense figure are netted against the
 * SAME revenue total, which is exactly what makes it a real Gross-Profit-
 * then-Net-Profit statement rather than the two staying two separate,
 * never-reconciled reports.
 *
 * Room revenue carries no cost-of-sales component of its own (this
 * codebase tracks no per-room cost) — Cost of Sales applies to POS revenue
 * only, the same real scope `stock/reporting.js`'s own report already has.
 *
 * Cost of Sales = real stock-ledger cost (`computeCostOfSales`, which only
 * exists for menu items with a recipe) PLUS, for sale lines the ledger did
 * not cover, quantity x the item's `cost_price` (`computeCostPriceFallback`,
 * decided per sale from the movements actually written, so the two never
 * count the same sale). `costOfSalesFromCostPrice` is that second part,
 * shown on its own because it is an estimate at the item's CURRENT
 * cost price, not ledger-backed. `itemsSoldWithoutCost` counts items sold
 * with no cost anywhere (no ledger movement, no cost price, or an
 * ambiguous case), whose cost is still missing from Cost of Sales.
 *
 * Revenue = room + POS + Other income, where Other income is the non-voided
 * folio `adjustment` lines in range (`cashiering`'s `listOtherFolioIncome`:
 * fees add, discounts subtract; `pos_charge`, `room_charge`, tax, payments
 * and POS tip/service adjustments are excluded so nothing counts twice).
 * Adjustment lines in a non-base currency are not summed and are counted in
 * `adjustmentsInOtherCurrency`.
 *
 * `roomRevenueAudited` / `roomRevenueEstimated` split room revenue into the
 * Night Audit snapshot (actual) and the live booked-rate estimate for
 * unaudited days; they add up to `roomRevenue`. `estimateVariance` lists the
 * unaudited days whose estimate differs from the room charges actually
 * posted for that date (a diagnostic only: no total uses it, and nights after
 * the current business date still count as before).
 *
 * `unauditedDates` names the exact days in range with no Night Audit
 * snapshot, so the caveat can say which days instead of a bare "not fully
 * reconciled". Revenue computation is not affected by it.
 *
 * `roomRevenueFullyAudited` is a single, honest boolean for the whole
 * period — true only when EVERY day in range has already been closed by
 * Night Audit (`computeRevenue`'s own per-day `audited` flag, sourced from
 * `daily_reports`) — never fabricated as an average or a per-line
 * caveat. Cost of Sales, POS revenue, and operating expenses have no
 * audited-snapshot equivalent at all (POS's own Night Audit reconciliation
 * step is still unbuilt; expenses predate any snapshot mechanism
 * entirely) — they are always freshly live-computed regardless of this
 * flag, which names the room-revenue component only.
 *
 * Currency: `expenses.currency` is enforced equal to the property's
 * `base_currency` at record time (`service.js`'s `recordExpense`), so this
 * statement is always single-currency by construction — no
 * `revenueByCurrency`-style grouping is needed the way chain-overview needs
 * one across properties.
 */

const { scopedDb } = require('../../db');
const { sumMoney, negateMoney, compareMoney } = require('../../shared/money');
const { computeRevenue } = require('../reporting/service');
const { computeDailyPosRevenueTotals, computeOutletRevenueTotals } = require('../pos/sales-report');
const { isPointOfSaleOutlet, isSupermarketOutlet } = require('../../shared/outlet-types');
const { listOtherFolioIncome, sumPostedRoomChargesByDate } = require('../cashiering/service');
const { computeCostOfSales, computeCostPriceFallback } = require('../stock/reporting');

/** Every non-voided expense in range, joined to its category name. */
async function listExpenseRowsWithCategory({ db, dateFrom, dateTo, categoryId }) {
  let query = db
    .table('expenses')
    .joinScoped('expense_categories', (join) => join.on('expense_categories.id', '=', 'expenses.expense_category_id'))
    .whereNull('expenses.voided_at')
    .whereBetween('expenses.business_date', [dateFrom, dateTo]);
  if (categoryId) query = query.where('expenses.expense_category_id', categoryId);
  return query
    .orderBy('expenses.business_date', 'desc')
    .select(
      'expenses.id as id',
      'expenses.description as description',
      'expenses.payee as payee',
      'expenses.amount as amount',
      'expenses.currency as currency',
      'expenses.payment_method as payment_method',
      'expenses.business_date as business_date',
      'expenses.source as source',
      'expenses.expense_category_id as category_id',
      'expense_categories.name as category_name'
    );
}

/** Expense report — by category and by period (an explicit date range; "by property" is inherent since every report is already scoped to the caller's one active property). */
async function computeExpenseReport({ context, dateFrom, dateTo, categoryId }) {
  const db = scopedDb().for(context);
  const property = await db.table('properties').first('base_currency');
  const rows = await listExpenseRowsWithCategory({ db, dateFrom, dateTo, categoryId });

  const byCategoryMap = new Map();
  for (const row of rows) {
    const key = String(row.category_id);
    if (!byCategoryMap.has(key)) byCategoryMap.set(key, { categoryId: row.category_id, categoryName: row.category_name, amounts: [], count: 0 });
    const bucket = byCategoryMap.get(key);
    bucket.amounts.push(row.amount);
    bucket.count += 1;
  }

  return {
    dateFrom,
    dateTo,
    currency: property?.base_currency ?? null,
    totalExpenses: sumMoney(rows.map((row) => row.amount)),
    byCategory: [...byCategoryMap.values()]
      .map(({ categoryId: id, categoryName, amounts, count }) => ({ categoryId: id, categoryName, total: sumMoney(amounts), count }))
      .sort((a, b) => a.categoryName.localeCompare(b.categoryName)),
    expenses: rows.map((row) => ({
      id: row.id,
      description: row.description,
      payee: row.payee,
      amount: row.amount,
      currency: row.currency,
      paymentMethod: row.payment_method,
      businessDate: row.business_date,
      categoryName: row.category_name,
      source: row.source,
    })),
  };
}

/** Gross margin as a display-only percentage with one decimal, or null when there is no revenue to divide by. */
function marginPct(grossProfit, revenue) {
  if (compareMoney(revenue, '0.00') <= 0) return null;
  return Math.round((Number(grossProfit) / Number(revenue)) * 1000) / 10;
}

/**
 * The statement regrouped by department (revenue centre): Rooms, then each selling outlet by name, then each
 * supermarket outlet, then (only when non-zero) Other income and Other / unmapped. This only REGROUPS the numbers
 * the statement already has, it never recomputes them: revenue per outlet is the same standing-settlement subtotal
 * summed by outlet, cost per outlet is the same stock-ledger cost and `cost_price` fallback grouped by the selling
 * outlet. A tab charged to a room counts for the outlet that sold it ("Rooms" is room-nights only). Anything that
 * cannot be mapped to a current point-of-sale outlet (a missing outlet, a store, no outlet) is NOT forced into a
 * department: it sits on its own "Other / unmapped" line, so `totals` always equals the statement's totals
 * (`reconciles` says so).
 *
 * Per department: `itemsSoldWithoutCost` / `costIncomplete` (its gross profit is overstated by that department's
 * unpriced items) and `costExceedsRevenue` (a cost price or stock cost worth checking). Rooms carry no cost of sales.
 */
function buildDepartments({ outlets, roomRevenue, outletRevenue, ledger, fallback, otherIncomeTotal, totals }) {
  const outletById = new Map(outlets.map((outlet) => [String(outlet.id), outlet]));
  const mappable = (key) => {
    const outlet = outletById.get(key);
    return outlet && isPointOfSaleOutlet(outlet) ? outlet : null;
  };

  // key -> { revenue, ledger, fallback, withoutCost }; key '' (or any unmappable id) collects into 'unmapped'.
  const buckets = new Map();
  const bucketFor = (rawKey) => {
    const key = mappable(String(rawKey ?? '')) ? String(rawKey) : 'unmapped';
    if (!buckets.has(key)) buckets.set(key, { revenue: [], ledger: [], fallback: [], withoutCost: 0 });
    return buckets.get(key);
  };
  for (const [outletKey, amount] of outletRevenue) bucketFor(outletKey).revenue.push(amount);
  for (const row of ledger.byOutlet) bucketFor(row.outletId).ledger.push(row.cost);
  for (const row of fallback.byOutlet) {
    const bucket = bucketFor(row.outletId);
    bucket.fallback.push(row.cost);
    bucket.withoutCost += row.itemsWithoutCost;
  }

  const rows = [];
  const describe = (row) => {
    const grossProfit = sumMoney([row.revenue, negateMoney(row.costOfSales)]);
    return {
      ...row,
      grossProfit,
      marginPct: marginPct(grossProfit, row.revenue),
      costIncomplete: (row.itemsSoldWithoutCost ?? 0) > 0,
      costExceedsRevenue: compareMoney(row.costOfSales, '0.00') > 0 && compareMoney(row.costOfSales, row.revenue) > 0,
    };
  };

  rows.push(describe({ key: 'rooms', kind: 'rooms', outletId: null, name: 'Rooms', revenue: roomRevenue, costOfSales: '0.00', costOfSalesFromCostPrice: '0.00', itemsSoldWithoutCost: 0 }));

  const outletRows = [];
  for (const [key, bucket] of buckets) {
    if (key === 'unmapped') continue;
    const outlet = outletById.get(key);
    outletRows.push(
      describe({
        key: `outlet:${key}`,
        kind: isSupermarketOutlet(outlet) ? 'supermarket' : 'outlet',
        outletId: key,
        name: outlet.name,
        outletStatus: outlet.status,
        revenue: sumMoney(bucket.revenue),
        costOfSales: sumMoney([...bucket.ledger, ...bucket.fallback]),
        costOfSalesFromCostPrice: sumMoney(bucket.fallback),
        itemsSoldWithoutCost: bucket.withoutCost,
      })
    );
  }
  const kindOrder = { outlet: 0, supermarket: 1 };
  outletRows.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name));
  rows.push(...outletRows);

  if (compareMoney(otherIncomeTotal, '0.00') !== 0) {
    rows.push(describe({ key: 'other_income', kind: 'other_income', outletId: null, name: 'Other income (fees and discounts)', revenue: otherIncomeTotal, costOfSales: '0.00', costOfSalesFromCostPrice: '0.00', itemsSoldWithoutCost: 0 }));
  }
  const unmapped = buckets.get('unmapped');
  if (unmapped) {
    rows.push(
      describe({
        key: 'unmapped',
        kind: 'unmapped',
        outletId: null,
        name: 'Other / unmapped',
        revenue: sumMoney(unmapped.revenue),
        costOfSales: sumMoney([...unmapped.ledger, ...unmapped.fallback]),
        costOfSalesFromCostPrice: sumMoney(unmapped.fallback),
        itemsSoldWithoutCost: unmapped.withoutCost,
      })
    );
  }

  const departmentTotals = {
    revenue: sumMoney(rows.map((row) => row.revenue)),
    costOfSales: sumMoney(rows.map((row) => row.costOfSales)),
    grossProfit: sumMoney(rows.map((row) => row.grossProfit)),
  };
  const shown = new Set(outletRows.map((row) => row.outletId));
  const quietOutlets = outlets.filter((outlet) => outlet.status === 'active' && isPointOfSaleOutlet(outlet) && !shown.has(String(outlet.id))).map((outlet) => outlet.name).sort((a, b) => a.localeCompare(b));

  return {
    rows,
    totals: departmentTotals,
    quietOutlets,
    reconciles:
      compareMoney(departmentTotals.revenue, totals.revenue) === 0 &&
      compareMoney(departmentTotals.costOfSales, totals.costOfSales) === 0 &&
      compareMoney(departmentTotals.grossProfit, totals.grossProfit) === 0,
  };
}

/**
 * A proper P&L statement for ONE consolidated period — Revenue, Cost of
 * Sales, Gross Profit, Operating Expenses (itemized by category, largest
 * first — the standard "what matters most" presentation with no chart of
 * accounts to otherwise order them by), Net Profit. See file header for
 * the full reasoning and the confirmed scope behind each line.
 */
async function computeProfitAndLoss({ context, dateFrom, dateTo }) {
  const db = scopedDb().for(context);
  const property = await db.table('properties').first('base_currency');

  const [revenueDays, posRevenueByDate, ledgerCostOfSales, expenseRows, costPriceFallback, otherIncome, outletRevenue, outlets] = await Promise.all([
    computeRevenue({ context, dateFrom, dateTo }),
    computeDailyPosRevenueTotals({ db, dateFrom, dateTo }),
    computeCostOfSales({ context, dateFrom, dateTo }),
    listExpenseRowsWithCategory({ db, dateFrom, dateTo }),
    computeCostPriceFallback({ context, dateFrom, dateTo }),
    listOtherFolioIncome({ db, dateFrom, dateTo, baseCurrency: property?.base_currency }),
    computeOutletRevenueTotals({ db, dateFrom, dateTo }),
    db.table('pos_outlets').select('id', 'name', 'type', 'status'),
  ]);

  const roomRevenue = sumMoney(revenueDays.map((day) => day.roomRevenue));
  const posRevenue = sumMoney([...posRevenueByDate.values()]);
  const totalRevenue = sumMoney([roomRevenue, posRevenue, otherIncome.total]);
  const unauditedDates = revenueDays.filter((day) => !day.audited).map((day) => day.date);
  const roomRevenueFullyAudited = revenueDays.length > 0 && unauditedDates.length === 0;

  // Audited days are the Night Audit snapshot (actual); every other day is a
  // live estimate from booked nightly rates. The two add up to `roomRevenue`.
  const roomRevenueAudited = sumMoney(revenueDays.filter((day) => day.audited).map((day) => day.roomRevenue));
  const roomRevenueEstimated = sumMoney(revenueDays.filter((day) => !day.audited).map((day) => day.roomRevenue));

  // For the estimated days only: where the booked-rate estimate differs from
  // the room charges actually posted for that date, say so. Differences only;
  // a day where they agree is not listed. Nothing here changes any total.
  const postedByDate = await sumPostedRoomChargesByDate({ db, dates: unauditedDates, baseCurrency: property?.base_currency });
  const estimateVarianceDays = revenueDays
    .filter((day) => !day.audited)
    .map((day) => {
      const posted = postedByDate.get(day.date) ?? '0.00';
      return { date: day.date, estimated: day.roomRevenue, posted, difference: sumMoney([day.roomRevenue, negateMoney(posted)]) };
    })
    .filter((day) => compareMoney(day.difference, '0.00') !== 0);

  // Ledger cost (real stock movements) plus, for sale lines the ledger did
  // not cover, quantity x cost_price — see `computeCostPriceFallback` for the
  // per-sale guard that keeps the two from ever counting the same sale.
  const costOfSalesTotal = sumMoney([ledgerCostOfSales.totalCost, costPriceFallback.totalCost]);
  const grossProfit = sumMoney([totalRevenue, negateMoney(costOfSalesTotal)]);

  const expensesByCategoryMap = new Map();
  for (const row of expenseRows) {
    const key = String(row.category_id);
    if (!expensesByCategoryMap.has(key)) expensesByCategoryMap.set(key, { categoryId: row.category_id, categoryName: row.category_name, amounts: [] });
    expensesByCategoryMap.get(key).amounts.push(row.amount);
  }
  const operatingExpensesByCategory = [...expensesByCategoryMap.values()]
    .map(({ categoryId, categoryName, amounts }) => ({ categoryId, categoryName, total: sumMoney(amounts) }))
    .sort((a, b) => compareMoney(b.total, a.total) || a.categoryName.localeCompare(b.categoryName));
  const totalOperatingExpenses = sumMoney(operatingExpensesByCategory.map((row) => row.total));

  const netProfit = sumMoney([grossProfit, negateMoney(totalOperatingExpenses)]);

  const departments = buildDepartments({
    outlets,
    roomRevenue,
    outletRevenue,
    ledger: ledgerCostOfSales,
    fallback: costPriceFallback,
    otherIncomeTotal: otherIncome.total,
    totals: { revenue: totalRevenue, costOfSales: costOfSalesTotal, grossProfit },
  });

  return {
    dateFrom,
    dateTo,
    currency: property?.base_currency ?? null,
    revenue: {
      roomRevenue,
      posRevenue,
      otherIncome: { fees: otherIncome.fees, discounts: otherIncome.discounts, total: otherIncome.total },
      totalRevenue,
      roomRevenueAudited,
      roomRevenueEstimated,
      estimateVariance: { days: estimateVarianceDays, total: sumMoney(estimateVarianceDays.map((day) => day.difference)) },
      roomRevenueFullyAudited,
      unauditedDates,
    },
    adjustmentsInOtherCurrency: otherIncome.otherCurrencyLineCount,
    costOfSales: costOfSalesTotal,
    costOfSalesFromCostPrice: costPriceFallback.totalCost,
    itemsSoldWithoutCost: costPriceFallback.itemsWithoutCost,
    grossProfit,
    operatingExpenses: { byCategory: operatingExpensesByCategory, total: totalOperatingExpenses },
    netProfit,
    departments,
  };
}

module.exports = { computeExpenseReport, computeProfitAndLoss, buildDepartments };
