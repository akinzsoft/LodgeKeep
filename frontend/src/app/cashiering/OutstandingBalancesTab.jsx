import { useEffect, useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { cashieringApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import formStyles from './CashieringForm.module.css';

/**
 * OutstandingBalancesTab — gap closure (user-reported): "Cashiering menu
 * shld be able to see all outstanding balance of guest and there room no.
 * recommended a standard feature." PRODUCT_REQUIREMENTS.md's own
 * "Role-based views" table names an "Open folios list" as the Cashier
 * role's landing screen — this is that report, real-time (every
 * checked-in guest with a nonzero folio balance, room number, sorted
 * highest balance first — the backend's own fixed sort, since `DataTable`
 * itself has no sort capability, per its own "presentation only" header).
 *
 * Fetch-on-mount, no filter form — this is a live snapshot, not a
 * date-ranged report like `OccupancyTab`/`RevenueTab`. A "Refresh" action
 * covers the case a balance changed (a payment captured elsewhere) while
 * this tab was already open, since nothing here subscribes to live
 * updates.
 */
export function OutstandingBalancesTab({ isOffline = false, onViewFolio }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  async function reload() {
    setError(null);
    try {
      setRows(await cashieringApi.listOutstandingBalances());
    } catch (caught) {
      setRows([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load outstanding balances.');
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
      const blob = await cashieringApi.getOutstandingBalancesCsv();
      triggerDownload(blob, 'outstanding-balances.csv');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export outstanding balances.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      {/* Outside DataTable's own toolbar slot, deliberately — Card (which
          DataTable wraps) only renders `children` (toolbar included)
          while `state === 'success'`, so a control that must stay
          reachable even with zero rows (e.g. Refresh, after everyone's
          settled up) cannot live inside a state-gated DataTable. */}
      <div className={formStyles.actionsRow}>
        <Button type="button" variant="secondary" onClick={reload} disabled={isOffline}>
          Refresh
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={exporting}
          disabled={isOffline || rows === null || rows.length === 0}
          onClick={handleExport}
        >
          Export CSV
        </Button>
      </div>

      <DataTable
        title="Outstanding balances"
        state={rows === null ? 'loading' : rows.length === 0 ? 'empty' : 'success'}
        emptyMessage="No outstanding balances — every in-house folio is settled."
        columns={[
          { key: 'confirmation_number', label: 'Confirmation' },
          {
            key: 'guest_name',
            label: 'Guest',
            render: (row) => `${row.guest_first_name ?? ''} ${row.guest_last_name ?? ''}`.trim() || '—',
          },
          { key: 'room_number', label: 'Room', render: (row) => row.room_number ?? '—' },
          { key: 'arrival_date', label: 'Arrival' },
          { key: 'departure_date', label: 'Departure' },
          {
            key: 'folio_balance',
            label: 'Balance',
            align: 'right',
            render: (row) => (
              <span className={Number(row.folio_balance) !== 0 ? formStyles.balanceOwing : undefined}>
                <Money amount={row.folio_balance} currencyCode={row.folio_currency} />
              </span>
            ),
          },
        ]}
        rows={rows ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <Button size="compact" variant="secondary" onClick={() => onViewFolio(row.id)}>
            View folio
          </Button>
        )}
      />
    </div>
  );
}
