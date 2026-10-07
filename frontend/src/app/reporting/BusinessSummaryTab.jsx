import { useEffect, useRef, useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { reportingApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import styles from './ReportingScreen.module.css';

/**
 * `reports.view_business` — rooms, each bar/restaurant and the mini-mart on ONE basis: gross money
 * COLLECTED (tax, service and tips included), tied to the Payment Reconciliation report. The basis is
 * stated on the screen; tabs charged to a room are a memo (counted once, when the folio is paid);
 * rooms show gross only; "room charges billed" is a separate memo carrying the Night Audit estimate
 * caveat. One table per currency, never summed across.
 */

const METHOD_COLUMNS = [
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Card' },
  { key: 'transfer', label: 'Transfer' },
  { key: 'nqr', label: 'NQR' },
  { key: 'terminal', label: 'Terminal' },
];

const isZero = (amount) => !amount || /^-?0+(\.0+)?$/.test(amount);

function CurrencyBlock({ table }) {
  const currency = table.currency;
  const showOther = table.rows.some((row) => !isZero(row.byMethod.other)) || !isZero(table.total.byMethod.other);
  const methodColumns = showOther ? [...METHOD_COLUMNS, { key: 'other', label: 'Other' }] : METHOD_COLUMNS;
  const money = (amount) => <Money amount={amount} currencyCode={currency} />;

  const rows = [
    ...table.rows,
    { key: '__total', kind: 'total', label: 'Grand total', byMethod: table.total.byMethod, grossCollected: table.total.grossCollected },
  ];
  const detailRows = table.rows.filter((row) => row.breakdown);

  return (
    <section aria-label={`Business summary in ${currency}`}>
      <DataTable
        title={`Collected by source — ${currency}`}
        state="success"
        columns={[
          { key: 'label', label: 'Source', render: (row) => (row.kind === 'total' ? <strong>{row.label}</strong> : row.label) },
          ...methodColumns.map(({ key, label }) => ({ key, label, align: 'right', render: (row) => money(row.byMethod[key]) })),
          { key: 'grossCollected', label: 'Total collected', align: 'right', render: (row) => <strong>{money(row.grossCollected)}</strong> },
        ]}
        rows={rows}
        rowKey={(row) => row.key}
      />

      <p className={styles.hint} role="status">
        {table.reconciliation.matches ? (
          <>
            Ties to Payment Reconciliation: <Money amount={table.reconciliation.grossTotal} currencyCode={currency} />.
          </>
        ) : (
          <strong role="alert">
            Does not tie to Payment Reconciliation (it shows <Money amount={table.reconciliation.grossTotal} currencyCode={currency} />). Do not rely on this total.
          </strong>
        )}
      </p>

      {detailRows.length > 0 && (
        <DataTable
          title={`Outlets and mini-mart: what the collected figure is made of — ${currency}`}
          state="success"
          columns={[
            { key: 'label', label: 'Outlet' },
            { key: 'net', label: 'Sales before tax', align: 'right', render: (row) => money(row.breakdown.net) },
            { key: 'tax', label: 'Tax', align: 'right', render: (row) => money(row.breakdown.tax) },
            { key: 'service', label: 'Service charge', align: 'right', render: (row) => money(row.breakdown.service) },
            { key: 'tips', label: 'Tips', align: 'right', render: (row) => money(row.breakdown.tips) },
            { key: 'other', label: 'Refunds / unsettled', align: 'right', render: (row) => money(row.breakdown.other) },
            { key: 'grossCollected', label: 'Collected', align: 'right', render: (row) => <strong>{money(row.grossCollected)}</strong> },
            { key: 'chargedToRooms', label: 'Charged to rooms (memo)', align: 'right', render: (row) => money(row.chargedToRooms) },
          ]}
          rows={detailRows}
          rowKey={(row) => row.key}
        />
      )}
    </section>
  );
}

export function BusinessSummaryTab({ activeProperty }) {
  const businessDate = activeProperty?.current_business_date ?? null;
  const fallbackDate = new Date().toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(businessDate ?? fallbackDate);
  const [dateTo, setDateTo] = useState(businessDate ?? fallbackDate);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);

  async function run(from = dateFrom, to = dateTo) {
    const ticket = (latest.current += 1);
    setError(null);
    setLoading(true);
    try {
      const result = await reportingApi.getBusinessSummary({ dateFrom: from, dateTo: to });
      if (ticket === latest.current) setSummary(result);
    } catch (caught) {
      if (ticket !== latest.current) return;
      setSummary(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the business summary.');
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }

  // First load: the default range (the business date). State is set only from the async callbacks.
  useEffect(() => {
    const ticket = (latest.current += 1);
    reportingApi
      .getBusinessSummary({ dateFrom, dateTo })
      .then((result) => {
        if (ticket === latest.current) setSummary(result);
      })
      .catch((caught) => {
        if (ticket === latest.current) setError(caught instanceof ApiError ? caught.message : 'Could not load the business summary.');
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      triggerDownload(await reportingApi.getBusinessSummaryCsv({ dateFrom, dateTo }), `business-summary-${dateFrom}-to-${dateTo}.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export the business summary.');
    } finally {
      setExporting(false);
    }
  }

  const memo = summary?.roomChargesBilled;

  return (
    <div>
      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      <form
        className={styles.toolbar}
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
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
        <Button type="button" variant="secondary" loading={exporting} disabled={!summary} onClick={handleExport}>
          Export CSV
        </Button>
      </form>

      {loading && !summary && <p className={styles.loading}>Loading business summary…</p>}

      {summary && (
        <>
          <p className={styles.hint}>
            <strong>Basis: gross collected.</strong> {summary.basisNote}
          </p>

          {summary.currencies.map((table) => (
            <CurrencyBlock key={table.currency} table={table} />
          ))}

          {memo && (
            <Card title="Memo: room charges billed (before tax)">
              <p>
                <Money amount={memo.amount} currencyCode={memo.currency} />{' '}
                {memo.estimate ? <StatusPill tone="warning" label="Estimate" /> : <StatusPill tone="success" label="Night Audit closed" />}
              </p>
              <p className={styles.hint}>
                {memo.estimate
                  ? `Provisional: ${memo.unauditedDates.length === 1 ? 'this day is' : `${memo.unauditedDates.length} days are`} not yet closed by Night Audit (${memo.unauditedDates.join(', ')}), so this is booked-rate revenue, not final. It is not part of the collected totals above.`
                  : 'Every day in range is closed by Night Audit. This is billed revenue, not money collected, so it is not part of the totals above.'}
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
