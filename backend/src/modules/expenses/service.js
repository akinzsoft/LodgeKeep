'use strict';

/**
 * Expense tracking service — expense categories, the expense ledger, and
 * recurring-expense schedules. Deliberately narrow: expense tracking, not a
 * full double-entry general ledger (no chart of accounts, no journal
 * entries, no trial balance, no balance sheet) — see `reporting.js` for the
 * composed profit view this module exists to feed.
 *
 * `expense_category_id` is a real, live foreign key on `expenses` and
 * `recurring_expense_schedules` — unlike `stock_items.category`/
 * `pos_menu_items.category` (copied name strings), a rename here needs no
 * cascade update, and "category in use" is a plain count query (see the
 * `expense_categories` migration header for the full reasoning).
 *
 * Category is REQUIRED on every expense (see `expenses` migration header).
 *
 * Financial-record immutability (ARCHITECTURE.md §8): `expenses` has no
 * update function — `recordExpense` (create) and `voidExpense` are the
 * only two mutations. A correction is a void (mandatory reason) plus a
 * fresh `recordExpense` call, never an in-place edit.
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { createCategoryCatalogue } = require('../../shared/category-catalogue');
const {
  ExpenseCategoryNotFoundError,
  ExpenseCategoryInUseError,
  ExpenseNotFoundError,
  ExpenseAlreadyVoidedError,
  RecurringExpenseScheduleNotFoundError,
  InvalidRecurrenceConfigError,
  CurrencyMismatchError,
} = require('./errors');
const { computeNextDueDate } = require('./recurrence');

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

// ---------------------------------------------------------------------
// Expense categories
// ---------------------------------------------------------------------

// Gap closure — extracted into a shared factory alongside menu/stock
// categories once this became the third near-identical "registered
// catalogue" implementation; see `shared/category-catalogue.js`'s own
// header for the full reasoning. The live-FK shape (vs. menu/stock's
// copied-name-string one) is expressed via `resolveMode: 'id'` and
// `cascadeRename: null`; the two-table in-use check via a 2-entry
// `inUseChecks` array, positionally matching `ExpenseCategoryInUseError`'s
// own `(name, expenseCount, scheduleCount)` constructor.
const expenseCategoryCatalogue = createCategoryCatalogue({
  table: 'expense_categories',
  resolveMode: 'id',
  cascadeRename: null,
  inUseChecks: [
    { table: 'expenses', matchColumn: 'expense_category_id', matchBy: 'id', filter: (q) => q.whereNull('voided_at') },
    { table: 'recurring_expense_schedules', matchColumn: 'expense_category_id', matchBy: 'id', filter: (q) => q.where({ status: 'active' }) },
  ],
  // Matches the original's own `.whereIn('expense_category_id', rows.map(r => r.id))` —
  // the live-FK shape makes pre-filtering the list-count query to just the
  // rows being listed simpler than menu/stock's own unrestricted scan.
  restrictListCountToRows: true,
  errors: {
    categoryNotFound: () => new ExpenseCategoryNotFoundError(),
    categoryInUse: (name, expenseCount, scheduleCount) => new ExpenseCategoryInUseError(name, expenseCount, scheduleCount),
  },
});

const listExpenseCategories = expenseCategoryCatalogue.listCategories;
const getExpenseCategory = expenseCategoryCatalogue.getCategory;
const createExpenseCategory = expenseCategoryCatalogue.createCategory;
const updateExpenseCategory = expenseCategoryCatalogue.updateCategory;
const archiveExpenseCategory = expenseCategoryCatalogue.archiveCategory;

/**
 * Preserves the exact external signature `{db, expenseCategoryId}` every
 * one of this file's own call sites already uses (recordExpense,
 * createRecurringExpenseSchedule, updateRecurringExpenseSchedule) — none of
 * them need to change. Always required — throws if missing, wrong-tenant,
 * or archived, never stock's optional/nullable shape.
 */
async function resolveExpenseCategoryId({ db, expenseCategoryId }) {
  return expenseCategoryCatalogue.resolveById({ db, id: expenseCategoryId });
}

// ---------------------------------------------------------------------
// Expenses — record + void only, no update (ARCHITECTURE.md §8)
// ---------------------------------------------------------------------

const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'cheque', 'other'];

