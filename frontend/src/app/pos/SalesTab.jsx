import { useEffect, useState } from 'react';
import { DataTable, Button, Toast, StatusPill } from '../../shared/components/index.js';
import { ManagerApprovalDialog } from '../approvals/ManagerApprovalDialog.jsx';
import { RefundCardSaleDialog } from './RefundCardSaleDialog.jsx';
import { StuckRefundNote, ClearStuckRefundDialog } from '../cashiering/StuckRefund.jsx';
import { terminalProviderLabel, terminalAccountText } from '../../shared/terminalProviders.js';
import { Money } from '../../shared/format/money.jsx';
import { posApi, cashieringApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import formStyles from './POSForm.module.css';
import styles from './SalesTab.module.css';
import { pointOfSaleOutlets } from './outletTypes.js';

const TENDER_LABELS = { cash: 'Cash', card: 'Card', nqr: 'NQR', terminal: 'Card (external terminal)', room_charge: 'Charge to room' };

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
  if (payment.tender === 'terminal' && payment.terminalProvider) parts.push(terminalProviderLabel(payment.terminalProvider));
  const account = payment.tender === 'terminal' ? terminalAccountText(payment.terminalAccountLabel, payment.terminalAccountLast4) : null;
  if (account) parts.push(account);
  if (payment.roomNumber) parts.push(`Room ${payment.roomNumber}${payment.guestName ? ` (${payment.guestName})` : ''}`);
  return parts.join(' · ');
}

/** The receipt number with the cashier's name for the tab — "#63 · Pool bar – John" — so tabs sharing a name like "Table 1" stay distinguishable. */
function tabName(row) {
  return row.tableLabel ? `#${row.orderId} · ${row.tableLabel}` : `#${row.orderId}`;
}

/** `null` is a genuinely unknown cost — never shown as a false zero. */
function moneyOrUnknown(amount, currencyCode) {
  return amount === null || amount === undefined ? 'Unknown' : <Money amount={amount} currencyCode={currencyCode} />;
}

