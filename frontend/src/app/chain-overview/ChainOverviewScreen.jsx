import { useEffect, useState } from 'react';
import { KPICard, Card, DataTable, StatusPill, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { reportingApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import styles from './ChainOverviewScreen.module.css';

/**
 * ChainOverviewScreen — PLAN.md Phase 6's smallest defensible first slice
 * of Multi-Property Management (PRODUCT_REQUIREMENTS.md §3.13). §3.13's
 * own role-landing table names "Multi-property roll-up" as `super_admin`'s
 * distinguishing landing experience — but per this session's own confirmed
 * decision, this is an ORDINARY nav item gated on `reports.view_chain`
 * (`nav-config.js`), not a new role-based default-landing mechanism;
 * `super_admin` still lands on the normal HomeDashboard by default and
 * clicks through to this screen like any other module.
 *
 * TODAY's occupancy/revenue per active property in the tenant, aggregated
 * (never blended across currencies — see the "Revenue today" card), plus
 * the real per-property breakdown a single blended number can't show. No
 * date-range picker (a KPI-style roll-up, matching HomeDashboard's own
 * "Total Revenue (today)" framing) — a chain-wide date-range report is a
 * real, named, deferred follow-on, not built here. Deliberately shows a
 * "chain of one" for a single-property tenant rather than hiding the nav
 * item — nothing else in this codebase conditionally hides a nav item by
 * entity count, and a tenant will grow into this screen.
 *
 * Fetch-on-mount, no filter form — same live-snapshot shape
 * `OutstandingBalancesTab` already established, "Refresh" covers the case
 * something changed while this screen was already open.
 */
export function ChainOverviewScreen({ isOffline = false }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  async function reload() {
    setError(null);
    try {
      setOverview(await reportingApi.getChainOverview());
    } catch (caught) {
      setOverview({ properties: [], totals: null });
      setError(caught instanceof ApiError ? caught.message : 'Could not load the chain overview.');
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
      const blob = await reportingApi.getChainOverviewCsv();
      triggerDownload(blob, 'chain-overview.csv');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export the chain overview.');
    } finally {
      setExporting(false);
    }
  }

  const properties = overview?.properties ?? [];
  const totals = overview?.totals ?? null;
  const loading = overview === null;
  // A load failure degrades to the same 'empty' state every KPI/Card here
  // already has, with the real error text surfacing through emptyMessage —
  // matching HomeDashboard's own established pattern (never a redundant
  // 'error' state duplicating the top banner's own role="alert" text).
  const kpiState = loading ? 'loading' : !totals || totals.configuredPropertyCount === 0 ? 'empty' : 'success';

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Multi-Property Roll-up</h1>
      <p className={styles.hint}>Today&rsquo;s occupancy and revenue across every active property in the tenant.</p>

      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}

      {/* Outside DataTable's/Card's own state-gated children, deliberately —
          Card only renders its children while state === 'success', so a
          control that must stay reachable even with zero rows (Refresh,
          right after this screen's very first load) cannot live inside a
          state-gated child. */}
      <div className={styles.actionsRow}>
        <Button type="button" variant="secondary" onClick={reload} disabled={isOffline}>
          Refresh
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={exporting}
          disabled={isOffline || properties.length === 0}
          onClick={handleExport}
        >
          Export CSV
        </Button>
      </div>

      <div className={styles.kpiGrid}>
        <KPICard
          domain="rooms"
          icon="🏨"
          label="Properties configured"
          state={kpiState}
          value={totals ? `${totals.configuredPropertyCount} / ${totals.propertyCount}` : null}
          emptyMessage={error ?? 'No properties have a business date configured yet.'}
        />
        <KPICard
          domain="booking"
          icon="📊"
          label="Avg. occupancy today"
          state={kpiState}
          value={totals?.averageOccupancyPctToday != null ? `${totals.averageOccupancyPctToday}%` : null}
          emptyMessage={error ?? 'No configured properties to average yet.'}
        />
        <KPICard
          domain="rooms"
          icon="🛏️"
          label="Rooms sold today (chain-wide)"
          state={kpiState}
          value={totals?.totalRoomsSoldToday}
          emptyMessage={error ?? 'No configured properties yet.'}
        />
      </div>

      <Card
        className={styles.revenueCard}
        title="Revenue today"
        state={kpiState}
        emptyMessage={error ?? 'No revenue posted for today yet.'}
      >
        <ul className={styles.revenueList}>
          {(totals?.revenueByCurrency ?? []).map((row) => (
            <li key={row.currencyCode} className={styles.revenueRow}>
              <Money amount={row.totalRoomRevenue} currencyCode={row.currencyCode} />
            </li>
          ))}
        </ul>
      </Card>

      <DataTable
        title="Property breakdown"
        state={loading ? 'loading' : properties.length === 0 ? 'empty' : 'success'}
        emptyMessage="No active properties in this tenant yet."
        columns={[
          { key: 'propertyName', label: 'Property' },
          { key: 'businessDate', label: 'Business date', render: (row) => row.businessDate ?? 'Not yet configured' },
          {
            key: 'occupancyPct',
            label: 'Occupancy',
            align: 'right',
            render: (row) => (row.occupancyPct != null ? `${row.occupancyPct}%` : '—'),
          },
          { key: 'roomsSold', label: 'Rooms sold', align: 'right', render: (row) => row.roomsSold ?? '—' },
          {
            key: 'roomRevenue',
            label: 'Revenue',
            align: 'right',
            render: (row) => (row.roomRevenue != null ? <Money amount={row.roomRevenue} currencyCode={row.currencyCode} /> : '—'),
          },
          {
            key: 'audited',
            label: 'Status',
            render: (row) =>
              row.businessDate == null ? (
                <StatusPill tone="neutral" label="Not configured" />
              ) : row.audited ? (
                <StatusPill tone="success" label="Audited" />
              ) : (
                <StatusPill tone="info" label="Live" />
              ),
          },
        ]}
        rows={properties}
        rowKey={(row) => row.propertyId}
      />
    </div>
  );
}
