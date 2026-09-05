import { useEffect, useState } from 'react';
import { setupApi, ApiError } from '../../shared/api/index.js';
import { PropertyTab } from './PropertyTab.jsx';
import { RoomTypesTab } from './RoomTypesTab.jsx';
import { RoomsTab } from './RoomsTab.jsx';
import { RateCodesTab } from './RateCodesTab.jsx';
import { TaxesTab } from './TaxesTab.jsx';
import { ReferenceDataTab } from './ReferenceDataTab.jsx';
import styles from './SetupScreen.module.css';

/**
 * SetupScreen — PLAN.md Phase 1, PRODUCT_REQUIREMENTS.md's "Setup &
 * Configuration screens (3.19)": "property details, room types, rooms, rate
 * plans, taxes." Structured as one self-contained multi-view component
 * (the same pattern `StaffLoginScreen` already uses) rather than a router
 * page each, since this app still has no router — `main.jsx` mounts this
 * one component under a single "Setup" nav item.
 *
 * Market segments, booking sources, and cancellation policies (the
 * "Reference Data" tab) closed a gap flagged here since the original Phase
 * 1 pass — PLAN.md's Phase 1 bullet list named them from the start, but
 * they were deliberately deferred until this later pass. Still not built,
 * deliberately: user management and the guided first-run wizard with
 * resumable progress — both real, separate pieces of work, tracked as
 * their own gaps rather than folded into this tab strip.
 *
 * Fetches the tenant's properties itself, rather than trusting
 * `activeProperty` passed down from `main.jsx` (which — per
 * `AuthContext.jsx`'s own header — only carries an id, no name or
 * currency): `GET /properties` is the first real Phase 1 endpoint that
 * actually returns those fields, so this screen is what finally has real
 * values to show instead of a placeholder.
 */
const TABS = [
  { key: 'property', label: 'Property' },
  { key: 'room-types', label: 'Room Types' },
  { key: 'rooms', label: 'Rooms' },
  { key: 'rate-codes', label: 'Rate Codes & Calendar' },
  { key: 'taxes', label: 'Taxes' },
  { key: 'reference-data', label: 'Reference Data' },
];

export function SetupScreen({ activePropertyId, isOffline = false }) {
  const [tab, setTab] = useState('property');
  const [properties, setProperties] = useState(null);
  const [error, setError] = useState(null);

  async function reloadProperties() {
    try {
      setProperties(await setupApi.listProperties());
    } catch (caught) {
      // A real bug caught by this exact test while it was being written: on
      // failure, `properties` stayed `null` forever — the render below only
      // leaves its "Loading setup…" branch once `properties` is non-null,
      // so an error here left the screen stuck loading with the error
      // banner unreachable. `[]` is honest (DESIGN_SYSTEM.md §2's error
      // state, not empty) — the `error` banner below is what actually tells
      // the user what happened.
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
        <p className={styles.loading}>Loading setup…</p>
      </div>
    );
  }

  const activeProperty = properties.find((property) => String(property.id) === String(activePropertyId)) ?? null;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Setup</h1>

      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}

      <div className={styles.tabs} role="tablist" aria-label="Setup sections">
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
        {tab === 'property' && (
          <PropertyTab properties={properties} onPropertiesChanged={reloadProperties} />
        )}
        {tab === 'room-types' && <RoomTypesTab activeProperty={activeProperty} disabled={!activeProperty} />}
        {tab === 'rooms' && <RoomsTab activeProperty={activeProperty} disabled={!activeProperty} />}
        {tab === 'rate-codes' && <RateCodesTab activeProperty={activeProperty} disabled={!activeProperty} />}
        {tab === 'taxes' && <TaxesTab activeProperty={activeProperty} disabled={!activeProperty} isOffline={isOffline} />}
        {tab === 'reference-data' && <ReferenceDataTab disabled={!activeProperty} />}
      </div>
    </div>
  );
}
