import { useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { expensesApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import formStyles from './ExpensesForm.module.css';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ReportsTab — the expense report (by category/period) and the profit
 * summary (confirmed scope: (room + POS revenue) minus operating expenses
 * only — POS's own cost-of-sales/margin report, elsewhere in this app,
 * stays a separate, more granular view).
 *
 * The `audited` caveat is stated plainly next to the totals line, not
 * buried in a tooltip: it reflects the room-revenue figure only — POS
 * revenue and expenses are always freshly computed regardless of whether
 * Night Audit has closed that date (see the backend's own
 * `expenses/reporting.js` header for the full reasoning).
 */
export function ReportsTab({ activeProperty }) {
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [expenseReport, setExpenseReport] = useState(null);
  const [profitSummary, setProfitSummary] = useState(null);
  const [error, setError] = useState(null);

  const currency = activeProperty?.base_currency ?? null;

  async function runReports(event) {
    event?.preventDefault();
    setError(null);
    try {
      const [expenses, profit] = await Promise.all([
        expensesApi.getExpenseReport({ dateFrom, dateTo }),
        expensesApi.getProfitSummary({ dateFrom, dateTo }),
      ]);
      setExpenseReport(expenses);
      setProfitSummary(profit);
    } catch (caught) {
      setExpenseReport(null);
      setProfitSummary(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load these reports.');
    }
  }

  async function exportExpenseCsv() {
    try {
      const blob = await expensesApi.getExpenseReportCsv({ dateFrom, dateTo });
      triggerDownload(blob, `expense-report-${dateFrom}-to-${dateTo}.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export this report.');
    }
  }

  async function exportProfitCsv() {
    try {
      const blob = await expensesApi.getProfitSummaryCsv({ dateFrom, dateTo });
      triggerDownload(blob, `profit-summary-${dateFrom}-to-${dateTo}.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export this report.');
    }
  }

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      {/* Outside DataTable's own toolbar slot, deliberately — Card only
          renders `children` while `state === 'success'`, so a persistent
          date-range control must never live inside it (the same fix this
          codebase's Reporting tabs already established). */}
      <form className={formStyles.row} onSubmit={runReports}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>From</span>
          <input type="date" className={formStyles.input} value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} required />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>To</span>
          <input type="date" className={formStyles.input} value={dateTo} onChange={(event) => setDateTo(event.target.value)} required />
        </label>
        <div className={formStyles.actionsRow}>
          <Button type="submit">Run reports</Button>
        </div>
      </form>

      {profitSummary && (
        <>
          <p className={formStyles.hint}>
            Room revenue: <Money amount={profitSummary.totals.roomRevenue} currencyCode={currency} /> — POS revenue:{' '}
            <Money amount={profitSummary.totals.posRevenue} currencyCode={currency} /> — Total revenue:{' '}
            <Money amount={profitSummary.totals.totalRevenue} currencyCode={currency} /> — Expenses:{' '}
            <Money amount={profitSummary.totals.totalExpenses} currencyCode={currency} /> — <strong>Profit: <Money amount={profitSummary.totals.profit} currencyCode={currency} /></strong>
          </p>
          <p className={formStyles.hint}>
            &ldquo;Audited&rdquo; below reflects room revenue only, reconciled by Night Audit — POS revenue and expenses are always freshly computed, whether or not that date has been audited.
          </p>
          <div className={formStyles.actionsRow}>
            <Button size="compact" variant="ghost" onClick={exportProfitCsv}>
              Export profit summary (CSV)
            </Button>
          </div>
        </>
      )}

      <DataTable
        title="Profit summary — by day"
        state={profitSummary === null || profitSummary.byDay.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the reports."
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'roomRevenue', label: 'Room revenue', align: 'right', render: (row) => <Money amount={row.roomRevenue} currencyCode={currency} /> },
          { key: 'posRevenue', label: 'POS revenue', align: 'right', render: (row) => <Money amount={row.posRevenue} currencyCode={currency} /> },
          { key: 'totalExpenses', label: 'Expenses', align: 'right', render: (row) => <Money amount={row.totalExpenses} currencyCode={currency} /> },
          { key: 'profit', label: 'Profit', align: 'right', render: (row) => <Money amount={row.profit} currencyCode={currency} /> },
          { key: 'audited', label: 'Audited', render: (row) => (row.audited ? 'Yes (room revenue)' : 'No') },
        ]}
        rows={profitSummary?.byDay ?? []}
        rowKey={(row) => row.date}
      />

      <DataTable
        title="Expenses by category"
        state={expenseReport === null || expenseReport.byCategory.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the reports."
        columns={[
          { key: 'categoryName', label: 'Category' },
          { key: 'count', label: 'Count', align: 'right' },
          { key: 'total', label: 'Total', align: 'right', render: (row) => <Money amount={row.total} currencyCode={currency} /> },
        ]}
        rows={expenseReport?.byCategory ?? []}
        rowKey={(row) => row.categoryId}
      />

      {expenseReport && (
        <div className={formStyles.actionsRow}>
          <Button size="compact" variant="ghost" onClick={exportExpenseCsv}>
            Export expense list (CSV)
          </Button>
        </div>
      )}

      <DataTable
        title="Every expense in range"
        state={expenseReport === null || expenseReport.expenses.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the reports."
        columns={[
          { key: 'businessDate', label: 'Date' },
          { key: 'description', label: 'Description' },
          { key: 'categoryName', label: 'Category' },
          { key: 'payee', label: 'Payee', render: (row) => row.payee ?? '—' },
          { key: 'paymentMethod', label: 'Payment method' },
          { key: 'amount', label: 'Amount', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
        ]}
        rows={expenseReport?.expenses ?? []}
        rowKey={(row) => row.id}
      />
    </div>
  );
}
