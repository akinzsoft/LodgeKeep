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
 */
const TABS = [
  { key: 'board', label: 'Board' },
  { key: 'discrepancies', label: 'Discrepancies' },
  { key: 'out-of-order', label: 'Out of Order' },
];

export function HousekeepingScreen({ isOffline = false }) {
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
        {tab === 'board' && <BoardTab isOffline={isOffline} />}
        {tab === 'discrepancies' && <DiscrepanciesTab isOffline={isOffline} />}
        {tab === 'out-of-order' && <OutOfOrderTab isOffline={isOffline} />}
      </div>
    </div>
  );
}