function cleanAmount(amount) {
  const value = String(amount ?? '').trim();
  if (!AMOUNT_PATTERN.test(value) || Number(value) <= 0) {
    throw new ValidationError('INVALID_AMOUNT', '"amount" must be a positive amount with at most 2 decimal places.', [{ field: 'amount', issue: 'invalid' }]);
  }
  return value;
}

function cleanPaymentMethod(paymentMethod) {
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new ValidationError('INVALID_PAYMENT_METHOD', `"payment_method" must be one of: ${PAYMENT_METHODS.join(', ')}.`, [{ field: 'payment_method', issue: 'invalid' }]);
  }
  return paymentMethod;
}

function cleanDescription(description) {
  const trimmed = typeof description === 'string' ? description.trim() : '';
  if (!trimmed || trimmed.length > 255) {
    throw new ValidationError('INVALID_DESCRIPTION', 'A description is required, up to 255 characters.', [{ field: 'description', issue: trimmed ? 'too_long' : 'missing' }]);
  }
  return trimmed;
}

/**
 * `trx`-based — called from `runIdempotentMutation`'s handler (a manual
 * expense) or from `postDueExpenseForSchedule` (the daily sweep's own
 * auto-post, via the `recordExpense` function reference it's handed —
 * see `recurrence.js`'s own header for why that's dependency injection
 * rather than a direct require).
 */
async function recordExpense({ trx, expenseCategoryId, description, payee, amount, currency, paymentMethod, businessDate, userId, source = 'manual', recurringExpenseScheduleId = null }) {
  const category = await resolveExpenseCategoryId({ db: trx, expenseCategoryId });
  const cleanAmountValue = cleanAmount(amount);
  const cleanDescriptionValue = cleanDescription(description);
  const cleanPaymentMethodValue = cleanPaymentMethod(paymentMethod);

  // The scoped accessor already filters `properties` to the caller's own
  // active property (whether a real request's `req.context` or the daily
  // sweep's `workerContext({tenantId, propertyId})`) — no explicit `.where()`
  // needed, matching `stock/service.js`'s `recordGoodsReceived` precedent.
  const property = await trx.table('properties').first('id', 'base_currency', 'current_business_date');
  if (currency !== property.base_currency) {
    throw new CurrencyMismatchError(property.base_currency, currency);
  }
  if (!businessDate) {
    throw new ValidationError('MISSING_FIELD', '"business_date" is required.', [{ field: 'business_date', issue: 'missing' }]);
  }
  if (property.current_business_date && String(businessDate) > String(property.current_business_date)) {
    throw new ValidationError('INVALID_BUSINESS_DATE', 'An expense cannot be dated in the future — the latest allowed date is the property\'s current business date.', [{ field: 'business_date', issue: 'future' }]);
  }

  const [id] = await trx.table('expenses').insert({
    expense_category_id: category.id,
    description: cleanDescriptionValue,
    payee: payee ? String(payee).trim().slice(0, 160) || null : null,
    amount: cleanAmountValue,
    currency,
    payment_method: cleanPaymentMethodValue,
    business_date: businessDate,
    source,
    recurring_expense_schedule_id: recurringExpenseScheduleId,
    recorded_by_user_id: userId ?? null,
  });
  return trx.table('expenses').where({ id }).first();
}

