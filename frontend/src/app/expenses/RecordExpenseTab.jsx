import { useEffect, useState } from 'react';
import { DataTable, Button, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { expensesApi, ApiError } from '../../shared/api/index.js';
import formStyles from './ExpensesForm.module.css';

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
];

const EMPTY_FORM = { expense_category_id: '', description: '', payee: '', amount: '', payment_method: 'cash', business_date: '' };

/**
 * RecordExpenseTab — the record form plus a filterable list of every
 * recorded expense. Currency is always the property's own base currency
 * (confirmed decision: no cross-currency/FX handling) — shown, never
 * chosen. `business_date` defaults to the property's current business
 * date but may be backdated (confirmed decision); the input's own `max`
 * attribute enforces "never postdated" the same way the backend does.
 *
 * No edit action exists — ARCHITECTURE.md §8 financial-record immutability
 * applies here exactly as it does to folio postings: the only correction
 * path is Void (a mandatory reason, `ConfirmDialog`'s `requireReason`)
 * plus recording a fresh, correct expense. A voided row stays visible,
 * struck through, never removed — Cashiering's own established convention.
 */
export function RecordExpenseTab({ categories, activeProperty, isOffline, onExpenseRecorded }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const [expenses, setExpenses] = useState(null);
  const [filters, setFilters] = useState({ category_id: '', date_from: '', date_to: '', payment_method: '' });
  const [voiding, setVoiding] = useState(null);

  const currency = activeProperty?.base_currency ?? null;
  const today = activeProperty?.current_business_date ?? null;

  async function reloadExpenses() {
    try {
      setExpenses(
        await expensesApi.listExpenses({
          categoryId: filters.category_id || undefined,
          dateFrom: filters.date_from || undefined,
          dateTo: filters.date_to || undefined,
          paymentMethod: filters.payment_method || undefined,
        })
      );
    } catch (caught) {
      setExpenses([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load expenses.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount/filter-change; no data-fetching library owns this yet
    reloadExpenses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.category_id, filters.date_from, filters.date_to, filters.payment_method]);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await expensesApi.recordExpense({
        expenseCategoryId: form.expense_category_id,
        description: form.description,
        payee: form.payee || undefined,
        amount: form.amount,
        currency,
        paymentMethod: form.payment_method,
        businessDate: form.business_date || undefined,
      });
      setForm(EMPTY_FORM);
      await reloadExpenses();
      onExpenseRecorded?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record this expense.');
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmVoid(reason) {
    const expense = voiding;
    setVoiding(null);
    setError(null);
    try {
      await expensesApi.voidExpense(expense.id, reason);
      await reloadExpenses();
      onExpenseRecorded?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not void this expense.');
    }
  }

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      {isOffline ? (
        <p className={formStyles.disabledNotice}>Recording and voiding expenses is disabled while offline.</p>
      ) : (
        <form className={formStyles.row} onSubmit={handleSubmit} aria-label="Record an expense">
          <label className={formStyles.field}>
            <span className={formStyles.label}>Category</span>
            <select
              className={formStyles.select}
              value={form.expense_category_id}
              onChange={(e) => setForm({ ...form, expense_category_id: e.target.value })}
              required
            >
              <option value="">Select a category</option>
              {(categories ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Description</span>
            <input className={formStyles.input} value={form.description} maxLength={255} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Payee (optional)</span>
            <input className={formStyles.input} value={form.payee} maxLength={160} onChange={(e) => setForm({ ...form, payee: e.target.value })} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Amount ({currency ?? '—'})</span>
            <input className={formStyles.input} type="number" step="0.01" min="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Payment method</span>
            <select className={formStyles.select} value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} required>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Date</span>
            <input
              className={formStyles.input}
              type="date"
              value={form.business_date || today || ''}
              max={today || undefined}
              onChange={(e) => setForm({ ...form, business_date: e.target.value })}
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting}>
              Record expense
            </Button>
          </div>
        </form>
      )}

      <form className={formStyles.row} aria-label="Filter expenses" onSubmit={(e) => e.preventDefault()}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Filter by category</span>
          <select className={formStyles.select} value={filters.category_id} onChange={(e) => setFilters({ ...filters, category_id: e.target.value })}>
            <option value="">All categories</option>
            {(categories ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>From</span>
          <input className={formStyles.input} type="date" value={filters.date_from} onChange={(e) => setFilters({ ...filters, date_from: e.target.value })} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>To</span>
          <input className={formStyles.input} type="date" value={filters.date_to} onChange={(e) => setFilters({ ...filters, date_to: e.target.value })} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Filter by payment method</span>
          <select className={formStyles.select} value={filters.payment_method} onChange={(e) => setFilters({ ...filters, payment_method: e.target.value })}>
            <option value="">All methods</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </form>

      <DataTable
        state={expenses === null ? 'loading' : expenses.length === 0 ? 'empty' : 'success'}
        emptyMessage="No expenses recorded yet."
        columns={[
          { key: 'business_date', label: 'Date' },
          { key: 'description', label: 'Description', render: (row) => <span className={row.voided_at ? formStyles.voided : undefined}>{row.description}</span> },
          { key: 'payee', label: 'Payee', render: (row) => row.payee ?? '—' },
          { key: 'payment_method', label: 'Payment method' },
          { key: 'amount', label: 'Amount', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
        ]}
        rows={expenses ?? []}
        rowKey={(row) => row.id}
        actions={(row) =>
          row.voided_at ? (
            <span className={formStyles.hint}>Voided: {row.void_reason}</span>
          ) : (
            <Button size="compact" variant="ghost" onClick={() => setVoiding(row)} disabled={isOffline}>
              Void
            </Button>
          )
        }
      />

      {voiding && (
        <ConfirmDialog
          title="Void expense"
          consequence={`"${voiding.description}" will be marked voided and excluded from every report. This cannot be undone — record a fresh, corrected expense afterward if needed.`}
          requireReason
          confirmLabel="Void"
          onConfirm={confirmVoid}
          onCancel={() => setVoiding(null)}
        />
      )}
    </div>
  );
}
