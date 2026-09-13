import { useState } from 'react';
import { BoardTab } from './BoardTab.jsx';
import { DiscrepanciesTab } from './DiscrepanciesTab.jsx';
import { OutOfOrderTab } from './OutOfOrderTab.jsx';
import styles from './HousekeepingScreen.module.css';

/**
 * HousekeepingScreen — PLAN.md Phase 3, PRODUCT_REQUIREMENTS.md §3.6. Three
 * tabs, exactly PLAN.md's own Phase 3 bullet: attendant assignments/status
 * board, discrepancy detection/report, and the out-of-order mechanism its
 * test gate requires. Same self-contained multi-tab pattern `BookingScreen`/
 * `SetupScreen` already established — no router in this app yet.
 *
 * Deliberately NOT built here, per this module's own backend header: room
 * inspections, maintenance requests, lost & found, linen/minibar — real
 * §3.6 scope, not in PLAN.md Phase 3's bullet list.
 *
 * Bug fix (user-reported "test Housekeeper," live-tested): `main.jsx`
 * already resolves `activePropertyRecord` (with its real
 * `current_business_date`) for `RoomsScreen`'s own identical need — this
 * screen was mounted right alongside it with no property passed in at all.
 * `BoardTab`'s default board date and `OutOfOrderTab`'s "Close now" action
 * both defaulted to the browser's own wall-clock today instead, the same
 * ARCHITECTURE.md §6 violation already found and fixed on the Booking
 * screen's own Tape Chart tab — but here with real consequences, not just a
 * cosmetic default: a new assignment is tagged to whichever date is
 * showing, and closing an OOO period early writes that date directly as
 * its new `end_date`, which `out_of_order_periods`' own range check
 * (`listOutOfOrderPeriods`, `src/shared/room-availability.js`'s live
 * exclusion) uses to decide when a room re-enters sellable inventory.
 * `DiscrepanciesTab` needed no change — it only ever displays a business
 * date column, never computes or submits one.
 */
const TABS = [
  { key: 'board', label: 'Board' },
  { key: 'discrepancies', label: 'Discrepancies' },
  { key: 'out-of-order', label: 'Out of Order' },
];

export function HousekeepingScreen({ activeProperty, isOffline = false }) {
  const [tab, setTab] = useState('board');

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Housekeeping</h1>

      <div className={styles.tabs} role="tablist" aria-label="Housekeeping sections">
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
        {tab === 'board' && <BoardTab activeProperty={activeProperty} isOffline={isOffline} />}
        {tab === 'discrepancies' && <DiscrepanciesTab isOffline={isOffline} />}
        {tab === 'out-of-order' && <OutOfOrderTab activeProperty={activeProperty} isOffline={isOffline} />}
      </div>
    </div>
  );
}