async function getExpense({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('expenses').where({ id }).first();
}

async function listExpenses({ context, categoryId, dateFrom, dateTo, paymentMethod, includeVoided = false }) {
  const db = scopedDb().for(context);
  let query = db.table('expenses');
  if (!includeVoided) query = query.whereNull('voided_at');
  if (categoryId) query = query.where({ expense_category_id: categoryId });
  if (dateFrom) query = query.where('business_date', '>=', dateFrom);
  if (dateTo) query = query.where('business_date', '<=', dateTo);
  if (paymentMethod) query = query.where({ payment_method: paymentMethod });
  return query.orderBy('business_date', 'desc').orderBy('id', 'desc');
}

/** `trx`-based, called from `runIdempotentMutation`. Mandatory reason (defense-in-depth — the controller also requires it). Locks the row before checking void state, the same "lock first, re-check under lock" discipline `pos/service.js`'s own void functions established after a real concurrency bug. */
async function voidExpense({ trx, id, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void an expense.', [{ field: 'reason', issue: 'missing' }]);
  const expense = await trx.table('expenses').where({ id }).forUpdate().first();
  if (!expense) throw new ExpenseNotFoundError();
  if (expense.voided_at) throw new ExpenseAlreadyVoidedError(id);
  await trx.table('expenses').where({ id }).update({ voided_at: new Date(), voided_by_user_id: userId ?? null, void_reason: reason });
  return trx.table('expenses').where({ id }).first();
}

// ---------------------------------------------------------------------
// Recurring expense schedules
// ---------------------------------------------------------------------

function validateRecurrenceConfig({ frequency, dayOfMonth, dayOfWeek }) {
  if (frequency === 'weekly') {
    if (dayOfMonth !== undefined && dayOfMonth !== null) {
      throw new InvalidRecurrenceConfigError('"day_of_month" must not be set for a weekly schedule — use "day_of_week" instead.');
    }
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new InvalidRecurrenceConfigError('"day_of_week" (0=Sunday..6=Saturday) is required for a weekly schedule.');
    }
    return;
  }
  if (['monthly', 'quarterly', 'annually'].includes(frequency)) {
    if (dayOfWeek !== undefined && dayOfWeek !== null) {
      throw new InvalidRecurrenceConfigError('"day_of_week" must not be set for a monthly/quarterly/annual schedule — use "day_of_month" instead.');
    }
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new InvalidRecurrenceConfigError('"day_of_month" (1-31) is required for a monthly/quarterly/annual schedule.');
    }
    return;
  }
  throw new InvalidRecurrenceConfigError('"frequency" must be one of: weekly, monthly, quarterly, annually.');
}

async function listRecurringExpenseSchedules({ context, status }) {
  const db = scopedDb().for(context);
  let query = db.table('recurring_expense_schedules');
  if (status) query = query.where({ status });
  return query.orderBy('next_due_date');
}

async function getRecurringExpenseSchedule({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('recurring_expense_schedules').where({ id }).first();
}

async function createRecurringExpenseSchedule({ context, expenseCategoryId, description, payee, amount, currency, paymentMethod, frequency, dayOfMonth, dayOfWeek, startDate, userId }) {
  const db = scopedDb().for(context);
  validateRecurrenceConfig({ frequency, dayOfMonth, dayOfWeek });
  const category = await resolveExpenseCategoryId({ db, expenseCategoryId });
  const cleanAmountValue = cleanAmount(amount);
  const cleanDescriptionValue = cleanDescription(description);
  const cleanPaymentMethodValue = cleanPaymentMethod(paymentMethod);

  const property = await db.table('properties').first('base_currency', 'current_business_date');
  if (currency !== property.base_currency) throw new CurrencyMismatchError(property.base_currency, currency);

  const effectiveStartDate = startDate || property.current_business_date;
  if (!effectiveStartDate) {
    throw new ValidationError('MISSING_FIELD', '"start_date" is required.', [{ field: 'start_date', issue: 'missing' }]);
  }
  const nextDueDate = computeNextDueDate({ fromDate: effectiveStartDate, frequency, dayOfMonth: dayOfMonth ?? null, dayOfWeek: dayOfWeek ?? null, inclusive: true });

  const [id] = await db.table('recurring_expense_schedules').insert({
    expense_category_id: category.id,
    description: cleanDescriptionValue,
    payee: payee ? String(payee).trim().slice(0, 160) || null : null,
    amount: cleanAmountValue,
    currency,
    payment_method: cleanPaymentMethodValue,
    frequency,
    day_of_month: dayOfMonth ?? null,
    day_of_week: dayOfWeek ?? null,
    next_due_date: nextDueDate,
    status: 'active',
    created_by_user_id: userId ?? null,
  });
  return getRecurringExpenseSchedule({ context, id });
}

/**
 * Allowlisted fields update freely with no side effect on `next_due_date`.
 * Changing `frequency`/`dayOfMonth`/`dayOfWeek` DOES recompute
 * `next_due_date` from the property's current business date (`inclusive:
 * true`, so a same-day match is honored) — a deliberate behavioral choice,
 * not an obvious one, so it's stated here rather than left implicit.
 */
async function updateRecurringExpenseSchedule({ context, id, changes }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const schedule = await trx.table('recurring_expense_schedules').where({ id }).forUpdate().first();
    if (!schedule) throw new RecurringExpenseScheduleNotFoundError();

    const next = {};
    if (changes.description !== undefined) next.description = cleanDescription(changes.description);
    if (changes.payee !== undefined) next.payee = changes.payee ? String(changes.payee).trim().slice(0, 160) || null : null;
    if (changes.amount !== undefined) next.amount = cleanAmount(changes.amount);
    if (changes.paymentMethod !== undefined) next.payment_method = cleanPaymentMethod(changes.paymentMethod);
    if (changes.currency !== undefined) {
      const property = await trx.table('properties').first('base_currency');
      if (changes.currency !== property.base_currency) throw new CurrencyMismatchError(property.base_currency, changes.currency);
      next.currency = changes.currency;
    }
    if (changes.expenseCategoryId !== undefined) {
      const category = await resolveExpenseCategoryId({ db: trx, expenseCategoryId: changes.expenseCategoryId });
      next.expense_category_id = category.id;
    }

    const recurrenceChanging = changes.frequency !== undefined || changes.dayOfMonth !== undefined || changes.dayOfWeek !== undefined;
    if (recurrenceChanging) {
      const frequency = changes.frequency ?? schedule.frequency;
      const dayOfMonth = changes.dayOfMonth !== undefined ? changes.dayOfMonth : schedule.day_of_month;
      const dayOfWeek = changes.dayOfWeek !== undefined ? changes.dayOfWeek : schedule.day_of_week;
      validateRecurrenceConfig({ frequency, dayOfMonth, dayOfWeek });
      const property = await trx.table('properties').first('current_business_date');
      next.frequency = frequency;
      next.day_of_month = dayOfMonth ?? null;
      next.day_of_week = dayOfWeek ?? null;
      next.next_due_date = computeNextDueDate({
        fromDate: property.current_business_date ?? schedule.next_due_date,
        frequency,
        dayOfMonth: dayOfMonth ?? null,
        dayOfWeek: dayOfWeek ?? null,
        inclusive: true,
      });
    }

    if (Object.keys(next).length === 0) return schedule;
    await trx.table('recurring_expense_schedules').where({ id }).update(next);
    return trx.table('recurring_expense_schedules').where({ id }).first();
  });
}

