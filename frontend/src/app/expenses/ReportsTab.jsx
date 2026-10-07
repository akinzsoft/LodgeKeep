import { Fragment, useState } from 'react';
import { DataTable, Button, Card, PrintLetterhead } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { expensesApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import formStyles from './ExpensesForm.module.css';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function nextDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Collapses sorted ISO dates into "a to b, c" so a long run of unaudited days stays readable. */
function describeDates(dates) {
  const parts = [];
  let start = null;
  let prev = null;
  for (const date of dates) {
    if (start !== null && nextDay(prev) === date) {
      prev = date;
      continue;
    }
    if (start !== null) parts.push(start === prev ? start : `${start} to ${prev}`);
    start = date;
    prev = date;
  }
  if (start !== null) parts.push(start === prev ? start : `${start} to ${prev}`);
  return parts.join(', ');
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
 *
 * Gap closure, user-reported: a warning banner (`itemsSoldWithoutCost`)
 * shows above that caveat whenever a menu item sold in range has no cost
 * anywhere (no stock deduction, no cost price) — its cost never reaches the Cost of sales line above, so
 * Gross profit is a genuine overstatement in that case, not merely an
 * approximation. Deliberately visible on print (the exported statement),
 * not `.noPrint` — an owner reading the printed P&L needs the same warning
 * a screen reader gets.
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
          {/* Printed-only letterhead and watermark — the app chrome (Sidebar/
              TopBar, and this screen's own title/tab bar) is hidden on
              print, so the exported document carries its own property
              identity: the Setup → Branding logo, when one is set. */}
          <div className={formStyles.printOnly}>
            <PrintLetterhead
              logoUrl={activeProperty?.logo_url}
              organisation={activeProperty?.name}
              title="Profit & Loss Statement"
              details={[`${statement.dateFrom} to ${statement.dateTo}`, `Printed ${new Date().toLocaleString()}`]}
            />
          </div>

          <table className={formStyles.statementTable}>
            <thead>
              <tr className={formStyles.statementSectionHeading}>
                <th scope="col" className={formStyles.statementHead}>
                  Department
                </th>
                <th scope="col" className={`${formStyles.statementHead} ${formStyles.statementAmount}`}>
                  Revenue
                </th>
                <th scope="col" className={`${formStyles.statementHead} ${formStyles.statementAmount}`}>
                  Cost of sales
                </th>
                <th scope="col" className={`${formStyles.statementHead} ${formStyles.statementAmount}`}>
                  Gross profit
                </th>
              </tr>
            </thead>
            <tbody>
              {statement.departments.rows.map((department) => (
                <Fragment key={department.key}>
                  <tr className={formStyles.statementRow}>
                    <td className={formStyles.statementLabel}>
                      {department.name}
                      {department.kind === 'rooms' && <span className={formStyles.deptNote}>Room nights only. Food and drink charged to a room counts in the outlet that sold it.</span>}
                      {department.kind === 'unmapped' && <span className={formStyles.deptNote}>Sales that cannot be matched to a current outlet; not assigned to any department.</span>}
                      {department.costIncomplete && (
                        <span className={formStyles.deptFlag} role="alert">
                          {department.itemsSoldWithoutCost} item(s) sold with no cost, so this gross profit is overstated.
                        </span>
                      )}
                      {department.costExceedsRevenue && (
                        <span className={formStyles.deptFlag} role="alert">
                          Cost of sales is higher than revenue. Check the stock costs and cost prices of what this department sold.
                        </span>
                      )}
                    </td>
                    <td className={formStyles.statementAmount}>
                      <Money amount={department.revenue} currencyCode={currency} />
                    </td>
                    <td className={formStyles.statementAmount}>{department.kind === 'rooms' || department.kind === 'other_income' ? '—' : <Money amount={department.costOfSales} currencyCode={currency} />}</td>
                    <td className={formStyles.statementAmount}>
                      <Money amount={department.grossProfit} currencyCode={currency} />
                      {department.marginPct !== null && department.kind !== 'rooms' && department.kind !== 'other_income' && <span className={formStyles.deptNote}>{department.marginPct}% margin</span>}
                    </td>
                  </tr>
                  {department.kind === 'rooms' && (statement.revenue.roomRevenueEstimated ?? '0.00') !== '0.00' && (
                    <>
                      <tr className={formStyles.statementRow}>
                        <td className={`${formStyles.statementLabel} ${formStyles.statementIndent}`}>of which audited (actual)</td>
                        <td className={formStyles.statementAmount}>
                          <Money amount={statement.revenue.roomRevenueAudited} currencyCode={currency} />
                        </td>
                        <td colSpan={2} />
                      </tr>
                      <tr className={formStyles.statementRow}>
                        <td className={`${formStyles.statementLabel} ${formStyles.statementIndent}`}>of which open days (estimate from booked rates)</td>
                        <td className={formStyles.statementAmount}>
                          <Money amount={statement.revenue.roomRevenueEstimated} currencyCode={currency} />
                        </td>
                        <td colSpan={2} />
                      </tr>
                    </>
                  )}
                  {department.kind === 'other_income' && (statement.revenue.otherIncome?.fees ?? '0.00') !== '0.00' && (
                    <tr className={formStyles.statementRow}>
                      <td className={`${formStyles.statementLabel} ${formStyles.statementIndent}`}>Fees and other charges</td>
                      <td className={formStyles.statementAmount}>
                        <Money amount={statement.revenue.otherIncome.fees} currencyCode={currency} />
                      </td>
                      <td colSpan={2} />
                    </tr>
                  )}
                  {department.kind === 'other_income' && (statement.revenue.otherIncome?.discounts ?? '0.00') !== '0.00' && (
                    <tr className={formStyles.statementRow}>
                      <td className={`${formStyles.statementLabel} ${formStyles.statementIndent}`}>Discounts and corrections (net)</td>
                      <td className={formStyles.statementAmount}>
                        <Money amount={statement.revenue.otherIncome.discounts} currencyCode={currency} />
                      </td>
                      <td colSpan={2} />
                    </tr>
                  )}
                </Fragment>
              ))}
              <tr className={formStyles.statementSubtotal}>
                <td>Total gross profit</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.revenue.totalRevenue} currencyCode={currency} />
                </td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.costOfSales} currencyCode={currency} />
                </td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.grossProfit} currencyCode={currency} />
                </td>
              </tr>
              {statement.costOfSalesFromCostPrice !== undefined && statement.costOfSalesFromCostPrice !== '0.00' && (
                <tr className={formStyles.statementRow}>
                  <td className={`${formStyles.statementLabel} ${formStyles.statementIndent}`}>of which cost of sales from item cost price (estimate)</td>
                  <td />
                  <td className={formStyles.statementAmount}>
                    <Money amount={statement.costOfSalesFromCostPrice} currencyCode={currency} />
                  </td>
                  <td />
                </tr>
              )}

              <tr className={formStyles.statementSectionHeading}>
                <td colSpan={4}>Less: operating expenses</td>
              </tr>
              {statement.operatingExpenses.byCategory.length === 0 ? (
                <tr className={formStyles.statementRow}>
                  <td className={formStyles.statementIndent} colSpan={4}>
                    None recorded in this range.
                  </td>
                </tr>
              ) : (
                statement.operatingExpenses.byCategory.map((category) => (
                  <tr className={formStyles.statementRow} key={category.categoryId}>
                    <td className={formStyles.statementIndent} colSpan={3}>
                      {category.categoryName}
                    </td>
                    <td className={formStyles.statementAmount}>
                      <Money amount={category.total} currencyCode={currency} />
                    </td>
                  </tr>
                ))
              )}
              <tr className={formStyles.statementSubtotal}>
                <td colSpan={3}>Total operating expenses</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.operatingExpenses.total} currencyCode={currency} />
                </td>
              </tr>

              <tr className={formStyles.statementTotal}>
                <td colSpan={3}>Net profit</td>
                <td className={formStyles.statementAmount}>
                  <Money amount={statement.netProfit} currencyCode={currency} />
                </td>
              </tr>
            </tbody>
          </table>

          {statement.departments.quietOutlets?.length > 0 && <p className={formStyles.hint}>No activity in this period: {statement.departments.quietOutlets.join(', ')}.</p>}
          {!statement.departments.reconciles && (
            <p className={formStyles.costWarningBanner} role="alert">
              The department lines do not add up to the statement totals. Do not rely on the department split; the totals above are correct.
            </p>
          )}

          {statement.revenue.estimateVariance?.days?.length > 0 && (
            <p className={formStyles.costWarningBanner} role="alert">
              On open days, the booked-rate estimate differs from the room charges actually posted:{' '}
              {statement.revenue.estimateVariance.days
                .map((day) => `${day.date} (estimate ${day.estimated}, posted ${day.posted})`)
                .join('; ')}
              .
            </p>
          )}

          {statement.adjustmentsInOtherCurrency > 0 && (
            <p className={formStyles.costWarningBanner} role="alert">
              {statement.adjustmentsInOtherCurrency} folio adjustment(s) in another currency are not included in revenue above.
            </p>
          )}

          {statement.itemsSoldWithoutCost > 0 && (
            <p className={formStyles.costWarningBanner} role="alert">
              {statement.itemsSoldWithoutCost} menu item(s) sold in this range with no cost (no recipe deduction and no cost price) — their cost is not in
              Cost of sales above, so Gross profit is overstated by an unknown amount. Add a recipe or a cost price for these items in POS Setup to fix this.
            </p>
          )}

          <p className={formStyles.hint}>
            Room revenue is {statement.revenue.roomRevenueFullyAudited ? 'fully reconciled by Night Audit' : 'not yet fully reconciled by Night Audit'}
            {!statement.revenue.roomRevenueFullyAudited && statement.revenue.unauditedDates?.length > 0
              ? ` (no Night Audit for: ${describeDates(statement.revenue.unauditedDates)})`
              : ''}{' '}
            for this range. Cost of sales, POS revenue, and operating expenses are always freshly computed,
            regardless.
          </p>
          <p className={formStyles.hint}>
            Basis: earned, before tax, service charge and tips (room charges billed, sales made). The Business Summary report shows gross money
            collected instead, so the two will differ by design: it counts tax, service and tips, counts rooms when paid rather than when charged, and
            leaves out food and drink charged to a room until the folio is paid.
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
