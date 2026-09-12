import { useState } from 'react';
import { StockItemsTab } from './StockItemsTab.jsx';
import { StockRecipesTab } from './StockRecipesTab.jsx';
import { StockGoodsReceivedTab } from './StockGoodsReceivedTab.jsx';
import { StockTakesTab } from './StockTakesTab.jsx';
import { StockWastageTab } from './StockWastageTab.jsx';
import { StockReportsTab } from './StockReportsTab.jsx';
import styles from './POSScreen.module.css';

/**
 * StockTab — PLAN.md Phase 6's "POS inventory & stock control"
 * (PRODUCT_REQUIREMENTS.md §3.4). A thin container over six inner tabs,
 * the same second-level `role="tablist"` composition `POSScreen.jsx`'s own
 * outer tablist already establishes one level up — a natural nesting, not
 * a new pattern.
 *
 * No client-side permission check hides any of the six inner tabs, even
 * though the real backend (`stock/routes.js`) splits them across
 * `pos.stock_view` (Stock items' own read, Wastage — a floor action
 * reachable by `pos_operator`) and `pos.stock_manage` (everything else:
 * item CRUD, recipes, goods received, stock takes, reporting) — the same
 * "always reachable, the real 403 is what a lower-tier account sees"
 * convention every other tab on this screen already follows
 * (`SetupTab.jsx`'s own header). This app has no endpoint yet that would
 * tell a screen which of the two keys the signed-in user actually holds,
 * so faking that split client-side would be inventing information this
 * screen doesn't have, not a real RBAC check.
 */
const STOCK_TABS = [
  { key: 'items', label: 'Stock items' },
  { key: 'recipes', label: 'Recipes' },
  { key: 'goods_received', label: 'Goods received' },
  { key: 'takes', label: 'Stock takes' },
  { key: 'wastage', label: 'Wastage' },
  { key: 'reports', label: 'Reports' },
];

export function StockTab({ isOffline = false }) {
  const [tab, setTab] = useState('items');

  return (
    <div>
      <div className={styles.tabs} role="tablist" aria-label="Stock sections">
        {STOCK_TABS.map((t) => (
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
        {tab === 'items' && <StockItemsTab isOffline={isOffline} />}
        {tab === 'recipes' && <StockRecipesTab isOffline={isOffline} />}
        {tab === 'goods_received' && <StockGoodsReceivedTab isOffline={isOffline} />}
        {tab === 'takes' && <StockTakesTab isOffline={isOffline} />}
        {tab === 'wastage' && <StockWastageTab isOffline={isOffline} />}
        {tab === 'reports' && <StockReportsTab />}
      </div>
    </div>
  );
}
