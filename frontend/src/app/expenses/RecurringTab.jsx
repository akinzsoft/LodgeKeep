import { useEffect, useState } from 'react';
import { DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { expensesApi, ApiError } from '../../shared/api/index.js';
import formStyles from './ExpensesForm.module.css';

const FREQUENCIES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
];

const DAYS_OF_WEEK = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

const EMPTY_FORM = { expense_category_id: '', description: '', payee: '', amount: '', frequency: 'monthly', day_of_month: '1', day_of_week: '0' };

/**
 * RecurringTab — schedule create form (rent, salaries) plus a table of
 * every schedule with Pause/Resume. No "run now" action (confirmed
 * decision) — an early one-off payment goes through Record Expense
 * directly, leaving the schedule's own next_due_date untouched for its
 * next regular cycle. The daily sweep (`src/jobs/expense-schedules.js`)
 * auto-posts everything else, fully automatically, no approval gate.
 */
export function RecurringTab({ categories, activeProperty, isOffline }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [schedules, setSchedules] = useState(null);

  const currency = activeProperty?.base_currency ?? null;

  async function reloadSchedules() {
    try {
      setSchedules(await expensesApi.listRecurringExpenseSchedules());
    } catch (caught) {
      setSchedules([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load recurring schedules.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; no data-fetching library owns this yet
    reloadSchedules();
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await expensesApi.createRecurringExpenseSchedule({
        expenseCategoryId: form.expense_category_id,
        description: form.description,
        payee: form.payee || undefined,
        amount: form.amount,
        currency,
        paymentMethod: 'bank_transfer',
        frequency: form.frequency,
        dayOfMonth: form.frequency === 'weekly' ? undefined : Number(form.day_of_month),
        dayOfWeek: form.frequency === 'weekly' ? Number(form.day_of_week) : undefined,
      });
      setForm(EMPTY_FORM);
      await reloadSchedules();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create this schedule.');
    } finally {
      setSubmitting(false);
    }
  }

  async function togglePause(schedule) {
    setError(null);
    try {
      if (schedule.status === 'active') await expensesApi.pauseRecurringExpenseSchedule(schedule.id);
      else await expensesApi.resumeRecurringExpenseSchedule(schedule.id);
      await reloadSchedules();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update this schedule.');
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
        <p className={formStyles.disabledNotice}>Recurring schedules are disabled while offline.</p>
      ) : (
        <form className={formStyles.row} onSubmit={handleSubmit} aria-label="Create a recurring expense">
          <label className={formStyles.field}>
            <span className={formStyles.label}>Category</span>
            <select className={formStyles.select} value={form.expense_category_id} onChange={(e) => setForm({ ...form, expense_category_id: e.target.value })} required>
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
            <span className={formStyles.label}>Frequency</span>
            <select className={formStyles.select} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {form.frequency === 'weekly' ? (
            <label className={formStyles.field}>
              <span className={formStyles.label}>Day of week</span>
              <select className={formStyles.select} value={form.day_of_week} onChange={(e) => setForm({ ...form, day_of_week: e.target.value })}>
                {DAYS_OF_WEEK.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className={formStyles.field}>
              <span className={formStyles.label}>Day of month</span>
              <input className={formStyles.input} type="number" min="1" max="31" value={form.day_of_month} onChange={(e) => setForm({ ...form, day_of_month: e.target.value })} />
            </label>
          )}
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting}>
              Create schedule
            </Button>
          </div>
        </form>
      )}

      <DataTable
        state={schedules === null ? 'loading' : schedules.length === 0 ? 'empty' : 'success'}
        emptyMessage="No recurring expenses configured yet."
        columns={[
          { key: 'description', label: 'Description' },
          { key: 'payee', label: 'Payee', render: (row) => row.payee ?? '—' },
          { key: 'amount', label: 'Amount', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
          { key: 'frequency', label: 'Frequency' },
          { key: 'next_due_date', label: 'Next due' },
          { key: 'last_posted_date', label: 'Last posted', render: (row) => row.last_posted_date ?? '—' },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={row.status === 'active' ? 'success' : 'neutral'} label={row.status === 'active' ? 'Active' : 'Paused'} /> },
        ]}
        rows={schedules ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <Button size="compact" variant="ghost" onClick={() => togglePause(row)} disabled={isOffline}>
            {row.status === 'active' ? 'Pause' : 'Resume'}
          </Button>
        )}
      />
    </div>
  );
}
