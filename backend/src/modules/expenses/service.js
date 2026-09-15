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
const { ValidationError, withDuplicateMapping } = require('../../shared/errors');
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

function cleanExpenseCategoryName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 60) {
    throw new ValidationError('INVALID_CATEGORY_NAME', 'A category name is required, up to 60 characters.', [{ field: 'name', issue: trimmed ? 'too_long' : 'missing' }]);
  }
  return trimmed;
}

/** Active categories in display order, each carrying its own real non-voided-expense count (a single grouped query, not per-row lookups — the live-FK shape makes this simpler than stock's own name-string matching). */
async function listExpenseCategories({ context, includeArchived = false }) {
  const db = scopedDb().for(context);
  const query = db.table('expense_categories');
  const rows = await (includeArchived ? query : query.where({ status: 'active' })).orderBy('sort_order').orderBy('name');
  if (rows.length === 0) return rows;

  // The scoped accessor's own `count()` executes immediately and returns a
  // plain number — it is not chainable with `.groupBy()` the way raw knex's
  // is (confirmed against `scoped-db.js` directly). Counted in JS instead,
  // the same shape `stock/service.js`'s `listStockItemCategories` already
  // uses for its own per-category count.
  const expenseRows = await db
    .table('expenses')
    .whereIn('expense_category_id', rows.map((row) => row.id))
    .whereNull('voided_at')
    .select('expense_category_id');
  const countByCategoryId = new Map();
  for (const { expense_category_id: categoryId } of expenseRows) {
    const key = String(categoryId);
    countByCategoryId.set(key, (countByCategoryId.get(key) ?? 0) + 1);
  }
  return rows.map((row) => ({ ...row, item_count: countByCategoryId.get(String(row.id)) ?? 0 }));
}

async function getExpenseCategory({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('expense_categories').where({ id }).first();
}

async function createExpenseCategory({ context, name, sortOrder }) {
  const db = scopedDb().for(context);
  const clean = cleanExpenseCategoryName(name);
  return withDuplicateMapping('expense_categories', `A category named "${clean}" already exists.`, async () => {
    if (sortOrder !== undefined && !Number.isInteger(sortOrder)) {
      throw new ValidationError('INVALID_SORT_ORDER', '"sort_order" must be a whole number.', [{ field: 'sort_order', issue: 'invalid' }]);
    }
    const [id] = await db.table('expense_categories').insert({ name: clean, sort_order: sortOrder ?? 0 });
    return getExpenseCategory({ context, id });
  });
}

/** No cascade needed on rename — expenses/schedules hold a live FK, resolved fresh on every read. */
async function updateExpenseCategory({ context, id, name, sortOrder }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping('expense_categories', `A category named "${typeof name === 'string' ? name.trim() : ''}" already exists.`, () =>
    db.transaction(async (trx) => {
      const category = await trx.table('expense_categories').where({ id }).forUpdate().first();
      if (!category) return null;
      const changes = {};
      if (name !== undefined) changes.name = cleanExpenseCategoryName(name);
      if (sortOrder !== undefined) {
        if (!Number.isInteger(sortOrder)) throw new ValidationError('INVALID_SORT_ORDER', '"sort_order" must be a whole number.', [{ field: 'sort_order', issue: 'invalid' }]);
        changes.sort_order = sortOrder;
      }
      if (Object.keys(changes).length === 0) return category;
      await trx.table('expense_categories').where({ id }).update(changes);
      return trx.table('expense_categories').where({ id }).first();
    })
  );
}

/** Archives a category no non-voided expense AND no active recurring schedule still uses; refuses (409) otherwise, naming both counts. */
async function archiveExpenseCategory({ context, id }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const category = await trx.table('expense_categories').where({ id }).forUpdate().first();
    if (!category) return null;
    // The scoped accessor's own `count()` resolves directly to a number
    // (confirmed precedent: `stock/service.js`'s `archiveStockItemCategory`
    // uses the identical `const inUse = await trx.table(...).count();`
    // shape) — never a chained `.first()`, which throws against it.
    const expenseCount = await trx.table('expenses').where({ expense_category_id: id }).whereNull('voided_at').count();
    const scheduleCount = await trx.table('recurring_expense_schedules').where({ expense_category_id: id, status: 'active' }).count();
    if (expenseCount > 0 || scheduleCount > 0) throw new ExpenseCategoryInUseError(category.name, expenseCount, scheduleCount);
    await trx.table('expense_categories').where({ id }).update({ status: 'archived' });
    return trx.table('expense_categories').where({ id }).first();
  });
}

/** Always required — throws if missing, wrong-tenant, or archived. Mirrors `resolveMenuCategoryName`'s "still requires one" shape, not stock's optional/nullable one. */
async function resolveExpenseCategoryId({ db, expenseCategoryId }) {
  const category = await db.table('expense_categories').where({ id: expenseCategoryId, status: 'active' }).first();
  if (!category) throw new ExpenseCategoryNotFoundError();
  return category;
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
