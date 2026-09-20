import { useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { reconciliationApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import styles from './ReportingScreen.module.css';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** "Reconciliation Bar" or "Reconciliation Bar · QR" — a POS line's outlet plus a badge when a guest placed the order themselves; a folio line's source has no channel at all. */
function describeSource(source) {
  if (!source) return '—';
  if (source.channel === 'guest') return `${source.label} · QR`;
  return source.label;
}

/**
 * `reconciliation.view` only (SECURITY.md §5's matrix — manager/admin/
 * super_admin, no front-desk/cashier/housekeeping/pos_operator access). No
 * client-side permission check hides this tab (this codebase's UI RBAC is
 * convenience only, per CLAUDE.md); a caller without the grant sees the
 * real backend 403 in the error banner below, same as `RevenueTab`.
 *
 * Modeled directly on `pos/SalesTab.jsx` and `RevenueTab.jsx` — a
 * date-range form outside `DataTable`'s own toolbar slot (`Card`/`DataTable`
 * only render `children` while `state === 'success'`, so an interactive
 * control inside it goes unreachable the moment the table is empty), a
 * summary card, two breakdown tables, and the full line-item ledger with a
 * CSV export mirroring the on-screen filters exactly.
 */
export function PaymentReconciliationTab() {
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  async function runReport(event) {
    event?.preventDefault();
    setError(null);
    try {
      setReport(await reconciliationApi.getPaymentReconciliation({ dateFrom, dateTo }));
    } catch (caught) {
      setReport({ summary: [], bySource: [], byMethod: [], lines: [] });
      setError(caught instanceof ApiError ? caught.message : 'Could not load the reconciliation report.');
    }
  }

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const blob = await reconciliationApi.getPaymentReconciliationCsv({ dateFrom, dateTo });
      triggerDownload(blob, `payment-reconciliation-${dateFrom}-to-${dateTo}.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export the reconciliation report.');
    } finally {
      setExporting(false);
    }
  }

  const lines = report?.lines ?? [];
  const hasRun = report !== null;

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
        <Button type="submit">Run report</Button>
        <Button type="button" variant="secondary" loading={exporting} disabled={lines.length === 0} onClick={handleExport}>
          Export CSV
        </Button>
      </form>

      {hasRun && (
        <Card title="Gross vs net, by currency">
          {(report.summary ?? []).length === 0 ? (
            <p>No payments in this range.</p>
          ) : (
            <ul className={styles.summaryList}>
              {report.summary.map((row) => (
                <li key={row.currency}>
                  {row.count} payment{row.count === 1 ? '' : 's'} — gross <Money amount={row.grossTotal} currencyCode={row.currency} />, fee{' '}
                  <Money amount={row.feeTotal} currencyCode={row.currency} />, net <Money amount={row.netTotal} currencyCode={row.currency} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <DataTable
        title="By source"
        state={hasRun && (report.bySource ?? []).length > 0 ? 'success' : 'empty'}
        emptyMessage={hasRun ? 'No payments in this range.' : 'Choose a date range and run the report.'}
        columns={[
          { key: 'source', label: 'Source', render: (row) => describeSource(row.source) },
          { key: 'count', label: 'Payments', align: 'right' },
          { key: 'grossTotal', label: 'Gross', align: 'right', render: (row) => <Money amount={row.grossTotal} currencyCode={row.currency} /> },
          { key: 'netTotal', label: 'Net', align: 'right', render: (row) => <Money amount={row.netTotal} currencyCode={row.currency} /> },
        ]}
        rows={report?.bySource ?? []}
        rowKey={(row) => `${row.currency}-${row.source.kind}-${row.source.label}-${row.source.channel ?? ''}`}
      />

      <DataTable
        title="By method"
        state={hasRun && (report.byMethod ?? []).length > 0 ? 'success' : 'empty'}
        emptyMessage={hasRun ? 'No payments in this range.' : 'Choose a date range and run the report.'}
        columns={[
          { key: 'method', label: 'Method' },
          { key: 'count', label: 'Payments', align: 'right' },
          { key: 'grossTotal', label: 'Gross', align: 'right', render: (row) => <Money amount={row.grossTotal} currencyCode={row.currency} /> },
        ]}
        rows={report?.byMethod ?? []}
        rowKey={(row) => `${row.currency}-${row.method}`}
      />

      <DataTable
        title="Every payment in range"
        state={hasRun && lines.length > 0 ? 'success' : 'empty'}
        emptyMessage={hasRun ? 'No payments in this range.' : 'Choose a date range and run the report.'}
        columns={[
          { key: 'businessDate', label: 'Date' },
          { key: 'source', label: 'Source', render: (row) => describeSource(row.source) },
          { key: 'method', label: 'Method' },
          { key: 'providerChannel', label: 'Channel', render: (row) => row.providerChannel ?? '—' },
          {
            key: 'grossAmount',
            label: 'Gross',
            align: 'right',
            render: (row) => <Money amount={row.grossAmount} currencyCode={row.currency} />,
          },
          { key: 'feeAmount', label: 'Fee', align: 'right', render: (row) => <Money amount={row.feeAmount} currencyCode={row.currency} /> },
          { key: 'netAmount', label: 'Net', align: 'right', render: (row) => <Money amount={row.netAmount} currencyCode={row.currency} /> },
          { key: 'providerReference', label: 'Reference', render: (row) => row.providerReference ?? '—' },
          { key: 'providerPaymentId', label: 'Provider payment id', render: (row) => row.providerPaymentId ?? '—' },
          { key: 'guestName', label: 'Guest', render: (row) => row.guestName ?? '—' },
          { key: 'roomNumber', label: 'Room', render: (row) => row.roomNumber ?? '—' },
        ]}
        rows={lines}
        rowKey={(row) => `${row.paymentId}-${row.isRefund ? 'refund' : 'payment'}-${row.capturedAt}`}
      />
    </div>
  );
}
