import { useState } from 'react';
import { BlocksTab } from './BlocksTab.jsx';
import { RoomAllocationsTab } from './RoomAllocationsTab.jsx';
import { RoomingListTab } from './RoomingListTab.jsx';
import { PickupBillingTab } from './PickupBillingTab.jsx';
import styles from './GroupBlocksScreen.module.css';

/**
 * GroupBlocksScreen — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md §3.8 ("Group
 * room blocks and rooming lists," "Group billing," "Meeting/event
 * integration" — the last is real, non-hotel-specific meeting/event
 * software with no analog anywhere in this codebase and no spec beyond
 * that one phrase; correctly out of scope, not built here). Four tabs
 * against the same underlying block, the same self-contained multi-tab
 * pattern `ARScreen`/`POSScreen`/`CashieringScreen` already established —
 * no router in this app yet. Filed under SETUP in `nav-config.js` (back-
 * office, gated on `group_blocks.view`), not MAIN — PRODUCT_REQUIREMENTS.md
 * itself files Group Blocks under "Back-office screens," alongside AR and
 * Night Audit.
 *
 * `selectedBlock` is screen-level state, not per-tab: three of the four
 * tabs (Room Allocations, Rooming List, Pickup/Billing) operate on ONE
 * block at a time, the same "select once, act across tabs" idiom
 * `CashieringScreen` already established for a folio and `RoomsScreen`'s
 * "View rooms" cross-tab handoff already established for a room type.
 */
const TABS = [
  { key: 'blocks', label: 'Blocks' },
  { key: 'allocations', label: 'Room Allocations' },
  { key: 'rooming_list', label: 'Rooming List' },
  { key: 'pickup_billing', label: 'Pickup & Billing' },
];

export function GroupBlocksScreen({ isOffline = false }) {
  const [tab, setTab] = useState('blocks');
  const [selectedBlock, setSelectedBlock] = useState(null);

  function handleManage(block) {
    setSelectedBlock(block);
    setTab('allocations');
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Group Blocks</h1>

      <div className={styles.tabs} role="tablist" aria-label="Group Blocks sections">
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
        {tab === 'blocks' && <BlocksTab isOffline={isOffline} onManage={handleManage} />}
        {tab === 'allocations' && <RoomAllocationsTab isOffline={isOffline} block={selectedBlock} />}
        {tab === 'rooming_list' && <RoomingListTab block={selectedBlock} />}
        {tab === 'pickup_billing' && <PickupBillingTab isOffline={isOffline} block={selectedBlock} />}
      </div>
    </div>
  );
}
