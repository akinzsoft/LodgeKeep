import { useEffect, useState } from 'react';
import { setupApi, ApiError } from '../../shared/api/index.js';
import { AvailabilityTab } from './AvailabilityTab.jsx';
import { TapeChartTab } from './TapeChartTab.jsx';
import { ReservationsListTab } from './ReservationsListTab.jsx';
import { WaitlistTab } from './WaitlistTab.jsx';
import { FrontDeskTab } from './FrontDeskTab.jsx';
import styles from './BookingScreen.module.css';

/**
 * BookingScreen — PLAN.md Phase 2, PRODUCT_REQUIREMENTS.md §3.2
 * (Reservations) and §3.3 (Front Desk). One nav item, "Booking"
 * (`nav-config.js`'s literal PRODUCT_REQUIREMENTS.md App-shell label —
 * confirmed as the Reservations module by the Manager dashboard's own "Total
 * Booking → Reservations" KPI line), tabbed the same way `SetupScreen`
 * already established, since Front Desk has no separate top-level nav slot
 * in the literal spec either.
 *
 * Fetches properties itself for the same reason `SetupScreen` does — the
 * login response carries no property currency, only an id.
 */
const TABS = [
  { key: 'availability', label: 'Availability' },
  { key: 'tape-chart', label: 'Tape Chart' },
  { key: 'reservations', label: 'Reservations' },
  { key: 'waitlist', label: 'Waitlist' },
  { key: 'front-desk', label: 'Front Desk' },
];

export function BookingScreen({ activePropertyId, isOffline = false }) {
  const [tab, setTab] = useState('availability');
  const [properties, setProperties] = useState(null);
  const [error, setError] = useState(null);

  async function reloadProperties() {
    try {
      setProperties(await setupApi.listProperties());
    } catch (caught) {
      setProperties([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load properties.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadProperties();
  }, []);

  if (properties === null) {
    return (
      <div className={styles.page}>
        <p className={styles.loading}>Loading booking…</p>
      </div>
    );
  }

  const activeProperty = properties.find((property) => String(property.id) === String(activePropertyId)) ?? null;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Booking</h1>

      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}

      {!activeProperty ? (
        <p className={styles.loading}>Select an active property to manage bookings.</p>
      ) : (
        <>
          <div className={styles.tabs} role="tablist" aria-label="Booking sections">
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
            {tab === 'availability' && <AvailabilityTab activeProperty={activeProperty} isOffline={isOffline} />}
            {tab === 'tape-chart' && <TapeChartTab activeProperty={activeProperty} />}
            {tab === 'reservations' && <ReservationsListTab activeProperty={activeProperty} isOffline={isOffline} />}
            {tab === 'waitlist' && <WaitlistTab activeProperty={activeProperty} />}
            {tab === 'front-desk' && <FrontDeskTab activeProperty={activeProperty} isOffline={isOffline} />}
          </div>
        </>
      )}
    </div>
  );
}
