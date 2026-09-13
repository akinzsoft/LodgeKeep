import { useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { reportingApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import styles from './ReportingScreen.module.css';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `reports.view_financial` only (SECURITY.md §5's matrix) — front_desk and
 * cashier's "Limited" cell (`reports.view`) does not include this tab's
 * data. No client-side permission check hides this tab (this codebase's UI
 * RBAC is convenience only, per CLAUDE.md); a caller without the grant sees
 * the real backend 403 in the error banner below, same as everywhere else.
 *
 * Bug fix (see `ReportingScreen`'s own header): every `Money` here used to
 * fall back to `?? 'USD'` for the rare window `activeProperty` was still
 * null — a real, silent currency misstatement, not a safe default
 * (`shared/format/money.jsx`'s own header: "a defaulted currency is a
 * silent misstatement of an amount, not a convenience"). `ReportingScreen`
 * now guarantees a real `activeProperty` before this tab ever mounts, so
 * the fallback is gone rather than papered over again.
 */
export function RevenueTab({ activeProperty }) {
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  async function runReport(event) {
    event?.preventDefault();
    setError(null);
    try {
      setRows(await reportingApi.getRevenueReport({ dateFrom, dateTo }));
    } catch (caught) {
      setRows([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the revenue report.');
    }
  }

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const blob = await reportingApi.getRevenueReportCsv({ dateFrom, dateTo });
      triggerDownload(blob, `revenue-${dateFrom}-to-${dateTo}.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export the revenue report.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      {/* Outside DataTable's toolbar slot — see OccupancyTab's own comment
          for why: Card only renders `children` while state === 'success'. */}
      <form className={styles.toolbar} onSubmit={runReport}>
        <label className={styles.field}>
          <span className={styles.label}>From</span>
          <input type="date" className={styles.input} value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>To</span>
          <input type="date" className={styles.input} value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
        <Button type="submit">Run report</Button>
        <Button type="button" variant="secondary" loading={exporting} disabled={rows === null || rows.length === 0} onClick={handleExport}>
          Export CSV
        </Button>
      </form>
      <DataTable
        title="Revenue"
        state={rows === null || rows.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the report."
        columns={[
          { key: 'date', label: 'Date' },
          {
            key: 'roomRevenue',
            label: 'Room revenue',
            align: 'right',
            render: (row) => <Money amount={row.roomRevenue} currencyCode={activeProperty.base_currency} />,
          },
          { key: 'roomsSold', label: 'Rooms sold', align: 'right' },
          { key: 'adr', label: 'ADR', align: 'right', render: (row) => <Money amount={row.adr} currencyCode={activeProperty.base_currency} /> },
          {
            key: 'revpar',
            label: 'RevPAR',
            align: 'right',
            render: (row) => <Money amount={row.revpar} currencyCode={activeProperty.base_currency} />,
          },
          {
            key: 'paymentsCollected',
            label: 'Payments collected',
            align: 'right',
            // Gap closure (found while testing the Reporting menu): the
            // backend has always computed and returned this figure for
            // every AUDITED day (`daily_reports.payments_collected`,
            // src/modules/reporting/service.js's own computeRevenue) —
            // nothing on this screen ever displayed it. Genuinely absent,
            // not just falsy, for the current live/unaudited day (the
            // backend never computes it outside a real Night Audit
            // snapshot), so it renders the same "—" placeholder the
            // Physical rooms column uses for its own equally real gap.
            render: (row) => (row.paymentsCollected != null ? <Money amount={row.paymentsCollected} currencyCode={activeProperty.base_currency} /> : '—'),
          },
        ]}
        rows={rows ?? []}
        rowKey={(row) => row.date}
      />
    </div>
  );
}
