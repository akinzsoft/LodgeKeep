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
const { computeDailyPosRevenueTotals } = require('../pos/sales-report');
const { computeCostOfSales } = require('../stock/reporting');

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

  const [revenueDays, posRevenueByDate, costOfSales, expenseRows] = await Promise.all([
    computeRevenue({ context, dateFrom, dateTo }),
    computeDailyPosRevenueTotals({ db, dateFrom, dateTo }),
    computeCostOfSales({ context, dateFrom, dateTo }),
    listExpenseRowsWithCategory({ db, dateFrom, dateTo }),
  ]);

  const roomRevenue = sumMoney(revenueDays.map((day) => day.roomRevenue));
  const posRevenue = sumMoney([...posRevenueByDate.values()]);
  const totalRevenue = sumMoney([roomRevenue, posRevenue]);
  const roomRevenueFullyAudited = revenueDays.length > 0 && revenueDays.every((day) => day.audited);

  const grossProfit = sumMoney([totalRevenue, negateMoney(costOfSales.totalCost)]);

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

  return {
    dateFrom,
    dateTo,
    currency: property?.base_currency ?? null,
    revenue: { roomRevenue, posRevenue, totalRevenue, roomRevenueFullyAudited },
    costOfSales: costOfSales.totalCost,
    grossProfit,
    operatingExpenses: { byCategory: operatingExpensesByCategory, total: totalOperatingExpenses },
    netProfit,
  };
}

module.exports = { computeExpenseReport, computeProfitAndLoss };