function formatPercent(value) {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const REFUND_STATE_PILL = {
  refund_pending: { tone: 'warning', label: 'Refund pending' },
  refunded: { tone: 'success', label: 'Refunded' },
  partially_refunded: { tone: 'info', label: 'Partly refunded' },
};

/**
 * The Refund control for one settled tab's card payments: a button for a refundable sale; for one that is not, the
 * refund's status (pending / refunded) and the reason the button is off, in words.
 */
function CardSaleRefundCell({ sales, isOffline, onRefund }) {
  if (sales.length === 0) return null;
  return (
    <div className={styles.refundCell}>
      {sales.map((sale) => {
        const pill = REFUND_STATE_PILL[sale.state];
        return (
          <div key={sale.paymentId} className={styles.refundCell}>
            {pill && <StatusPill tone={pill.tone} label={pill.label} />}
            <Button type="button" size="compact" variant="secondary" disabled={isOffline || sale.state !== 'refundable'} onClick={() => onRefund(sale)}>
              Refund
            </Button>
            {sale.disabledReason && <span className={formStyles.hint}>{sale.disabledReason}</span>}
          </div>
        );
      })}
    </div>
  );
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
 *
 * A card sale that WAS settled is refunded from its row in "Settled tabs"
 * (`canRefundCardSales` = the user holds `cashiering.void_line`): a reason
 * picker, then a manager's PIN. The sale stays in the figures on its own day;
 * the refund is a separate negative line on the day it was processed, so
 * "Net sales" = sales settled in the range minus refunds processed in it.
 */
export function SalesTab({ activeProperty, isOffline = false, canClearRefunds = false, canRefundCardSales = false }) {
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
  const [cardSales, setCardSales] = useState([]);
  const [refundingSale, setRefundingSale] = useState(null);
  const [clearing, setClearing] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    posApi
      .listOutlets()
      .then((rows) => setOutlets(pointOfSaleOutlets(rows)))
      .catch(() => setOutlets([]));
  }, []);

  async function runReport(event) {
    event?.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const filters = { dateFrom, dateTo, outletId: outletId || undefined };
      const [nextReport, nextCardSales] = await Promise.all([
        posApi.getSalesReport(filters),
        // Where each settled card sale's refund stands. Only for someone who may start a refund; a failure here never hides the report.
        canRefundCardSales ? posApi.listCardSales(filters).catch(() => null) : Promise.resolve([]),
      ]);
      setReport(nextReport);
      setCardSales(nextCardSales ?? []);
      if (nextCardSales === null) setError('Refund status could not be loaded, so the Refund buttons are hidden. Run the report again.');
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

  // A manager approved this refund with their PIN; the approval goes with the request (header), used once.
  async function confirmRefund(approval, reason) {
    const payment = refunding;
    setRefunding(null);
    setError(null);
    try {
      await cashieringApi.refundPayment(payment.paymentId, { reason, approval });
      setToast('Refund sent to Paystack.');
      await runReport();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not refund this payment.');
    }
  }

  // A manager approved this refund of a settled card sale with their PIN; the server refunds exactly what was captured.
  async function confirmCardSaleRefund({ reasonCode, reasonNote, approval }) {
    const sale = refundingSale;
    setRefundingSale(null);
    setError(null);
    try {
      await posApi.refundCardSale(sale.paymentId, { reasonCode, reasonNote, approval });
      setToast('Refund sent to Paystack.');
      await runReport();
    } catch (caught) {
      // Refresh first (it clears any message), then say why: the sale's status may have changed under the cashier.
      await runReport();
      setError(caught instanceof ApiError ? caught.message : 'Could not refund this card sale.');
    }
  }

  const cardSalesByOrder = new Map();
  for (const sale of cardSales) cardSalesByOrder.set(String(sale.orderId), [...(cardSalesByOrder.get(String(sale.orderId)) ?? []), sale]);
  const refunds = report?.refunds ?? null;

  // Card refunds Paystack accepted (or may have taken) but never confirmed: listed so the guest's money is not lost track of.
  const refundsInFlight = (report?.tabs ?? []).flatMap((tab) => (tab.payments ?? []).filter((payment) => payment.refundInFlight).map((payment) => ({ tab, payment, refund: payment.refundInFlight })));

  const tableState = (rows) => (loading ? 'loading' : report === null || rows.length === 0 ? 'empty' : 'success');
  const emptyMessage = report === null ? 'Choose a date range and run the report.' : 'No sales in this range.';
  const exportDisabled = (rows) => report === null || rows.length === 0 || exporting !== null;
  // Older/other responses without profit figures simply show no profit columns.
  const profit = report?.summary?.profit ?? null;

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
            <span className={styles.statLabel}>{report.summary.refunds ? 'Sales (before refunds)' : 'Total sales'}</span>
            <span className={styles.statValue}>
              <Money amount={report.summary.total} currencyCode={currencyCode} />
            </span>
          </div>
          {report.summary.refunds && (
            <>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Refunds ({report.summary.refunds.count})</span>
                <span className={styles.statValue}>
                  <Money amount={report.summary.refunds.total} currencyCode={currencyCode} />
                </span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Net sales</span>
                <span className={styles.statValue}>
                  <Money amount={report.summary.netTotal} currencyCode={currencyCode} />
                </span>
              </div>
            </>
          )}
          {profit && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>Profit</span>
              <span className={styles.statValue}>{moneyOrUnknown(profit.profit, currencyCode)}</span>
              <span className={styles.statLabel}>{profit.marginPct === null ? 'No margin yet' : `${formatPercent(profit.marginPct)} margin`}</span>
            </div>
          )}
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

      {profit && (
        <p className={formStyles.hint}>
          Profit is item sales before tax, tip and service charge, minus what those items cost (their recipe, else their cost price).
          {profit.cost !== null && (
            <>
              {' '}
              Cost of these sales: <Money amount={profit.cost} currencyCode={currencyCode} />.
            </>
          )}
          {profit.itemsWithUnknownCost > 0 &&
            ` ${profit.itemsWithUnknownCost} item${profit.itemsWithUnknownCost === 1 ? ' has' : 's have'} no recipe or cost price set, so ${profit.itemsWithUnknownCost === 1 ? 'it is' : 'they are'} left out of profit.`}
        </p>
      )}

      <DataTable
        title="Sales by outlet"
        state={tableState(report?.byOutlet ?? [])}
        emptyMessage={emptyMessage}
        toolbar={
          <Button type="button" size="compact" variant="secondary" disabled={exportDisabled(report?.byOutlet ?? [])} loading={exporting === 'outlets'} onClick={() => handleExport('outlets')}>
            Export CSV
          </Button>
        }
        columns={[
          { key: 'name', label: 'Outlet' },
          { key: 'tabs', label: 'Tabs', align: 'right' },
          { key: 'subtotal', label: 'Sales (before tax)', align: 'right', render: (row) => <Money amount={row.subtotal} currencyCode={currencyCode} /> },
          { key: 'tax', label: 'Tax', align: 'right', render: (row) => <Money amount={row.tax} currencyCode={currencyCode} /> },
          { key: 'serviceCharge', label: 'Service charge', align: 'right', render: (row) => <Money amount={row.serviceCharge} currencyCode={currencyCode} /> },
          { key: 'total', label: 'Total', align: 'right', render: (row) => <Money amount={row.total} currencyCode={currencyCode} /> },
          ...(refunds
            ? [
                { key: 'refunded', label: 'Refunds', align: 'right', render: (row) => (row.refunded ? <Money amount={row.refunded} currencyCode={currencyCode} /> : '—') },
                { key: 'net', label: 'Net', align: 'right', render: (row) => <Money amount={row.net ?? row.total} currencyCode={currencyCode} /> },
              ]
            : []),
        ]}
        rows={report?.byOutlet ?? []}
        rowKey={(row) => row.outletId}
      />

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
          ...(profit
            ? [
                { key: 'cost', label: 'Cost', align: 'right', render: (row) => moneyOrUnknown(row.cost, currencyCode) },
                { key: 'profit', label: 'Profit', align: 'right', render: (row) => moneyOrUnknown(row.profit, currencyCode) },
                { key: 'marginPct', label: 'Margin %', align: 'right', render: (row) => formatPercent(row.marginPct) },
              ]
            : []),
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
          {
            key: 'tenders',
            label: 'Paid by',
            render: (row) => {
              const text = row.payments?.length ? row.payments.map(describePayment).join(' + ') : row.tenders.map(tenderLabel).join(' + ');
              return row.refunded ? `${text} (refunded)` : text;
            },
          },
          { key: 'itemCount', label: 'Items', align: 'right' },
          { key: 'cashier', label: 'Cashier', render: (row) => row.cashier ?? (row.source === 'guest' ? 'Guest order' : '—') },
          { key: 'total', label: 'Total', align: 'right', render: (row) => <Money amount={row.total} currencyCode={currencyCode} /> },
          ...(canRefundCardSales ? [{ key: 'refund', label: 'Refund', align: 'right', render: (row) => <CardSaleRefundCell sales={cardSalesByOrder.get(String(row.orderId)) ?? []} isOffline={isOffline} onRefund={setRefundingSale} /> }] : []),
          ...(profit
            ? [
                {
                  key: 'profit',
                  label: 'Profit',
                  align: 'right',
                  // A tab with an item whose cost isn't set shows profit on the priced items only — said so, not hidden.
                  render: (row) => (
                    <>
                      {moneyOrUnknown(row.profit, currencyCode)}
                      {row.costComplete === false && row.profit !== null && <span className={formStyles.hint}> (priced items only)</span>}
                    </>
                  ),
                },
              ]
            : []),
        ]}
        rows={report?.tabs ?? []}
        rowKey={(row) => row.orderId}
      />

      {refunds && (
        <DataTable
          title="Refunds processed in this period"
          state="success"
          toolbar={
            <Button type="button" size="compact" variant="secondary" disabled={exporting !== null} loading={exporting === 'refunds'} onClick={() => handleExport('refunds')}>
              Export CSV
            </Button>
          }
          columns={[
            { key: 'refundedAt', label: 'Refunded', render: (row) => formatTime(row.refundedAt) },
            { key: 'refundDate', label: 'Counts on' },
            { key: 'tab', label: 'Tab', render: (row) => tabName(row) },
            { key: 'originalBusinessDate', label: 'Sold on' },
            { key: 'reason', label: 'Reason', render: (row) => row.reason ?? '—' },
            { key: 'amount', label: 'Refund', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
          ]}
          rows={refunds.lines}
          rowKey={(row) => row.refundPaymentId}
        />
      )}

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

      {refundsInFlight.length > 0 && (
        <DataTable
          title="Card refunds waiting on Paystack"
          state="success"
          columns={[
            { key: 'tab', label: 'Tab', render: (row) => tabName(row.tab) },
            { key: 'amount', label: 'Refund', align: 'right', render: (row) => <Money amount={row.refund.amount} currencyCode={currencyCode} /> },
            { key: 'status', label: 'Status', render: (row) => <StuckRefundNote reconciliation={row.refund} /> },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (row) =>
                canClearRefunds && row.refund.canClear ? (
                  <Button type="button" size="compact" variant="danger" disabled={isOffline} onClick={() => setClearing(row)}>
                    Clear stuck refund
                  </Button>
                ) : null,
            },
          ]}
          rows={refundsInFlight}
          rowKey={(row) => row.refund.refundPaymentId}
        />
      )}

      {clearing && (
        <ClearStuckRefundDialog
          refundPaymentId={clearing.refund.refundPaymentId}
          amountText={`${clearing.refund.amount} ${currencyCode}`}
          isOffline={isOffline}
          onCancel={() => setClearing(null)}
          onError={(message) => {
            setClearing(null);
            setError(message);
          }}
          onDone={async (result) => {
            setClearing(null);
            setToast(result?.cleared ? 'The stuck refund was cleared.' : 'Paystack had already processed this refund; it is now recorded.');
            await runReport();
          }}
        />
      )}

      {refundingSale && <RefundCardSaleDialog sale={refundingSale} isOffline={isOffline} onApproved={confirmCardSaleRefund} onCancel={() => setRefundingSale(null)} />}

      {refunding && (
        <ManagerApprovalDialog
          action="pos.refund_payment"
          targetId={refunding.paymentId}
          title="Refund card payment"
          consequence={`This sends a refund to Paystack for ${tabName(refunding)}. The guest gets their money back and this cannot be undone.`}
          confirmLabel="Approve refund"
          isOffline={isOffline}
          onApproved={confirmRefund}
          onCancel={() => setRefunding(null)}
        />
      )}
    </div>
  );
}
