import { useEffect, useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { arApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import formStyles from './ARForm.module.css';

/**
 * AgeingTab — TESTING.md AR-2 ("Ageing buckets — correct at 30/60/90
 * boundaries"), PRODUCT_REQUIREMENTS.md's "Accounts Receivable — aged
 * balance table by company." A live snapshot as of the active property's
 * own current business date (`ar/service.js`'s `computeAgeingReport`
 * header — ARCHITECTURE.md §6, never wall-clock), the same "fetch-on-mount,
 * Refresh to re-pull" shape `OutstandingBalancesTab` already established
 * for a comparable live report.
 *
 * `computeAgeingReport`'s own rows carry no per-row currency column — each
 * `ar_accounts` row has its own (`createArAccount`'s `currency` param), so
 * this cross-references the accounts list (already fetched by `AccountsTab`,
 * fetched again here rather than shared state, matching every other tab's
 * own independent-fetch precedent in this app) to resolve one per row.
 */
export function AgeingTab({ isOffline = false }) {
  const [report, setReport] = useState(null);
  const [currencyByAccount, setCurrencyByAccount] = useState({});
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  async function reload() {
    setError(null);
    try {
      const [ageingReport, accounts] = await Promise.all([arApi.getAgeingReport(), arApi.listAccounts()]);
      setReport(ageingReport);
      setCurrencyByAccount(Object.fromEntries(accounts.map((account) => [String(account.id), account.currency])));
    } catch (caught) {
      setReport({ rows: [], asOfDate: null, total: null });
      setError(caught instanceof ApiError ? caught.message : 'Could not load the ageing report.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const blob = await arApi.getAgeingReportCsv();
      triggerDownload(blob, 'ar-ageing.csv');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export the ageing report.');
    } finally {
      setExporting(false);
    }
  }

  const rows = report?.rows ?? null;
  const currencyFor = (row) => currencyByAccount[String(row.arAccountId)] ?? 'NGN';

  return (
    <div>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {report?.asOfDate && <p className={formStyles.disabledNotice}>As of business date {report.asOfDate}.</p>}

      <div className={formStyles.actionsRow}>
        <Button type="button" variant="secondary" onClick={reload} disabled={isOffline}>
          Refresh
        </Button>
        <Button type="button" variant="secondary" loading={exporting} disabled={isOffline || rows === null || rows.length === 0} onClick={handleExport}>
          Export CSV
        </Button>
      </div>

      <DataTable
        title="Aged balances by company"
        state={rows === null ? 'loading' : rows.length === 0 ? 'empty' : 'success'}
        emptyMessage="No AR accounts to age — nothing owed."
        columns={[
          { key: 'companyName', label: 'Company', render: (row) => row.companyName ?? `Company ${row.companyProfileId}` },
          { key: 'currentBalance', label: 'Balance', align: 'right', render: (row) => <Money amount={row.currentBalance} currencyCode={currencyFor(row)} /> },
          { key: 'current', label: 'Current', align: 'right', render: (row) => <Money amount={row.current} currencyCode={currencyFor(row)} /> },
          { key: 'bucket_1_30', label: '1-30 days', align: 'right', render: (row) => <Money amount={row.bucket_1_30} currencyCode={currencyFor(row)} /> },
          { key: 'bucket_31_60', label: '31-60 days', align: 'right', render: (row) => <Money amount={row.bucket_31_60} currencyCode={currencyFor(row)} /> },
          { key: 'bucket_61_90', label: '61-90 days', align: 'right', render: (row) => <Money amount={row.bucket_61_90} currencyCode={currencyFor(row)} /> },
          {
            key: 'bucket_90_plus',
            label: '90+ days',
            align: 'right',
            // String-identity comparison, never a numeric parse, for a money decision — ARCHITECTURE.md §1 / money.jsx's own isBalanceSettled precedent. A bucket amount is never negative (it's "how much is owing"), so an exact-zero string check is sufficient here.
            render: (row) => (
              <span className={String(row.bucket_90_plus).trim() !== '0.00' ? formStyles.balanceOwing : undefined}>
                <Money amount={row.bucket_90_plus} currencyCode={currencyFor(row)} />
              </span>
            ),
          },
        ]}
        rows={rows ?? []}
        rowKey={(row) => row.arAccountId}
      />
    </div>
  );
}
