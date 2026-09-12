import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { formatQuantity } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

/**
 * StockRecipesTab — PLAN.md Phase 6's menu-item recipe/BOM: pick a menu
 * item at an outlet, see and edit how much of which stock items selling
 * ONE unit of it consumes (`pos_menu_item_components`). `pos.stock_manage`
 * only, backend-enforced — no client-side check hides this tab, matching
 * `SetupTab.jsx`'s own established convention.
 *
 * A full replace-all upsert, matching the backend's own shape
 * (`stock/service.js`'s `upsertMenuItemComponents`) — there is no per-row
 * patch endpoint. The stock-item picker is scoped to the SAME outlet as the
 * selected menu item throughout, so the real backend's "same outlet only"
 * rule (`VALIDATION_STOCK_ITEM_OUTLET_MISMATCH`) is never actually
 * reachable from this form — it stays the real backstop, not the only
 * enforcement.
 */
export function StockRecipesTab({ isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState('');
  const [menuItems, setMenuItems] = useState(null);
  const [selectedMenuItemId, setSelectedMenuItemId] = useState('');
  const [stockItems, setStockItems] = useState(null);

  const [components, setComponents] = useState([]);
  const [newStockItemId, setNewStockItemId] = useState('');
  const [newQuantity, setNewQuantity] = useState('');

  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
  }, []);

  async function handleSelectOutlet(outletId) {
    setSelectedOutletId(outletId);
    setSelectedMenuItemId('');
    setComponents([]);
    setMenuItems(null);
    setStockItems(null);
    try {
      const [menuList, stockList] = await Promise.all([posApi.listMenuItems(outletId), stockApi.listStockItems({ outletId })]);
      setMenuItems(menuList);
      setStockItems(stockList);
      setLoadError(null);
    } catch (caught) {
      setMenuItems([]);
      setStockItems([]);
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load this outlet.');
    }
  }

  async function handleSelectMenuItem(menuItemId) {
    setSelectedMenuItemId(menuItemId);
    setSaved(false);
    setSaveError(null);
    try {
      const rows = await stockApi.listMenuItemComponents(menuItemId);
      setComponents(rows.map((row) => ({ stockItemId: row.stock_item_id, quantity: row.quantity })));
      setLoadError(null);
    } catch (caught) {
      setComponents([]);
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load this recipe.');
    }
  }

  const stockItemsById = new Map((stockItems ?? []).map((item) => [String(item.id), item]));
  const availableStockItems = (stockItems ?? []).filter((item) => !components.some((c) => String(c.stockItemId) === String(item.id)));

  function handleAddRow() {
    if (!newStockItemId || !newQuantity) return;
    setComponents([...components, { stockItemId: newStockItemId, quantity: newQuantity }]);
    setNewStockItemId('');
    setNewQuantity('');
    setSaved(false);
  }

  function handleRemoveRow(stockItemId) {
    setComponents(components.filter((c) => String(c.stockItemId) !== String(stockItemId)));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await stockApi.upsertMenuItemComponents(selectedMenuItemId, components);
      setComponents(result.map((row) => ({ stockItemId: row.stock_item_id, quantity: row.quantity })));
      setSaved(true);
    } catch (caught) {
      setSaveError(caught instanceof ApiError ? caught.message : 'Could not save this recipe.');
    } finally {
      setSaving(false);
    }
  }

  const selectedMenuItem = (menuItems ?? []).find((item) => String(item.id) === String(selectedMenuItemId));

  return (
    <div className={formStyles.form}>
      {loadError && (
        <p role="alert" className={formStyles.errorBanner}>
          {loadError}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Recipes cannot be saved until connectivity returns.</p>}

      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Outlet</span>
          <select className={formStyles.select} value={selectedOutletId} onChange={(event) => handleSelectOutlet(event.target.value)}>
            <option value="">Select an outlet</option>
            {(outlets ?? []).map((outlet) => (
              <option key={outlet.id} value={outlet.id}>
                {outlet.name}
              </option>
            ))}
          </select>
        </label>
        {selectedOutletId && (
          <label className={formStyles.field}>
            <span className={formStyles.label}>Menu item</span>
            <select className={formStyles.select} value={selectedMenuItemId} onChange={(event) => handleSelectMenuItem(event.target.value)}>
              <option value="">Select a menu item</option>
              {(menuItems ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {selectedMenuItem && (
        <Card title={`Recipe — ${selectedMenuItem.name}`}>
          {saveError && (
            <p role="alert" className={formStyles.errorBanner}>
              {saveError}
            </p>
          )}
          {saved && <p className={formStyles.hint}>Recipe saved.</p>}

          <DataTable
            state={components.length === 0 ? 'empty' : 'success'}
            emptyMessage="No recipe components yet — add one below. This menu item's stock is never affected by a sale until it has at least one."
            columns={[
              { key: 'stock_item', label: 'Stock item', render: (row) => stockItemsById.get(String(row.stockItemId))?.name ?? `#${row.stockItemId}` },
              {
                key: 'quantity',
                label: 'Quantity per unit sold',
                align: 'right',
                render: (row) => formatQuantity(row.quantity, stockItemsById.get(String(row.stockItemId))?.unit),
              },
            ]}
            rows={components}
            rowKey={(row) => row.stockItemId}
            actions={(row) => (
              <Button size="compact" variant="danger" disabled={isOffline} onClick={() => handleRemoveRow(row.stockItemId)}>
                Remove
              </Button>
            )}
          />

          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Add stock item</span>
              <select className={formStyles.select} value={newStockItemId} onChange={(event) => setNewStockItemId(event.target.value)} disabled={isOffline}>
                <option value="">Select a stock item</option>
                {availableStockItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.unit})
                  </option>
                ))}
              </select>
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Quantity</span>
              <input className={formStyles.input} type="number" step="0.001" min="0" value={newQuantity} onChange={(event) => setNewQuantity(event.target.value)} disabled={isOffline} />
            </label>
            <div className={formStyles.actionsRow}>
              <Button type="button" variant="secondary" disabled={isOffline || !newStockItemId || !newQuantity} onClick={handleAddRow}>
                Add to recipe
              </Button>
            </div>
          </div>

          <div className={formStyles.actionsRow}>
            <Button type="button" loading={saving} disabled={isOffline} onClick={handleSave}>
              Save recipe
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
