import { useEffect, useState } from 'react';
import { Card, DataTable, Button, ConfirmDialog, StatusPill } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { formatQuantity } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import { StockCategoriesCard } from './StockCategoriesCard.jsx';
import formStyles from './POSForm.module.css';

const EMPTY_ADD_FORM = { outlet_id: '', name: '', unit: '', purchase_cost: '', supplier: '', reorder_level: '' };
const EMPTY_RECEIVE_FORM = { quantity: '', unit_cost: '', reference: '' };

/**
 * Groups the flat `items` list under each of `categories`' own real rows
 * (in display order), so every registered category shows as its own
 * section — including one with zero items, so "create an item directly
 * inside a category" has somewhere to click even before any item exists
 * there yet. An item pointing at a category that has SINCE been archived
 * (the same edge case the old flat table's own `categoryOptions` dropdown
 * already handled) gets its own clearly-labelled section too, rather than
 * silently vanishing from the screen — it just can't accept new items,
 * since an archived category can no longer be chosen for one. A final
 * "Uncategorized" section, always present, covers items with no category
 * at all (stock category is optional, unlike a menu item's).
 */
function computeSections(categories, items) {
  const sortedCategories = (categories ?? [])
    .slice()
    .sort((a, b) => (a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.name.localeCompare(b.name)));
  const activeNames = new Set(sortedCategories.map((category) => category.name));

  const itemsByCategoryName = new Map();
  const uncategorizedItems = [];
  for (const item of items ?? []) {
    if (!item.category) {
      uncategorizedItems.push(item);
      continue;
    }
    if (!itemsByCategoryName.has(item.category)) itemsByCategoryName.set(item.category, []);
    itemsByCategoryName.get(item.category).push(item);
  }

  const sections = sortedCategories.map((category) => ({
    key: `category-${category.id}`,
    title: category.name,
    categoryName: category.name,
    canAddItem: true,
    items: itemsByCategoryName.get(category.name) ?? [],
  }));

  for (const [name, categoryItems] of itemsByCategoryName) {
    if (!activeNames.has(name)) {
      sections.push({ key: `archived-category-${name}`, title: `${name} (archived category)`, categoryName: name, canAddItem: false, items: categoryItems });
    }
  }

  sections.push({ key: 'uncategorized', title: 'Uncategorized', categoryName: null, canAddItem: true, items: uncategorizedItems });
  return sections;
}

/**
 * A purely visual threshold for the "On hand" column's pill — never
 * written back anywhere, so a plain `Number()` comparison is fine here
 * even though this codebase's own "quantity is exact, always" rule
 * (mirroring ARCHITECTURE.md §1/§12 for money) governs every real WRITE to
 * a quantity value. Matches the existing "Low stock only" filter's own
 * definition (`current_quantity <= reorder_level`) exactly for the warning
 * tier, and adds a distinct, more urgent tier once it's actually at or
 * below zero.
 */
function stockLevelTone(currentQuantity, reorderLevel) {
  const quantity = Number(currentQuantity);
  if (quantity <= 0) return { tone: 'danger', label: 'Out of stock' };
  if (quantity <= Number(reorderLevel)) return { tone: 'warning', label: 'Low stock' };
  return null;
}

/**
 * StockItemsTab — PLAN.md Phase 6's "POS inventory & stock control"
 * (PRODUCT_REQUIREMENTS.md §3.4). Redesign (user-reported: creating a
 * category, adding an item to it, receiving stock, and seeing the current
 * balance required jumping between separate tabs/panels): one consolidated
 * screen, items grouped under their own category's section, an item
 * created directly inside a section (category implied, never a possibly-
 * empty dropdown), and a per-row "Receive" quick action.
 *
 * `pos.stock_view` sees this list read-only; `pos.stock_manage` is what the
 * backend actually requires for create/update/archive/receive
 * (`stock/routes.js`). No client-side permission check hides any control
 * here — the same "always reachable, the real 403 is what a lower-tier
 * account sees" convention this screen already established.
 *
 * `purchase_cost` and `current_quantity` are deliberately NOT editable
 * fields on the edit form — both are server-managed (the former
 * wholesale-replaced only by a real goods-received delivery, the latter
 * always re-derived from the real `stock_movements` ledger by
 * `stock/service.js`'s own `recomputeStockItemQuantity`, its one writer).
 * The "Receive" quick action posts through that SAME real ledger call
 * (`stockApi.recordGoodsReceived`, a one-line array) — never a direct edit
 * of `current_quantity` — so the audit trail and variance detection this
 * module exists for keep working exactly as they do for a bulk delivery on
 * the separate Goods Received tab, which stays untouched for multi-line
 * deliveries.
 */
