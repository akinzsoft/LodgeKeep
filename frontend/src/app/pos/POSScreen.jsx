import { useState } from 'react';
import { SetupTab } from './SetupTab.jsx';
import { RegisterTab } from './RegisterTab.jsx';
import { TicketsTab } from './TicketsTab.jsx';
import { ShiftsTab } from './ShiftsTab.jsx';
import styles from './POSScreen.module.css';

/**
 * POSScreen — PLAN.md Phase 4's POS core (PRODUCT_REQUIREMENTS.md §3.4).
 * Four tabs, exactly this pass's own scope: Setup (outlets/terminals/menu,
 * `pos.manage`), Register (the touch-first order screen, `pos.operate`),
 * Tickets (the live kitchen/bar queue — this session's confirmed
 * "displayed, not printed" scope), and Shifts (blind cash-up). Same
 * self-contained multi-tab pattern `HousekeepingScreen`/`BookingScreen`
 * already established — no router in this app yet.
 *
 * Deliberately NOT built here, per this module's own backend header: QR
 * self-ordering, inventory/stock control (both Phase 6), happy-hour/
 * time-based menu pricing, and POS reporting.
 */
const TABS = [
  { key: 'register', label: 'Register' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'shifts', label: 'Shifts' },
  { key: 'setup', label: 'Setup' },
];

export function POSScreen({ isOffline = false }) {
  const [tab, setTab] = useState('register');

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>POS</h1>

      <div className={styles.tabs} role="tablist" aria-label="POS sections">
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
        {tab === 'register' && <RegisterTab isOffline={isOffline} />}
        {tab === 'tickets' && <TicketsTab />}
        {tab === 'shifts' && <ShiftsTab isOffline={isOffline} />}
        {tab === 'setup' && <SetupTab />}
      </div>
    </div>
  );
}