async function pauseRecurringExpenseSchedule({ context, id }) {
  const db = scopedDb().for(context);
  const schedule = await db.table('recurring_expense_schedules').where({ id }).first();
  if (!schedule) throw new RecurringExpenseScheduleNotFoundError();
  await db.table('recurring_expense_schedules').where({ id }).update({ status: 'paused' });
  return db.table('recurring_expense_schedules').where({ id }).first();
}

/**
 * If the stored `next_due_date` is now in the past relative to the
 * property's current business date, recomputes it FORWARD from today
 * (`inclusive: true`) rather than letting the sweep fire once for every
 * period missed while paused — a deliberate anti-catch-up-storm choice.
 */
async function resumeRecurringExpenseSchedule({ context, id }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const schedule = await trx.table('recurring_expense_schedules').where({ id }).forUpdate().first();
    if (!schedule) throw new RecurringExpenseScheduleNotFoundError();

    const property = await trx.table('properties').first('current_business_date');
    const businessDate = property.current_business_date;
    const next = { status: 'active' };
    if (businessDate && String(schedule.next_due_date) < String(businessDate)) {
      next.next_due_date = computeNextDueDate({
        fromDate: businessDate,
        frequency: schedule.frequency,
        dayOfMonth: schedule.day_of_month,
        dayOfWeek: schedule.day_of_week,
        inclusive: true,
      });
    }
    await trx.table('recurring_expense_schedules').where({ id }).update(next);
    return trx.table('recurring_expense_schedules').where({ id }).first();
  });
}

module.exports = {
  listExpenseCategories,
  getExpenseCategory,
  createExpenseCategory,
  updateExpenseCategory,
  archiveExpenseCategory,
  resolveExpenseCategoryId,
  recordExpense,
  getExpense,
  listExpenses,
  voidExpense,
  listRecurringExpenseSchedules,
  getRecurringExpenseSchedule,
  createRecurringExpenseSchedule,
  updateRecurringExpenseSchedule,
  pauseRecurringExpenseSchedule,
  resumeRecurringExpenseSchedule,
  validateRecurrenceConfig,
};
