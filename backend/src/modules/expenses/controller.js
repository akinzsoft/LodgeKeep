'use strict';

/**
 * HTTP layer for the expenses module — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`. Mirrors `stock/controller.js`'s exact conventions.
 *
 * `recordExpense`/`voidExpense` go through `runIdempotentMutation` — both
 * are real financial mutations (ARCHITECTURE.md §7). Category CRUD and
 * recurring-schedule CRUD/pause/resume are not idempotency-gated — each is
 * either plain configuration (naturally idempotent on retry) or already
 * made safe by its own upsert/lock shape, the same `pos.stock_manage`
 * precedent this module's routes mirror.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { runIdempotentMutation } = require('../../shared/mutation');
const { toCsv } = require('../reporting/service');
const service = require('./service');
const reporting = require('./reporting');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

function optionalSortOrder(body) {
  if (body?.sort_order === undefined || body?.sort_order === null || body?.sort_order === '') return undefined;
  const value = Number(body.sort_order);
  return Number.isInteger(value) ? value : Number.NaN;
}

// ---------------------------------------------------------------------
// Expense categories
// ---------------------------------------------------------------------

async function listExpenseCategories(req, res, next) {
  try {
    const includeArchived = req.query.include_archived === 'true';
    res.status(200).json(ok(await service.listExpenseCategories({ context: req.context, includeArchived })));
  } catch (error) {
    next(error);
  }
}

async function createExpenseCategory(req, res, next) {
  try {
    const category = await service.createExpenseCategory({ context: req.context, name: req.body?.name, sortOrder: optionalSortOrder(req.body) });
    await req.audit({ entityType: 'expense_categories', entityId: category.id, action: 'create', afterState: category });
    res.status(201).json(ok(category));
  } catch (error) {
    next(error);
  }
}

async function updateExpenseCategory(req, res, next) {
  try {
    const before = await service.getExpenseCategory({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const category = await service.updateExpenseCategory({ context: req.context, id: req.params.id, name: req.body?.name, sortOrder: optionalSortOrder(req.body) });
    if (!category) return notFound(res);
    await req.audit({ entityType: 'expense_categories', entityId: category.id, action: 'update', beforeState: before, afterState: category });
    res.status(200).json(ok(category));
  } catch (error) {
    next(error);
  }
}

async function archiveExpenseCategory(req, res, next) {
  try {
    const before = await service.getExpenseCategory({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const category = await service.archiveExpenseCategory({ context: req.context, id: req.params.id });
    if (!category) return notFound(res);
    await req.audit({ entityType: 'expense_categories', entityId: category.id, action: 'archive', beforeState: before, afterState: category });
    res.status(200).json(ok(category));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------

async function listExpenses(req, res, next) {
  try {
    res.status(200).json(
      ok(
        await service.listExpenses({
          context: req.context,
          categoryId: req.query.category_id,
          dateFrom: req.query.date_from,
          dateTo: req.query.date_to,
          paymentMethod: req.query.payment_method,
          includeVoided: req.query.include_voided === 'true',
        })
      )
    );
  } catch (error) {
    next(error);
  }
}

async function getExpense(req, res, next) {
  try {
    const expense = await service.getExpense({ context: req.context, id: req.params.id });
    if (!expense) return notFound(res);
    res.status(200).json(ok(expense));
  } catch (error) {
    next(error);
  }
}

async function recordExpense(req, res, next) {
  try {
    const expenseCategoryId = require_(req.body, 'expense_category_id');
    const description = require_(req.body, 'description');
    const amount = require_(req.body, 'amount');
    const currency = require_(req.body, 'currency');
    const paymentMethod = require_(req.body, 'payment_method');
    await runIdempotentMutation(req, res, {
      operationType: 'expenses.record',
      entityType: 'expenses',
      action: 'record',
      handler: async (trx) => {
        const property = await trx.table('properties').first('current_business_date');
        const expense = await service.recordExpense({
          trx,
          expenseCategoryId,
          description,
          payee: req.body?.payee,
          amount,
          currency,
          paymentMethod,
          // Confirmed decision: backdating up to (never past) today is
          // allowed — defaults to the property's current business date,
          // never forced.
          businessDate: req.body?.business_date || property?.current_business_date,
          userId: req.context.userId,
        });
        return { status: 201, body: ok(expense) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function voidExpense(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    await runIdempotentMutation(req, res, {
      operationType: 'expenses.void',
      entityType: 'expenses',
      entityId: req.params.id,
      action: 'void',
      handler: async (trx) => {
        const expense = await service.voidExpense({ trx, id: req.params.id, reason, userId: req.context.userId });
        return { status: 200, body: ok(expense) };
      },
    });
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Recurring expense schedules
// ---------------------------------------------------------------------

async function listRecurringExpenseSchedules(req, res, next) {
  try {
    res.status(200).json(ok(await service.listRecurringExpenseSchedules({ context: req.context, status: req.query.status })));
  } catch (error) {
    next(error);
  }
}

async function getRecurringExpenseSchedule(req, res, next) {
  try {
    const schedule = await service.getRecurringExpenseSchedule({ context: req.context, id: req.params.id });
    if (!schedule) return notFound(res);
    res.status(200).json(ok(schedule));
  } catch (error) {
    next(error);
  }
}

async function createRecurringExpenseSchedule(req, res, next) {
  try {
    const schedule = await service.createRecurringExpenseSchedule({
      context: req.context,
      expenseCategoryId: require_(req.body, 'expense_category_id'),
      description: require_(req.body, 'description'),
      payee: req.body?.payee,
      amount: require_(req.body, 'amount'),
      currency: require_(req.body, 'currency'),
      paymentMethod: require_(req.body, 'payment_method'),
      frequency: require_(req.body, 'frequency'),
      dayOfMonth: req.body?.day_of_month !== undefined ? Number(req.body.day_of_month) : undefined,
      dayOfWeek: req.body?.day_of_week !== undefined ? Number(req.body.day_of_week) : undefined,
      startDate: req.body?.start_date,
      userId: req.context.userId,
    });
    await req.audit({ entityType: 'recurring_expense_schedules', entityId: schedule.id, action: 'create', afterState: schedule });
    res.status(201).json(ok(schedule));
  } catch (error) {
    next(error);
  }
}

function pickRecurringScheduleChanges(body) {
  const changes = {};
  if (body?.expense_category_id !== undefined) changes.expenseCategoryId = body.expense_category_id;
  if (body?.description !== undefined) changes.description = body.description;
  if (body?.payee !== undefined) changes.payee = body.payee;
  if (body?.amount !== undefined) changes.amount = body.amount;
  if (body?.currency !== undefined) changes.currency = body.currency;
  if (body?.payment_method !== undefined) changes.paymentMethod = body.payment_method;
  if (body?.frequency !== undefined) changes.frequency = body.frequency;
  if (body?.day_of_month !== undefined) changes.dayOfMonth = body.day_of_month === null ? null : Number(body.day_of_month);
  if (body?.day_of_week !== undefined) changes.dayOfWeek = body.day_of_week === null ? null : Number(body.day_of_week);
  return changes;
}

async function updateRecurringExpenseSchedule(req, res, next) {
  try {
    const before = await service.getRecurringExpenseSchedule({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const schedule = await service.updateRecurringExpenseSchedule({ context: req.context, id: req.params.id, changes: pickRecurringScheduleChanges(req.body) });
    await req.audit({ entityType: 'recurring_expense_schedules', entityId: req.params.id, action: 'update', beforeState: before, afterState: schedule });
    res.status(200).json(ok(schedule));
  } catch (error) {
    next(error);
  }
}

async function pauseRecurringExpenseSchedule(req, res, next) {
  try {
    const before = await service.getRecurringExpenseSchedule({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const schedule = await service.pauseRecurringExpenseSchedule({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'recurring_expense_schedules', entityId: req.params.id, action: 'pause', beforeState: before, afterState: schedule });
    res.status(200).json(ok(schedule));
  } catch (error) {
    next(error);
  }
}

async function resumeRecurringExpenseSchedule(req, res, next) {
  try {
    const before = await service.getRecurringExpenseSchedule({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const schedule = await service.resumeRecurringExpenseSchedule({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'recurring_expense_schedules', entityId: req.params.id, action: 'resume', beforeState: before, afterState: schedule });
    res.status(200).json(ok(schedule));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------

async function getExpenseReport(req, res, next) {
  try {
    const dateFrom = require_(req.query, 'date_from');
    const dateTo = require_(req.query, 'date_to');
    const report = await reporting.computeExpenseReport({ context: req.context, dateFrom, dateTo, categoryId: req.query.category_id });
    if (req.query?.format === 'csv') {
      res
        .status(200)
        .set('Content-Type', 'text/csv')
        .set('Content-Disposition', 'attachment; filename="expense-report.csv"')
        .send(toCsv(report.expenses, ['businessDate', 'description', 'payee', 'categoryName', 'paymentMethod', 'amount', 'currency', 'source']));
      return;
    }
    res.status(200).json(ok(report));
  } catch (error) {
    next(error);
  }
}

async function getProfitSummary(req, res, next) {
  try {
    const dateFrom = require_(req.query, 'date_from');
    const dateTo = require_(req.query, 'date_to');
    const summary = await reporting.computeProfitSummary({ context: req.context, dateFrom, dateTo });
    if (req.query?.format === 'csv') {
      res
        .status(200)
        .set('Content-Type', 'text/csv')
        .set('Content-Disposition', 'attachment; filename="profit-summary.csv"')
        .send(toCsv(summary.byDay, ['date', 'roomRevenue', 'posRevenue', 'totalRevenue', 'totalExpenses', 'profit', 'audited']));
      return;
    }
    res.status(200).json(ok(summary));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  archiveExpenseCategory,
  listExpenses,
  getExpense,
  recordExpense,
  voidExpense,
  listRecurringExpenseSchedules,
  getRecurringExpenseSchedule,
  createRecurringExpenseSchedule,
  updateRecurringExpenseSchedule,
  pauseRecurringExpenseSchedule,
  resumeRecurringExpenseSchedule,
  getExpenseReport,
  getProfitSummary,
};
