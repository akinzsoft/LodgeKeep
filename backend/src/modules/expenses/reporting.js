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
 * Confirmed scope: profit = (room revenue + POS revenue) minus operating
 * expenses ONLY. POS's own cost-of-sales/margin report
 * (`stock/reporting.js`) stays a separate, more granular view — not netted
 * out here, to avoid double-counting and to keep this report answering
 * exactly the plain question it was built for.
 *
 * The `audited` flag on each `byDay` row reflects ONLY the room-revenue
 * half (`computeRevenue`'s own per-day flag, sourced from `daily_reports`
 * once Night Audit has closed a date) — POS revenue and expenses have NO
 * audited-snapshot equivalent (POS's own Night Audit reconciliation step is
 * still unbuilt; expenses predate any snapshot mechanism entirely), so
 * `posRevenue`/`totalExpenses` on that same day are ALWAYS freshly
 * live-computed regardless of the flag. Never read `audited: true` here as
 * "the whole day's profit figure is reconciled" — it names the room-revenue
 * figure only.
 *
 * Currency: `expenses.currency` is enforced equal to the property's
 * `base_currency` at record time (`service.js`'s `recordExpense`), so
 * profit is always single-currency by construction — no
 * `revenueByCurrency`-style grouping is needed the way chain-overview needs
 * one across properties.
 */

const { scopedDb } = require('../../db');
const { sumMoney, negateMoney } = require('../../shared/money');
const { computeRevenue, inclusiveDateRange } = require('../reporting/service');
const { computeDailyPosRevenueTotals } = require('../pos/sales-report');

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

/** Revenue minus operating expenses, per day and totalled — the plain question a hotel owner is asking (confirmed scope). */
async function computeProfitSummary({ context, dateFrom, dateTo }) {
  const db = scopedDb().for(context);
  const property = await db.table('properties').first('base_currency');
  const dates = inclusiveDateRange(dateFrom, dateTo);

  const [revenueDays, posRevenueByDate, expenseRows] = await Promise.all([
    computeRevenue({ context, dateFrom, dateTo }),
    computeDailyPosRevenueTotals({ db, dateFrom, dateTo }),
    listExpenseRowsWithCategory({ db, dateFrom, dateTo }),
  ]);
  const revenueByDate = new Map(revenueDays.map((day) => [day.date, day]));

  const expensesByDate = new Map();
  const expensesByCategoryMap = new Map();
  for (const row of expenseRows) {
    const dateKey = String(row.business_date);
    if (!expensesByDate.has(dateKey)) expensesByDate.set(dateKey, []);
    expensesByDate.get(dateKey).push(row.amount);

    const categoryKey = String(row.category_id);
    if (!expensesByCategoryMap.has(categoryKey)) expensesByCategoryMap.set(categoryKey, { categoryId: row.category_id, categoryName: row.category_name, amounts: [], count: 0 });
    const bucket = expensesByCategoryMap.get(categoryKey);
    bucket.amounts.push(row.amount);
    bucket.count += 1;
  }

  const byDay = dates.map((date) => {
    const revenueDay = revenueByDate.get(date);
    const roomRevenue = revenueDay?.roomRevenue ?? '0.00';
    const posRevenue = posRevenueByDate.get(date) ?? '0.00';
    const totalRevenue = sumMoney([roomRevenue, posRevenue]);
    const totalExpenses = sumMoney(expensesByDate.get(date) ?? []);
    const profit = sumMoney([totalRevenue, negateMoney(totalExpenses)]);
    return { date, roomRevenue, posRevenue, totalRevenue, totalExpenses, profit, audited: revenueDay?.audited ?? false };
  });

  const totals = byDay.reduce(
    (acc, day) => ({
      roomRevenue: sumMoney([acc.roomRevenue, day.roomRevenue]),
      posRevenue: sumMoney([acc.posRevenue, day.posRevenue]),
      totalRevenue: sumMoney([acc.totalRevenue, day.totalRevenue]),
      totalExpenses: sumMoney([acc.totalExpenses, day.totalExpenses]),
      profit: sumMoney([acc.profit, day.profit]),
    }),
    { roomRevenue: '0.00', posRevenue: '0.00', totalRevenue: '0.00', totalExpenses: '0.00', profit: '0.00' }
  );

  return {
    dateFrom,
    dateTo,
    currency: property?.base_currency ?? null,
    totals,
    byDay,
    expensesByCategory: [...expensesByCategoryMap.values()]
      .map(({ categoryId, categoryName, amounts, count }) => ({ categoryId, categoryName, total: sumMoney(amounts), count }))
      .sort((a, b) => a.categoryName.localeCompare(b.categoryName)),
  };
}

module.exports = { computeExpenseReport, computeProfitSummary };
