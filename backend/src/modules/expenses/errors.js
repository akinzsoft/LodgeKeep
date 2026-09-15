'use strict';

/**
 * Expense module error types. Following the exact shape `stock/errors.js`
 * already established.
 */

const { AppError, ValidationError } = require('../../shared/errors');

class ExpenseCategoryNotFoundError extends ValidationError {
  constructor() {
    super('EXPENSE_CATEGORY_NOT_FOUND', 'The specified expense category does not exist, or is archived.');
  }
}

/** Mirrors `stock/errors.js`'s `StockCategoryInUseError` exactly, naming both the non-voided expense count and the active-schedule count. */
class ExpenseCategoryInUseError extends AppError {
  constructor(name, expenseCount, scheduleCount) {
    const parts = [];
    if (expenseCount > 0) parts.push(`${expenseCount} expense${expenseCount === 1 ? '' : 's'}`);
    if (scheduleCount > 0) parts.push(`${scheduleCount} active recurring schedule${scheduleCount === 1 ? '' : 's'}`);
    super(
      'CONFLICT_EXPENSE_CATEGORY_IN_USE',
      `"${name}" is still used by ${parts.join(' and ')} — move them to another category first.`,
      409,
      { name, expenseCount, scheduleCount }
    );
  }
}

class ExpenseNotFoundError extends ValidationError {
  constructor() {
    super('EXPENSE_NOT_FOUND', 'The specified expense does not exist.');
  }
}

class ExpenseAlreadyVoidedError extends AppError {
  constructor(id) {
    super('CONFLICT_EXPENSE_ALREADY_VOIDED', `Expense ${id} has already been voided.`, 409, { id });
  }
}

class RecurringExpenseScheduleNotFoundError extends ValidationError {
  constructor() {
    super('RECURRING_EXPENSE_SCHEDULE_NOT_FOUND', 'The specified recurring expense schedule does not exist.');
  }
}

/** A frequency/day-of-month/day-of-week combination that doesn't make sense — e.g. weekly with no day_of_week, or monthly with a day_of_week set. */
class InvalidRecurrenceConfigError extends ValidationError {
  constructor(message) {
    super('INVALID_RECURRENCE_CONFIG', message);
  }
}

/** Confirmed decision: an expense's currency must match the property's own base_currency — no cross-currency/FX handling in this pass. */
class CurrencyMismatchError extends ValidationError {
  constructor(expected, actual) {
    super('CURRENCY_MISMATCH', `This property's currency is "${expected}" — "${actual}" is not accepted.`, [{ field: 'currency', issue: 'mismatch' }]);
  }
}

module.exports = {
  ExpenseCategoryNotFoundError,
  ExpenseCategoryInUseError,
  ExpenseNotFoundError,
  ExpenseAlreadyVoidedError,
  RecurringExpenseScheduleNotFoundError,
  InvalidRecurrenceConfigError,
  CurrencyMismatchError,
};
