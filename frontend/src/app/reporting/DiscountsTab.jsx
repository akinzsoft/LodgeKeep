import { useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { discountsApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import styles from './ReportingScreen.module.css';

/** The property's business date (never the wall clock: between midnight and Night Audit they differ). */
function businessDateOf(property) {
  return String(property?.current_business_date ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
}

const KIND_LABELS = { discount: 'Discount', comp: 'Comp' };

/**
 * Discounts and comps given, by reason, who gave them, who approved them, outlet and kind, from the amounts frozen
 * on each settled sale (a voided sale drops out). `reports.view_discounts` only; a caller without it sees the real
 * 403 in the banner, like the other report tabs. Date-range form sits OUTSIDE the tables (their toolbar slot only
 * renders when there are rows).
 */
export function DiscountsTab({ activeProperty }) {
  const currencyCode = activeProperty?.base_currency;
  const [dateFrom, setDateFrom] = useState(businessDateOf(activeProperty));
  const [dateTo, setDateTo] = useState(businessDateOf(activeProperty));
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  async function runReport(event) {
    event?.preventDefault();
    setError(null);
    setLoading(true);
    try {
      setReport(await discountsApi.getReport({ dateFrom, dateTo }));
    } catch (caught) {
      setReport(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the discounts report.');
    } finally {
      setLoading(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      triggerDownload(await discountsApi.getReportCsv({ dateFrom, dateTo }), `discounts-${dateFrom}-to-${dateTo}.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export the discounts report.');
    } finally {
      setExporting(false);
    }
  }

  const currency = report?.currency ?? currencyCode;
  const hasRun = report !== null;
  const group = (title, rows, label) => (
    <DataTable
      title={title}
      state={loading ? 'loading' : hasRun && rows.length > 0 ? 'success' : 'empty'}
      emptyMessage={hasRun ? 'None in this range.' : 'Choose a date range and run the report.'}
      columns={[
        { key: 'label', label },
        { key: 'count', label: 'Given', align: 'right' },
        { key: 'total', label: 'Total', align: 'right', render: (row) => <Money amount={row.total} currencyCode={currency} /> },
      ]}
      rows={rows}
      rowKey={(row) => row.key}
    />
  );

  return (
    <div>
      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      <form className={styles.toolbar} onSubmit={runReport}>
        <label className={styles.field}>
          <span className={styles.label}>From</span>
          <input type="date" className={styles.input} value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>To</span>
          <input type="date" className={styles.input} value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
        <Button type="submit" loading={loading}>
          Run report
        </Button>
        <Button type="button" variant="secondary" loading={exporting} disabled={!hasRun || report.lines.length === 0} onClick={handleExport}>
          Export CSV
        </Button>
      </form>

      {hasRun && (
        <Card title="Given in this range">
          {report.summary.count === 0 ? (
            <p>No discounts or comps in this range.</p>
          ) : (
            <ul className={styles.summaryList}>
              <li>
                {report.summary.count} given, <Money amount={report.summary.total} currencyCode={currency} /> in all — {report.summary.percentOfSales}% of what would have sold
              </li>
              <li>
                Discounts <Money amount={report.summary.discounts} currencyCode={currency} />
              </li>
              <li>
                Comps ({report.summary.compCount}) <Money amount={report.summary.comps} currencyCode={currency} />
              </li>
            </ul>
          )}
        </Card>
      )}

      {group('By reason', report?.byReason ?? [], 'Reason')}
      {group('By who gave it', report?.byGiver ?? [], 'Given by')}
      {group('By who approved it', report?.byApprover ?? [], 'Approved by')}
      {group('By outlet', report?.byOutlet ?? [], 'Outlet')}

      <DataTable
        title="Every discount and comp"
        state={loading ? 'loading' : hasRun && report.lines.length > 0 ? 'success' : 'empty'}
        emptyMessage={hasRun ? 'None in this range.' : 'Choose a date range and run the report.'}
        columns={[
          { key: 'business_date', label: 'Date' },
          { key: 'outlet', label: 'Outlet' },
          { key: 'kind', label: 'Kind', render: (row) => KIND_LABELS[row.kind] ?? row.kind },
          { key: 'reason', label: 'Reason' },
          { key: 'amount', label: 'Amount', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
          { key: 'given_by', label: 'Given by' },
          { key: 'approved_by', label: 'Approved by', render: (row) => row.approved_by || '—' },
        ]}
        rows={report?.lines ?? []}
        rowKey={(row) => row.id}
      />
    </div>
  );
}
