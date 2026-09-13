import { useEffect, useState } from 'react';
import { DataTable, Button, ConfirmDialog, Toast } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { posApi, cashieringApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import formStyles from './POSForm.module.css';
import styles from './SalesTab.module.css';

const TENDER_LABELS = { cash: 'Cash', card: 'Card', nqr: 'NQR', room_charge: 'Charge to room' };

// Paystack's own channel names, for a Card checkout paid some other way.
const CHANNEL_LABELS = { card: 'card', ussd: 'USSD', bank: 'bank', bank_transfer: 'bank transfer', qr: 'QR', mobile_money: 'mobile money', eft: 'EFT', apple_pay: 'Apple Pay' };

function tenderLabel(tender) {
  return TENDER_LABELS[tender] ?? tender;
}

/** One check's payment in words: "Cash", "Card · USSD", "Charge to room · Room 205 (Ada Bello)". */
function describePayment(payment) {
  const parts = [tenderLabel(payment.tender)];
  if (payment.channel && payment.channel !== payment.tender && !(payment.tender === 'nqr' && payment.channel === 'qr')) {
    parts.push(CHANNEL_LABELS[payment.channel] ?? payment.channel);
  }
  if (payment.roomNumber) parts.push(`Room ${payment.roomNumber}${payment.guestName ? ` (${payment.guestName})` : ''}`);
  return parts.join(' · ');
}

/** The receipt number with the cashier's name for the tab — "#63 · Pool bar – John" — so tabs sharing a name like "Table 1" stay distinguishable. */
function tabName(row) {
  return row.tableLabel ? `#${row.orderId} · ${row.tableLabel}` : `#${row.orderId}`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * SalesTab — what the Register took over a business-date range: totals per
 * tender, top-selling items, every settled tab, and CSV export of each.
 * Backed by `GET /pos/reports/sales` (`pos.manage`); a lower-tier account
 * sees the real 403 rather than a hidden tab, like every POS tab.
 *
 * Dates default to the property's business date (ARCHITECTURE.md §6), not
 * the wall clock, matching what the report filters on.
 *
 * "Card payments to refund" lists money Paystack captured that no standing
 * settlement uses — e.g. a guest who paid after their tab was removed. A
 * refund goes through Cashiering's own refund endpoint
 * (`cashiering.void_line`), with a required reason.
 */
export function SalesTab({ activeProperty, isOffline = false }) {
  const defaultDate = activeProperty.current_business_date ?? new Date().toISOString().slice(0, 10);
  const currencyCode = activeProperty.base_currency;

  const [outlets, setOutlets] = useState(null);
  const [outletId, setOutletId] = useState('');
  const [dateFrom, setDateFrom] = useState(defaultDate);
  const [dateTo, setDateTo] = useState(defaultDate);

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(null);
  const [refunding, setRefunding] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
  }, []);

  async function runReport(event) {
    event?.preventDefault();
    setError(null);
    setLoading(true);
    try {
      setReport(await posApi.getSalesReport({ dateFrom, dateTo, outletId: outletId || undefined }));
    } catch (caught) {
      setReport(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the sales report.');
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(section) {
    setExporting(section);
    setError(null);
    try {
      // Export exactly what is on screen — the filters the report was run
      // with, not whatever the form has been changed to since.
      const shown = { dateFrom: report.dateFrom, dateTo: report.dateTo, outletId: report.outletId ?? undefined };
      const blob = await posApi.getSalesReportCsv(shown, section);
      triggerDownload(blob, `pos-sales-${section}-${shown.dateFrom}-to-${shown.dateTo}.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export the report.');
    } finally {
      setExporting(null);
    }
  }

  async function confirmRefund(reason) {
    const payment = refunding;
    setRefunding(null);
    setError(null);
    try {
      await cashieringApi.refundPayment(payment.paymentId, { reason });
      setToast('Refund sent to Paystack.');
      await runReport();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not refund this payment.');
    }
  }

  const tableState = (rows) => (loading ? 'loading' : report === null || rows.length === 0 ? 'empty' : 'success');
  const emptyMessage = report === null ? 'Choose a date range and run the report.' : 'No sales in this range.';
  const exportDisabled = (rows) => report === null || rows.length === 0 || exporting !== null;

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}

      {/* Outside every DataTable — Card only renders its children in the
          success state, so the filters must never live inside one. */}
      <form className={formStyles.row} onSubmit={runReport}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Outlet</span>
          <select className={formStyles.select} value={outletId} onChange={(event) => setOutletId(event.target.value)}>
            <option value="">All outlets</option>
            {(outlets ?? []).map((outlet) => (
              <option key={outlet.id} value={outlet.id}>
                {outlet.name}
              </option>
            ))}
          </select>
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>From</span>
          <input type="date" className={formStyles.input} value={dateFrom} max={dateTo} onChange={(event) => setDateFrom(event.target.value)} required />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>To</span>
          <input type="date" className={formStyles.input} value={dateTo} min={dateFrom} onChange={(event) => setDateTo(event.target.value)} required />
        </label>
        <div className={formStyles.actionsRow}>
          <Button type="submit" loading={loading}>
            Run report
          </Button>
        </div>
      </form>

      {report && (
        <section className={styles.summary} aria-label="Sales summary">
          <div className={styles.stat}>
            <span className={styles.statLabel}>Total sales</span>
            <span className={styles.statValue}>
              <Money amount={report.summary.total} currencyCode={currencyCode} />
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Tabs settled</span>
            <span className={styles.statValue}>{report.summary.tabs}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Service charge</span>
            <span className={styles.statValue}>
              <Money amount={report.summary.serviceCharge} currencyCode={currencyCode} />
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Tax</span>
            <span className={styles.statValue}>
              <Money amount={report.summary.tax} currencyCode={currencyCode} />
            </span>
          </div>
        </section>
      )}

      <DataTable
        title="Totals by payment method"
        state={tableState(report?.byTender ?? [])}
        emptyMessage={emptyMessage}
        toolbar={
          <Button type="button" size="compact" variant="secondary" disabled={exportDisabled(report?.byTender ?? [])} loading={exporting === 'tenders'} onClick={() => handleExport('tenders')}>
            Export CSV
          </Button>
        }
        columns={[
          { key: 'tender', label: 'Payment method', render: (row) => tenderLabel(row.tender) },
          { key: 'checks', label: 'Checks', align: 'right' },
          { key: 'total', label: 'Total', align: 'right', render: (row) => <Money amount={row.total} currencyCode={currencyCode} /> },
        ]}
        rows={report?.byTender ?? []}
        rowKey={(row) => row.tender}
      />

      <DataTable
        title="Top-selling items"
        state={tableState(report?.topItems ?? [])}
        emptyMessage={emptyMessage}
        toolbar={
          <Button type="button" size="compact" variant="secondary" disabled={exportDisabled(report?.topItems ?? [])} loading={exporting === 'items'} onClick={() => handleExport('items')}>
            Export CSV
          </Button>
        }
        columns={[
          { key: 'name', label: 'Item' },
          { key: 'quantity', label: 'Qty sold', align: 'right' },
          { key: 'sales', label: 'Sales (before tax)', align: 'right', render: (row) => <Money amount={row.sales} currencyCode={currencyCode} /> },
        ]}
        rows={report?.topItems ?? []}
        rowKey={(row) => row.menuItemId}
      />

      <DataTable
        title="Settled tabs"
        state={tableState(report?.tabs ?? [])}
        emptyMessage={emptyMessage}
        toolbar={
          <Button type="button" size="compact" variant="secondary" disabled={exportDisabled(report?.tabs ?? [])} loading={exporting === 'tabs'} onClick={() => handleExport('tabs')}>
            Export CSV
          </Button>
        }
        columns={[
          { key: 'settledAt', label: 'Settled', render: (row) => formatTime(row.settledAt) },
          { key: 'tableLabel', label: 'Tab', render: (row) => tabName(row) },
          { key: 'tenders', label: 'Paid by', render: (row) => (row.payments?.length ? row.payments.map(describePayment).join(' + ') : row.tenders.map(tenderLabel).join(' + ')) },
          { key: 'itemCount', label: 'Items', align: 'right' },
          { key: 'cashier', label: 'Cashier', render: (row) => row.cashier ?? (row.source === 'guest' ? 'Guest order' : '—') },
          { key: 'total', label: 'Total', align: 'right', render: (row) => <Money amount={row.total} currencyCode={currencyCode} /> },
        ]}
        rows={report?.tabs ?? []}
        rowKey={(row) => row.orderId}
      />

      {report && report.unsettledCardPayments.length > 0 && (
        <DataTable
          title="Card payments to refund"
          state="success"
          columns={[
            { key: 'capturedAt', label: 'Paid', render: (row) => formatTime(row.capturedAt) },
            { key: 'tableLabel', label: 'Tab', render: (row) => tabName(row) },
            { key: 'tender', label: 'Paid by', render: (row) => tenderLabel(row.tender) },
            { key: 'amount', label: 'Amount', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (row) => (
                <Button type="button" size="compact" variant="secondary" disabled={isOffline} onClick={() => setRefunding(row)}>
                  Refund
                </Button>
              ),
            },
          ]}
          rows={report.unsettledCardPayments}
          rowKey={(row) => row.paymentId}
        />
      )}

      {refunding && (
        <ConfirmDialog
          title="Refund card payment"
          consequence={`This sends a refund to Paystack for ${tabName(refunding)}. The guest gets their money back and this cannot be undone.`}
          requireReason
          confirmLabel="Refund"
          onConfirm={confirmRefund}
          onCancel={() => setRefunding(null)}
        />
      )}
    </div>
  );
}
