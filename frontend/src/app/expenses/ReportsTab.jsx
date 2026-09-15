import { useState } from 'react';
import { DataTable, Button, Card } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { expensesApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import formStyles from './ExpensesForm.module.css';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ReportsTab — a proper P&L statement for the chosen period (Revenue →
 * Cost of Sales → Gross Profit → Operating Expenses → Net Profit,
 * restructured on the user's own follow-up request), plus the detailed
 * expense ledger for the same range.
 *
 * The statement is ONE consolidated set of figures for the whole date
 * range — not a day-by-day table, the standard way a real P&L is
 * presented. Cost of Sales is POS's own real stock-consumption cost
 * (`stock/reporting.js`'s `computeCostOfSales`), composed in here for a
 * true Gross Profit line — POS's own, more granular cost-of-sales/margin
 * report (elsewhere in this app, under POS → Stock → Reports) still
 * exists separately for per-item drill-down.
 *
 * The "fully audited" caveat is stated plainly next to the revenue lines,
 * not buried in a tooltip: it reflects the room-revenue figure only — cost
 * of sales, POS revenue, and operating expenses are always freshly
 * computed regardless of whether Night Audit has closed every day in
 * range (see the backend's own `expenses/reporting.js` header).
 */
export function ReportsTab({ activeProperty }) {
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [expenseReport, setExpenseReport] = useState(null);
  const [statement, setStatement] = useState(null);
  const [error, setError] = useState(null);

  const currency = activeProperty?.base_currency ?? null;

  async function runReports(event) {
    event?.preventDefault();
    setError(null);
    try {
      const [expenses, pnl] = await Promise.all([
        expensesApi.getExpenseReport({ dateFrom, dateTo }),
        expensesApi.getProfitAndLoss({ dateFrom, dateTo }),
      ]);
      setExpenseReport(expenses);
      setStatement(pnl);
    } catch (caught) {
      setExpenseReport(null);
      setStatement(null);
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

  async function exportPnlCsv() {
    try {
      const blob = await expensesApi.getProfitAndLossCsv({ dateFrom, dateTo });
      triggerDownload(blob, `profit-and-loss-${dateFrom}-to-${dateTo}.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export this statement.');
    }
  }

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={`${formStyles.errorBanner} ${formStyles.noPrint}`.trim()}>
          {error}
        </p>
      )}

      {/* Outside DataTable's own toolbar slot, deliberately — Card only
          renders `children` while `state === 'success'`, so a persistent
          date-range control must never live inside it (the same fix this
          codebase's Reporting tabs already established). Hidden on export —
          the printed letterhead below states the range instead. */}
      <form className={`${formStyles.row} ${formStyles.noPrint}`.trim()} onSubmit={runReports}>
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

      {statement && (
        <Card title={`Profit & Loss statement — ${statement.dateFrom} to ${statement.dateTo}`}>
          {/* Printed-only letterhead — the app chrome (Sidebar/TopBar, and
              this screen's own title/tab bar) is hidden on print, so the
              exported document needs its own property identity. The logo is
              whatever's already configured via Setup → Branding; a property
              with none set simply omits the <img>. */}
          <div className={`${formStyles.letterhead} ${formStyles.printOnly}`.trim()}>
            {activeProperty?.logo_url && (
              <img className={formStyles.letterheadLogo} src={activeProperty.logo_url} alt="" />
            )}
            <div className={formStyles.letterheadText}>
              <h2>{activeProperty?.name ?? 'Profit & Loss Statement'}</h2>
              <p>Profit &amp; Loss Statement — {statement.dateFrom} to {statement.dateTo}</p>
              <p>Printed {new Date().toLocaleString()}</p>
            </div>
          </div>

          <table className={formStyles.statementTable}>
            <tbody>
              <tr className={formStyles.statementSectionHeading}>
                <td colSpan={2}>Revenue</td>
              </tr>
              <tr className={formStyles.statementRow}>
                <td className={formStyles.statementIndent}>Room revenue</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.revenue.roomRevenue} currencyCode={currency} />
                </td>
              </tr>
              <tr className={formStyles.statementRow}>
                <td className={formStyles.statementIndent}>POS revenue</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.revenue.posRevenue} currencyCode={currency} />
                </td>
              </tr>
              <tr className={formStyles.statementSubtotal}>
                <td>Total revenue</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.revenue.totalRevenue} currencyCode={currency} />
                </td>
              </tr>

              <tr className={formStyles.statementRow}>
                <td className={formStyles.statementLabel}>Cost of sales</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.costOfSales} currencyCode={currency} />
                </td>
              </tr>
              <tr className={formStyles.statementTotal}>
                <td>Gross profit</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.grossProfit} currencyCode={currency} />
                </td>
              </tr>

              <tr className={formStyles.statementSectionHeading}>
                <td colSpan={2}>Operating expenses</td>
              </tr>
              {statement.operatingExpenses.byCategory.length === 0 ? (
                <tr className={formStyles.statementRow}>
                  <td className={formStyles.statementIndent} colSpan={2}>
                    None recorded in this range.
                  </td>
                </tr>
              ) : (
                statement.operatingExpenses.byCategory.map((category) => (
                  <tr className={formStyles.statementRow} key={category.categoryId}>
                    <td className={formStyles.statementIndent}>{category.categoryName}</td>
                    <td className={formStyles.statementAmount}>
                      <Money amount={category.total} currencyCode={currency} />
                    </td>
                  </tr>
                ))
              )}
              <tr className={formStyles.statementSubtotal}>
                <td>Total operating expenses</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.operatingExpenses.total} currencyCode={currency} />
                </td>
              </tr>

              <tr className={formStyles.statementTotal}>
                <td>Net profit</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.netProfit} currencyCode={currency} />
                </td>
              </tr>
            </tbody>
          </table>

          <p className={formStyles.hint}>
            Room revenue is {statement.revenue.roomRevenueFullyAudited ? 'fully reconciled by Night Audit' : 'not yet fully reconciled by Night Audit'} for this
            range. Cost of sales, POS revenue, and operating expenses are always freshly computed, regardless.
          </p>

          <div className={`${formStyles.actionsRow} ${formStyles.noPrint}`.trim()}>
            <Button size="compact" variant="ghost" onClick={exportPnlCsv}>
              Export P&amp;L statement (CSV)
            </Button>
            <Button size="compact" variant="ghost" onClick={() => window.print()}>
              Export to PDF
            </Button>
          </div>
        </Card>
      )}

      {/* The detailed ledger below is deliberately left out of the printed/PDF
          output — the statement Card above is the whole exported document,
          matching a real accountant-style P&L handed to an owner. */}
      <div className={formStyles.noPrint}>
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
    </div>
  );
}
