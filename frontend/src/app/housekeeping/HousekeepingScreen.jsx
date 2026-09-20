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
 *
 * Gap closure (user-reported): a housekeeping-role account could assign
 * rooms to OTHER attendants, resolve discrepancies, and manage
 * out-of-order periods — all supervisor decisions, backed now by a real
 * `housekeeping.manage` narrowing (see the backend's own migration/
 * controller headers). `canManage` (from `main.jsx`'s already-resolved
 * `grantedPermissions`) and `currentUserId` thread down to all three tabs
 * so each can show the right thing for the right role — reads stay
 * unchanged for everyone; only the supervisor-only ACTIONS (assign,
 * resolve, out-of-order create/close) hide for a plain housekeeper. This
 * is a deliberate exception to this app's usual "don't hide it, let the
 * backend 403" convention: the backend 403 is still the real enforcement,
 * but a housekeeper's own job here — clean the rooms assigned to them,
 * report status — is different enough from a supervisor's that showing
 * the same undifferentiated screen to both was the actual bug reported.
 */
const TABS = [
  { key: 'board', label: 'Board' },
  { key: 'discrepancies', label: 'Discrepancies' },
  { key: 'out-of-order', label: 'Out of Order' },
];

export function HousekeepingScreen({ activeProperty, isOffline = false, currentUserId = null, canManage = false }) {
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
        {tab === 'board' && (
          <BoardTab activeProperty={activeProperty} isOffline={isOffline} currentUserId={currentUserId} canManage={canManage} />
        )}
        {tab === 'discrepancies' && <DiscrepanciesTab isOffline={isOffline} canManage={canManage} />}
        {tab === 'out-of-order' && (
          <OutOfOrderTab activeProperty={activeProperty} isOffline={isOffline} canManage={canManage} />
        )}
      </div>
    </div>
  );
}
