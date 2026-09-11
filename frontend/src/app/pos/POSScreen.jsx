import { useState } from 'react';
import { SetupTab } from './SetupTab.jsx';
import { RegisterTab } from './RegisterTab.jsx';
import { TicketsTab } from './TicketsTab.jsx';
import { ShiftsTab } from './ShiftsTab.jsx';
import { GuestOrdersTab } from './GuestOrdersTab.jsx';
import { QrTokensTab } from './QrTokensTab.jsx';
import styles from './POSScreen.module.css';

/**
 * POSScreen — PLAN.md Phase 4's POS core (PRODUCT_REQUIREMENTS.md §3.4),
 * plus Phase 6's QR self-ordering gap closure. Six tabs: Setup
 * (outlets/terminals/menu, `pos.manage`), Register (the touch-first order
 * screen, `pos.operate`), Tickets (the live kitchen/bar queue for
 * STAFF-opened tabs), Shifts (blind cash-up), Guest Orders (the incoming
 * QR-ordering queue, `pos.operate` — a genuinely separate lifecycle from
 * Tickets, see `GuestOrdersTab.jsx`'s own header), and QR Codes
 * (outlet-level guest-ordering policy plus per-table/per-room code
 * management, `pos.manage`). Same self-contained multi-tab pattern
 * `HousekeepingScreen`/`BookingScreen` already established — no router in
 * this app yet. No client-side permission check hides either new tab, the
 * same "the real 403 is what a lower-tier account sees" convention every
 * tab on this screen already follows (`SetupTab.jsx`'s own header).
 *
 * Deliberately NOT built here, per this module's own backend header:
 * inventory/stock control (Phase 6's other item), happy-hour/time-based
 * menu pricing, and POS reporting.
 */
const TABS = [
  { key: 'register', label: 'Register' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'guest_orders', label: 'Guest orders' },
  { key: 'shifts', label: 'Shifts' },
  { key: 'qr_codes', label: 'QR codes' },
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
        {tab === 'guest_orders' && <GuestOrdersTab />}
        {tab === 'shifts' && <ShiftsTab isOffline={isOffline} />}
        {tab === 'qr_codes' && <QrTokensTab />}
        {tab === 'setup' && <SetupTab />}
      </div>
    </div>
  );
}
