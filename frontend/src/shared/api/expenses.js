import { request, requestBlob } from './client.js';

/**
 * Expense tracking & reporting module — same shape as `stock.js`: plain
 * exported functions, each a thin wrapper over `request()`, matching the
 * real backend response shapes in `backend/src/modules/expenses`.
 *
 * `recordExpense`/`voidExpense` each carry a fresh `Idempotency-Key`
 * header (ARCHITECTURE.md §7) — both go through the backend's own
 * `runIdempotentMutation`. Category CRUD and recurring-schedule CRUD/
 * pause/resume are NOT idempotency-gated — each is either plain
 * configuration (naturally idempotent on retry) or already made safe by
 * its own lock shape, matching the backend controller's own documented
 * reasoning.
 */

function idempotencyKey() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------
// Expense categories
// ---------------------------------------------------------------------

export function listExpenseCategories({ includeArchived } = {}) {
  const params = new URLSearchParams();
  if (includeArchived) params.set('include_archived', 'true');
  const query = params.toString();
  return request(`/expenses/categories${query ? `?${query}` : ''}`);
}

export function createExpenseCategory({ name, sortOrder }) {
  return request('/expenses/categories', { method: 'POST', body: { name, sort_order: sortOrder } });
}

export function updateExpenseCategory(id, { name, sortOrder } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (sortOrder !== undefined) body.sort_order = sortOrder;
  return request(`/expenses/categories/${id}`, { method: 'PATCH', body });
}

export function archiveExpenseCategory(id) {
  return request(`/expenses/categories/${id}/archive`, { method: 'POST', body: {} });
}

// ---------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------

export function listExpenses({ categoryId, dateFrom, dateTo, paymentMethod, includeVoided } = {}) {
  const params = new URLSearchParams();
  if (categoryId) params.set('category_id', categoryId);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  if (paymentMethod) params.set('payment_method', paymentMethod);
  if (includeVoided) params.set('include_voided', 'true');
  const query = params.toString();
  return request(`/expenses${query ? `?${query}` : ''}`);
}

export function getExpense(id) {
  return request(`/expenses/${id}`);
}

/** `businessDate` optional — defaults server-side to the property's current business date; may only be backdated, never postdated. */
export function recordExpense({ expenseCategoryId, description, payee, amount, currency, paymentMethod, businessDate }) {
  return request('/expenses', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: {
      expense_category_id: expenseCategoryId,
      description,
      payee,
      amount,
      currency,
      payment_method: paymentMethod,
      business_date: businessDate,
    },
  });
}

/** Mandatory `reason` (backend-enforced; validate non-blank client-side too). No update function exists — a correction is void + a fresh recordExpense call. */
export function voidExpense(id, reason) {
  return request(`/expenses/${id}/void`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() }, body: { reason } });
}

// ---------------------------------------------------------------------
// Recurring expense schedules
// ---------------------------------------------------------------------

export function listRecurringExpenseSchedules({ status } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const query = params.toString();
  return request(`/expenses/recurring-schedules${query ? `?${query}` : ''}`);
}

export function getRecurringExpenseSchedule(id) {
  return request(`/expenses/recurring-schedules/${id}`);
}

export function createRecurringExpenseSchedule({ expenseCategoryId, description, payee, amount, currency, paymentMethod, frequency, dayOfMonth, dayOfWeek, startDate }) {
  return request('/expenses/recurring-schedules', {
    method: 'POST',
    body: {
      expense_category_id: expenseCategoryId,
      description,
      payee,
      amount,
      currency,
      payment_method: paymentMethod,
      frequency,
      day_of_month: dayOfMonth,
      day_of_week: dayOfWeek,
      start_date: startDate,
    },
  });
}

export function updateRecurringExpenseSchedule(id, { expenseCategoryId, description, payee, amount, currency, paymentMethod, frequency, dayOfMonth, dayOfWeek } = {}) {
  const body = {};
  if (expenseCategoryId !== undefined) body.expense_category_id = expenseCategoryId;
  if (description !== undefined) body.description = description;
  if (payee !== undefined) body.payee = payee;
  if (amount !== undefined) body.amount = amount;
  if (currency !== undefined) body.currency = currency;
  if (paymentMethod !== undefined) body.payment_method = paymentMethod;
  if (frequency !== undefined) body.frequency = frequency;
  if (dayOfMonth !== undefined) body.day_of_month = dayOfMonth;
  if (dayOfWeek !== undefined) body.day_of_week = dayOfWeek;
  return request(`/expenses/recurring-schedules/${id}`, { method: 'PATCH', body });
}

export function pauseRecurringExpenseSchedule(id) {
  return request(`/expenses/recurring-schedules/${id}/pause`, { method: 'POST', body: {} });
}

export function resumeRecurringExpenseSchedule(id) {
  return request(`/expenses/recurring-schedules/${id}/resume`, { method: 'POST', body: {} });
}

// ---------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------

export function getExpenseReport({ dateFrom, dateTo, categoryId }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  if (categoryId) params.set('category_id', categoryId);
  return request(`/expenses/reports/summary?${params}`);
}

export function getExpenseReportCsv({ dateFrom, dateTo, categoryId }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, format: 'csv' });
  if (categoryId) params.set('category_id', categoryId);
  return requestBlob(`/expenses/reports/summary?${params}`);
}

/** Revenue (rooms + POS) minus operating expenses, per day and totalled. `byDay[].audited` reflects the room-revenue figure only — see the backend's own header for why POS revenue/expenses are always live-computed regardless. */
export function getProfitSummary({ dateFrom, dateTo }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  return request(`/expenses/reports/profit?${params}`);
}

export function getProfitSummaryCsv({ dateFrom, dateTo }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, format: 'csv' });
  return requestBlob(`/expenses/reports/profit?${params}`);
}