export function StockItemsTab({ activeProperty, isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [items, setItems] = useState(null);
  const [outletFilter, setOutletFilter] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [error, setError] = useState(null);
  // Registered stock categories (shared by every outlet) — one section per row.
  const [categories, setCategories] = useState(null);

  // Only one of Add/Edit/Receive is ever open at a time — opening any one
  // implicitly closes whichever else was open, the same single-open-panel
  // discipline the old edit-only version of this screen already used.
  const [activePanel, setActivePanel] = useState(null);
  // { type: 'add', sectionKey, categoryName, sectionTitle }
  // { type: 'edit', item }
  // { type: 'receive', item }

  const [addForm, setAddForm] = useState(EMPTY_ADD_FORM);
  const [addError, setAddError] = useState(null);
  const [addSubmitting, setAddSubmitting] = useState(false);

  const [editForm, setEditForm] = useState({ name: '', unit: '', category: '', supplier: '', reorder_level: '' });
  const [editError, setEditError] = useState(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [receiveForm, setReceiveForm] = useState(EMPTY_RECEIVE_FORM);
  const [receiveError, setReceiveError] = useState(null);
  const [receiveSubmitting, setReceiveSubmitting] = useState(false);

  const [archiving, setArchiving] = useState(null);

  async function reloadCategories() {
    try {
      setCategories(await stockApi.listStockItemCategories());
    } catch {
      setCategories([]);
    }
  }

  /** A category renamed or archived changes which stock items show it, so refresh both. */
  async function handleCategoriesChanged() {
    await reloadCategories();
    await reloadItems();
  }

  /**
   * Options for the Edit form's category dropdown only — the Add form no
   * longer has one at all (category is implied by which section "Add
   * item" was opened from). A stock item already in a category that is no
   * longer active keeps that value selectable, so opening its edit form
   * never silently changes it.
   */
  function categoryOptions(current) {
    const names = (categories ?? []).map((category) => category.name);
    if (current && !names.includes(current)) names.push(current);
    return names;
  }

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadCategories();
  }, []);

  async function reloadItems() {
    try {
      setItems(await stockApi.listStockItems({ outletId: outletFilter || undefined, lowStockOnly }));
      setError(null);
    } catch (caught) {
      setItems([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load stock items.');
    }
  }

  useEffect(() => {
    reloadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- outletFilter/lowStockOnly drive this refetch directly
  }, [outletFilter, lowStockOnly]);

  /**
   * Code-review fix: changing the outlet/low-stock filter can make the
   * item behind an open Edit/Receive panel disappear from every section's
   * own list — left open, the panel would silently vanish (and could
   * silently reappear, with stale form values, if the filter changes
   * back) with no explanation. Closing it here, at the point of
   * interaction, is the same "never leave a control pointing at
   * something no longer shown" discipline the toolbar's own
   * always-visible placement already follows for the opposite direction
   * (a control must never vanish just because the filtered result is
   * empty).
   */
  function handleFilterChange(updateFilter) {
    setActivePanel(null);
    updateFilter();
  }

  function openAdd(section) {
    setActivePanel({ type: 'add', sectionKey: section.key, categoryName: section.categoryName, sectionTitle: section.title });
    setAddForm((current) => ({ ...EMPTY_ADD_FORM, outlet_id: outletFilter || current.outlet_id }));
    setAddError(null);
  }

  function openEdit(item) {
    setActivePanel({ type: 'edit', item });
    setEditForm({ name: item.name, unit: item.unit, category: item.category ?? '', supplier: item.supplier ?? '', reorder_level: item.reorder_level });
    setEditError(null);
  }

  function openReceive(item) {
    setActivePanel({ type: 'receive', item });
    setReceiveForm(EMPTY_RECEIVE_FORM);
    setReceiveError(null);
  }

  async function handleAddSubmit(event) {
    event.preventDefault();
    setAddSubmitting(true);
    setAddError(null);
    try {
      // Code-review fix: read the category from the CURRENT sections list,
      // never the name frozen into `activePanel` when the panel was
      // opened — a category can be renamed (via the Stock categories card
      // at the top of this same screen) while its own Add panel stays
      // open, and the panel's own heading already re-renders with the new
      // name every time. Submitting the stale frozen name would send a
      // category that no longer exists, rejected by the backend with a
      // confusing "not registered" error on a form that visibly says the
      // new name. Falls back to the frozen name only if the section has
      // vanished entirely (e.g. the category was archived, not renamed,
      // while the panel was open) — a case the panel itself no longer
      // renders in on the next tick regardless.
      const liveSection = sections?.find((section) => section.key === activePanel.sectionKey);
      await stockApi.createStockItem({
        outletId: addForm.outlet_id,
        name: addForm.name,
        unit: addForm.unit,
        category: (liveSection ? liveSection.categoryName : activePanel.categoryName) || undefined,
        purchaseCost: addForm.purchase_cost || undefined,
        supplier: addForm.supplier || undefined,
        reorderLevel: addForm.reorder_level || undefined,
      });
      // Keeps the SAME section's Add panel open and the outlet pre-filled —
      // adding several items to the same category/outlet in a row needs
      // neither reopening the form nor re-picking the outlet each time.
      setAddForm((current) => ({ ...EMPTY_ADD_FORM, outlet_id: current.outlet_id }));
      await reloadItems();
    } catch (caught) {
      setAddError(caught instanceof ApiError ? caught.message : 'Could not create this stock item.');
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleEditSubmit(event) {
    event.preventDefault();
    setEditSubmitting(true);
    setEditError(null);
    try {
      await stockApi.updateStockItem(activePanel.item.id, {
        name: editForm.name,
        unit: editForm.unit,
        category: editForm.category || null,
        supplier: editForm.supplier || null,
        reorderLevel: editForm.reorder_level,
      });
      setActivePanel(null);
      await reloadItems();
    } catch (caught) {
      setEditError(caught instanceof ApiError ? caught.message : 'Could not update this stock item.');
    } finally {
      setEditSubmitting(false);
    }
  }

  /**
   * The one-item "Receive" quick action — the SAME real ledger call the
   * bulk Goods Received tab uses (`recordGoodsReceived`), just with a
   * single-element `lines` array. Nothing about that backend function
   * treats one line as a special case; it's the normal floor, not a
   * workaround (`stock/service.js`'s own `recordGoodsReceived` requires
   * at least one line and processes each identically in a plain loop).
   */
  async function handleReceiveSubmit(event) {
    event.preventDefault();
    setReceiveSubmitting(true);
    setReceiveError(null);
    try {
      const item = activePanel.item;
      await stockApi.recordGoodsReceived({
        outletId: item.outlet_id,
        reference: receiveForm.reference || undefined,
        lines: [{ stockItemId: item.id, quantity: receiveForm.quantity, unitCost: receiveForm.unit_cost }],
      });
      setActivePanel(null);
      await reloadItems();
    } catch (caught) {
      setReceiveError(caught instanceof ApiError ? caught.message : 'Could not record this delivery.');
    } finally {
      setReceiveSubmitting(false);
    }
  }

  const sections = items === null || categories === null ? null : computeSections(categories, items);

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Stock items cannot be added, edited, received, or archived until connectivity returns.</p>}

      {/* Outside any Card/DataTable's own success-only slot, deliberately —
          Card only renders `children` while `state === 'success'`, and
          "Low stock only" routinely shows zero rows by design. A filter
          control should never vanish because of that. */}
      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Filter by outlet</span>
          <select className={formStyles.select} value={outletFilter} onChange={(event) => handleFilterChange(() => setOutletFilter(event.target.value))}>
            <option value="">All outlets</option>
            {(outlets ?? []).map((outlet) => (
              <option key={outlet.id} value={outlet.id}>
                {outlet.name}
              </option>
            ))}
          </select>
        </label>
        <label className={formStyles.checkboxField}>
          <input
            className={formStyles.checkbox}
            type="checkbox"
            checked={lowStockOnly}
            onChange={(event) => handleFilterChange(() => setLowStockOnly(event.target.checked))}
          />
          <span className={formStyles.label}>Low stock only</span>
        </label>
      </div>

      <StockCategoriesCard categories={categories} onChanged={handleCategoriesChanged} />

      {sections === null ? (
        <DataTable state="loading" columns={[]} rows={[]} rowKey={(row) => row.id} />
      ) : (
        sections.map((section) => {
          const addOpenHere = activePanel?.type === 'add' && activePanel.sectionKey === section.key;
          // Code-review fix: once the item is found in this section's own
          // (freshly reloaded) list, show THAT row rather than the frozen
          // snapshot taken when the panel was opened — otherwise the
          // read-only "Cost is …"/"On hand is …" hints go stale the
          // moment any background reload happens (e.g. renaming a
          // category via the Stock categories card above reloads both
          // categories and items) while the panel stays open. The frozen
          // snapshot is kept only as a fallback for the one render where
          // the panel first opens, before its own item has ever appeared
          // in a `section.items` array computed from real API data.
          const liveEditItem = activePanel?.type === 'edit' ? section.items.find((item) => item.id === activePanel.item.id) : null;
          const editingItem = activePanel?.type === 'edit' && liveEditItem ? liveEditItem : null;
          const liveReceiveItem = activePanel?.type === 'receive' ? section.items.find((item) => item.id === activePanel.item.id) : null;
          const receivingItem = activePanel?.type === 'receive' && liveReceiveItem ? liveReceiveItem : null;

          return (
            <div className={formStyles.categorySection} key={section.key}>
              <DataTable
                title={section.title}
                state={section.items.length === 0 ? 'empty' : 'success'}
                emptyMessage="No items yet — add the first one below."
                // Rendered inside this SAME bordered card, whether empty or
                // not — never as a sibling element floating in the gap
                // before the next category's own card, which is the exact
                // visual ambiguity a user reported mistaking for a routing
                // bug (the button was always correctly wired to its own
                // section — see `openAdd`/`handleAddSubmit` — the confusion
                // was purely about which category's box it visually sat
                // inside).
                footer={
                  section.canAddItem && !addOpenHere ? (
                    <Button type="button" variant="secondary" size="compact" disabled={isOffline} onClick={() => openAdd(section)}>
                      Add item
                    </Button>
                  ) : null
                }
                columns={[
                  { key: 'name', label: 'Name' },
                  { key: 'unit', label: 'Unit' },
                  {
                    key: 'current_quantity',
                    label: 'On hand',
                    align: 'right',
                    render: (row) => {
                      const level = stockLevelTone(row.current_quantity, row.reorder_level);
                      return (
                        <>
                          {formatQuantity(row.current_quantity, row.unit)}
                          {level && <StatusPill tone={level.tone} label={level.label} className={formStyles.stockPill} />}
                        </>
                      );
                    },
                  },
                  { key: 'reorder_level', label: 'Reorder level', align: 'right', render: (row) => formatQuantity(row.reorder_level, row.unit) },
                  { key: 'purchase_cost', label: 'Cost', align: 'right', render: (row) => <Money amount={row.purchase_cost} currencyCode={activeProperty.base_currency} /> },
                  { key: 'supplier', label: 'Supplier', render: (row) => row.supplier ?? '—' },
                ]}
                rows={section.items}
                rowKey={(row) => row.id}
                actions={(row) => (
                  <>
                    <Button size="compact" variant="ghost" disabled={isOffline} onClick={() => openReceive(row)}>
                      Receive
                    </Button>
                    <Button size="compact" variant="ghost" disabled={isOffline} onClick={() => openEdit(row)}>
                      Edit
                    </Button>
                    <Button size="compact" variant="danger" disabled={isOffline} onClick={() => setArchiving(row)}>
                      Archive
                    </Button>
                  </>
                )}
              />

              {addOpenHere && (
                <Card title={`Add item — ${section.title}`}>
                  {addError && (
                    <p role="alert" className={formStyles.errorBanner}>
                      {addError}
                    </p>
                  )}
                  <form className={formStyles.row} onSubmit={handleAddSubmit}>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Outlet</span>
                      <select className={formStyles.select} value={addForm.outlet_id} onChange={(e) => setAddForm({ ...addForm, outlet_id: e.target.value })} required disabled={isOffline}>
                        <option value="" disabled>
                          Select an outlet
                        </option>
                        {(outlets ?? []).map((outlet) => (
                          <option key={outlet.id} value={outlet.id}>
                            {outlet.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Name</span>
                      <input className={formStyles.input} value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} required disabled={isOffline} />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Unit</span>
                      <input
                        className={formStyles.input}
                        placeholder="ml, bottle, kg…"
                        value={addForm.unit}
                        onChange={(e) => setAddForm({ ...addForm, unit: e.target.value })}
                        required
                        disabled={isOffline}
                      />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Initial cost (optional)</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.01"
                        min="0"
                        value={addForm.purchase_cost}
                        onChange={(e) => setAddForm({ ...addForm, purchase_cost: e.target.value })}
                        disabled={isOffline}
                      />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Supplier (optional)</span>
                      <input className={formStyles.input} value={addForm.supplier} onChange={(e) => setAddForm({ ...addForm, supplier: e.target.value })} disabled={isOffline} />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Reorder level (optional)</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.001"
                        min="0"
                        value={addForm.reorder_level}
                        onChange={(e) => setAddForm({ ...addForm, reorder_level: e.target.value })}
                        disabled={isOffline}
                      />
                    </label>
                    <div className={formStyles.actionsRow}>
                      <Button type="submit" loading={addSubmitting} disabled={isOffline}>
                        Add item
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setActivePanel(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                </Card>
              )}

              {editingItem && (
                <Card title={`Edit — ${editingItem.name}`}>
                  {editError && (
                    <p role="alert" className={formStyles.errorBanner}>
                      {editError}
                    </p>
                  )}
                  <p className={formStyles.hint}>
                    Cost is <Money amount={editingItem.purchase_cost} currencyCode={activeProperty.base_currency} /> — set automatically by the most recent goods-received delivery, not editable
                    here.
                  </p>
                  <p className={formStyles.hint}>
                    On hand is {formatQuantity(editingItem.current_quantity, editingItem.unit)} — quantity only changes through a recorded event, not a direct edit. Use the{' '}
                    <strong>Receive</strong> action to log a delivery, or Sales, Wastage, or a Stock take for the other ways it moves.
                  </p>
                  <form className={formStyles.row} onSubmit={handleEditSubmit}>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Name</span>
                      <input className={formStyles.input} value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required disabled={isOffline} />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Unit</span>
                      <input className={formStyles.input} value={editForm.unit} onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })} required disabled={isOffline} />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Category</span>
                      <select className={formStyles.select} value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} disabled={isOffline}>
                        <option value="">No category</option>
                        {categoryOptions(editForm.category).map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Supplier</span>
                      <input className={formStyles.input} value={editForm.supplier} onChange={(e) => setEditForm({ ...editForm, supplier: e.target.value })} disabled={isOffline} />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Reorder level</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.001"
                        min="0"
                        value={editForm.reorder_level}
                        onChange={(e) => setEditForm({ ...editForm, reorder_level: e.target.value })}
                        disabled={isOffline}
                      />
                    </label>
                    <div className={formStyles.actionsRow}>
                      <Button type="submit" loading={editSubmitting} disabled={isOffline}>
                        Save changes
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setActivePanel(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                </Card>
              )}

              {receivingItem && (
                <Card title={`Receive stock — ${receivingItem.name}`}>
                  {receiveError && (
                    <p role="alert" className={formStyles.errorBanner}>
                      {receiveError}
                    </p>
                  )}
                  <p className={formStyles.hint}>
                    Records a real delivery through the goods-received ledger — the same mechanism the Goods received tab uses for a multi-line delivery, just for this one item.
                  </p>
                  <form className={formStyles.row} onSubmit={handleReceiveSubmit}>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Quantity</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.001"
                        min="0"
                        value={receiveForm.quantity}
                        onChange={(e) => setReceiveForm({ ...receiveForm, quantity: e.target.value })}
                        required
                        disabled={isOffline}
                      />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Unit cost</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.01"
                        min="0"
                        value={receiveForm.unit_cost}
                        onChange={(e) => setReceiveForm({ ...receiveForm, unit_cost: e.target.value })}
                        required
                        disabled={isOffline}
                      />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Reference (optional)</span>
                      <input
                        className={formStyles.input}
                        placeholder="Delivery note number"
                        value={receiveForm.reference}
                        onChange={(e) => setReceiveForm({ ...receiveForm, reference: e.target.value })}
                        disabled={isOffline}
                      />
                    </label>
                    <div className={formStyles.actionsRow}>
                      <Button type="submit" loading={receiveSubmitting} disabled={isOffline}>
                        Receive stock
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setActivePanel(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                </Card>
              )}
            </div>
          );
        })
      )}

      {archiving && (
        <ConfirmDialog
          title="Archive this stock item?"
          consequence={`This archives "${archiving.name}". It stops appearing in lists and pickers; its own past movement history is unaffected.`}
          confirmLabel="Archive"
          onConfirm={async () => {
            setArchiving(null);
            try {
              await stockApi.archiveStockItem(archiving.id);
              await reloadItems();
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not archive this stock item.');
            }
          }}
          onCancel={() => setArchiving(null)}
        />
      )}
    </div>
  );
}
