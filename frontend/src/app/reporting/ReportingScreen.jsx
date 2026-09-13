import { useEffect, useState } from 'react';
import { setupApi, ApiError } from '../../shared/api/index.js';
import { OccupancyTab } from './OccupancyTab.jsx';
import { RevenueTab } from './RevenueTab.jsx';
import { HousekeepingSummaryTab } from './HousekeepingSummaryTab.jsx';
import styles from './ReportingScreen.module.css';

/**
 * ReportingScreen — PLAN.md Phase 3, PRODUCT_REQUIREMENTS.md §3.11: "report
 * catalogue ..., date-range picker, on-screen table + export." This
 * session's confirmed scope: occupancy, revenue (ADR/RevPAR), and a
 * housekeeping summary (discrepancies, assignments, tonight's oversold room
 * types) — all computed live, no `daily_reports` snapshot (Night Audit was
 * not built this pass; see `src/modules/reporting/index.js`'s own backend
 * header). No custom-dashboard builder or scheduled delivery UI this pass.
 *
 * Bug fix (found while testing the Reporting menu): this screen rendered
 * its tabs immediately on mount, before `listProperties()` had resolved —
 * `activeProperty` was `null` for that whole window, and `RevenueTab` used
 * to paper over it with `activeProperty?.base_currency ?? 'USD'`, a silent
 * currency misstatement (a real, reachable version of the exact bug this
 * session already found and fixed across the whole POS module — see
 * `POSScreen`'s own header). Fixed the same way `BookingScreen`/
 * `POSScreen`/`HousekeepingScreen` already guard an unresolved property:
 * nothing renders until it's real, so `RevenueTab` never needs — or gets —
 * a fallback currency again.
 */
const TABS = [
  { key: 'occupancy', label: 'Occupancy' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'housekeeping', label: 'Housekeeping' },
];

export function ReportingScreen({ activePropertyId }) {
  const [tab, setTab] = useState('occupancy');
  const [properties, setProperties] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        setProperties(await setupApi.listProperties());
      } catch (caught) {
        setProperties([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load properties.');
      }
    }
    load();
  }, []);

  const activeProperty = (properties ?? []).find((property) => String(property.id) === String(activePropertyId)) ?? null;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Reporting</h1>

      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}

      {properties === null ? (
        <p className={styles.loading}>Loading reporting…</p>
      ) : !activeProperty ? (
        <p className={styles.loading}>Select an active property to view reports.</p>
      ) : (
        <>
          <div className={styles.tabs} role="tablist" aria-label="Reporting sections">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`.trim()}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className={styles.panel}>
            {tab === 'occupancy' && <OccupancyTab />}
            {tab === 'revenue' && <RevenueTab activeProperty={activeProperty} />}
            {tab === 'housekeeping' && <HousekeepingSummaryTab />}
          </div>
        </>
      )}
    </div>
  );
}
