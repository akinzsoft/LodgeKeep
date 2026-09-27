import { useState } from 'react';
import { StockItemsTab } from './StockItemsTab.jsx';
import { StockRecipesTab } from './StockRecipesTab.jsx';
import { StockGoodsReceivedTab } from './StockGoodsReceivedTab.jsx';
import { StockTakesTab } from './StockTakesTab.jsx';
import { StockWastageTab } from './StockWastageTab.jsx';
import { StockReportsTab } from './StockReportsTab.jsx';
import { StockReorderReportTab } from './StockReorderReportTab.jsx';
import { StockTransferTab } from './StockTransferTab.jsx';
import { StockRequestsTab } from './StockRequestsTab.jsx';
import styles from './POSScreen.module.css';

/**
 * StockTab — PLAN.md Phase 6's "POS inventory & stock control"
 * (PRODUCT_REQUIREMENTS.md §3.4). A thin container over its inner tabs,
 * the same second-level `role="tablist"` composition `POSScreen.jsx`'s own
 * outer tablist already establishes one level up.
 *
 * Each inner tab names the key its endpoints need (`stock/routes.js`):
 * `pos.stock_view` (stock items read, wastage, reorder), `pos.stock_transfer`
 * (transfers) and `pos.stock_manage` (everything else). When `permissions`
 * is given — the signed-in role's real grants, from the same endpoint the
 * sidebar filters by — only the tabs that role can use are shown, so a
 * Storekeeper sees Stock items, Requests, Transfer, Wastage and Reorder
 * rather than a row of screens that answer 403. Without it every tab shows,
 * as before; the server's own check is the real enforcement either way.
 *
 * Requests is open to either side of a stock request — `pos.stock_request`
 * (the outlets that ask) or `pos.stock_transfer` (the storekeeper who
 * issues) — so a tab's `permission` may be a list, any one of which is
 * enough.
 */
const STOCK_TABS = [
  { key: 'items', label: 'Stock items', permission: 'pos.stock_view' },
  { key: 'recipes', label: 'Recipes', permission: 'pos.stock_manage' },
  { key: 'goods_received', label: 'Goods received', permission: 'pos.stock_manage' },
  { key: 'requests', label: 'Requests', permission: ['pos.stock_request', 'pos.stock_transfer'] },
  { key: 'transfer', label: 'Transfer', permission: 'pos.stock_transfer' },
  { key: 'takes', label: 'Stock takes', permission: 'pos.stock_manage' },
  { key: 'wastage', label: 'Wastage', permission: 'pos.stock_view' },
  { key: 'reorder', label: 'Reorder report', permission: 'pos.stock_view' },
  { key: 'reports', label: 'Reports', permission: 'pos.stock_manage' },
];

export function StockTab({ activeProperty, isOffline = false, permissions }) {
  const allowed = (t) => [t.permission].flat().some((key) => permissions.has(key));
  const tabs = permissions ? STOCK_TABS.filter(allowed) : STOCK_TABS;
  const [chosen, setTab] = useState(null);
  const tab = tabs.some((t) => t.key === chosen) ? chosen : tabs[0]?.key;

  return (
    <div>
      <div className={styles.tabs} role="tablist" aria-label="Stock sections">
        {tabs.map((t) => (
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
        {tab === 'items' && <StockItemsTab activeProperty={activeProperty} isOffline={isOffline} />}
        {tab === 'recipes' && <StockRecipesTab isOffline={isOffline} />}
        {tab === 'goods_received' && <StockGoodsReceivedTab activeProperty={activeProperty} isOffline={isOffline} />}
        {tab === 'takes' && <StockTakesTab isOffline={isOffline} />}
        {tab === 'wastage' && <StockWastageTab isOffline={isOffline} />}
        {tab === 'requests' && <StockRequestsTab isOffline={isOffline} permissions={permissions} />}
        {tab === 'transfer' && <StockTransferTab isOffline={isOffline} />}
        {tab === 'reorder' && <StockReorderReportTab activeProperty={activeProperty} />}
        {tab === 'reports' && <StockReportsTab activeProperty={activeProperty} />}
      </div>
    </div>
  );
}
