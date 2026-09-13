import { useState } from 'react';
import { SetupTab } from './SetupTab.jsx';
import { RegisterTab } from './RegisterTab.jsx';
import { TicketsTab } from './TicketsTab.jsx';
import { ShiftsTab } from './ShiftsTab.jsx';
import { GuestOrdersTab } from './GuestOrdersTab.jsx';
import { QrTokensTab } from './QrTokensTab.jsx';
import { StockTab } from './StockTab.jsx';
import styles from './POSScreen.module.css';

/**
 * POSScreen — PLAN.md Phase 4's POS core (PRODUCT_REQUIREMENTS.md §3.4),
 * plus Phase 6's QR self-ordering and inventory/stock-control gap
 * closures. Seven tabs: Setup (outlets/terminals/menu, `pos.manage`),
 * Register (the touch-first order screen, `pos.operate`), Tickets (the
 * live kitchen/bar queue for STAFF-opened tabs), Shifts (blind cash-up),
 * Guest Orders (the incoming QR-ordering queue, `pos.operate` — a
 * genuinely separate lifecycle from Tickets, see `GuestOrdersTab.jsx`'s
 * own header), QR Codes (outlet-level guest-ordering policy plus
 * per-table/per-room code management, `pos.manage`), and Stock (raw
 * ingredient/consumable tracking, recipes, goods received, blind stock
 * takes, wastage, and cost/variance reporting — split across
 * `pos.stock_view`/`pos.stock_manage`, see `StockTab.jsx`'s own header).
 * Same self-contained multi-tab pattern `HousekeepingScreen`/`BookingScreen`
 * already established — no router in this app yet. No client-side
 * permission check hides any tab, the same "the real 403 is what a
 * lower-tier account sees" convention every tab on this screen already
 * follows (`SetupTab.jsx`'s own header).
 *
 * Deliberately NOT built here, per this module's own backend header:
 * happy-hour/time-based menu pricing.
 *
 * Bug fix (user-reported "test the POS menu," found by live-testing then
 * reading every tab): every `Money` display across this whole module —
 * `RegisterTab`, `SetupTab`, `GuestOrdersTab`, and three of `StockTab`'s own
 * six inner tabs — hardcoded `currencyCode="NGN"`, unlike every other money-
 * displaying screen in this app (`CashieringScreen`, `FrontDeskTab`, ...),
 * which always reads the real currency off the actual data row. Invisible
 * in this dev environment specifically because both seeded tenants happen
 * to use NGN — the exact "silently correct by coincidence" shape this
 * session has already found twice elsewhere (Tape Chart's business date,
 * Housekeeping's business date). None of `pos_menu_items`/`pos_orders`/
 * `stock_items` carry their own currency column (confirmed by reading the
 * migrations directly) — money on those tables is always the property's
 * own `base_currency`, the same single-source-of-truth `folios.currency`
 * already represents for Cashiering. `main.jsx` already resolves
 * `activePropertyRecord` for `RoomsScreen`'s/`HousekeepingScreen`'s own
 * identical need; this screen was mounted with none of it at all. Guarded
 * the same way `BookingScreen`/`RoomsScreen` guard an unresolved property,
 * since `shared/format/money.jsx`'s own `Money` component throws rather
 * than silently defaulting a currency it wasn't given.
 */
const TABS = [
  { key: 'register', label: 'Register' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'guest_orders', label: 'Guest orders' },
  { key: 'shifts', label: 'Shifts' },
  { key: 'qr_codes', label: 'QR codes' },
  { key: 'stock', label: 'Stock' },
  { key: 'setup', label: 'Setup' },
];

export function POSScreen({ activeProperty, isOffline = false, currentUserLabel }) {
  const [tab, setTab] = useState('register');

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>POS</h1>

      {!activeProperty ? (
        <p className={styles.loading}>Select an active property to use the POS.</p>
      ) : (
        <>
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
            {tab === 'register' && <RegisterTab activeProperty={activeProperty} isOffline={isOffline} currentUserLabel={currentUserLabel} />}
            {tab === 'tickets' && <TicketsTab />}
            {tab === 'guest_orders' && <GuestOrdersTab activeProperty={activeProperty} />}
            {tab === 'shifts' && <ShiftsTab isOffline={isOffline} />}
            {tab === 'qr_codes' && <QrTokensTab />}
            {tab === 'stock' && <StockTab activeProperty={activeProperty} isOffline={isOffline} />}
            {tab === 'setup' && <SetupTab activeProperty={activeProperty} />}
          </div>
        </>
      )}
    </div>
  );
}
