import { useEffect, useMemo, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { formatQuantity, stockLevelTone } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import { MenuCategoriesCard } from './MenuCategoriesCard.jsx';
import { CostPricesCard } from './CostPricesCard.jsx';
import { computeCategorySections } from './categorySections.js';
import formStyles from './POSForm.module.css';

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** A client-side pre-check so an oversized or wrong-type file fails fast; the server checks the real bytes regardless. */
function photoProblem(file) {
  if (!file) return null;
  if (!PHOTO_TYPES.includes(file.type)) return 'The photo must be a JPG, PNG, or WebP image.';
  if (file.size > MAX_PHOTO_BYTES) return 'The photo must be 2 MB or smaller.';
  return null;
}

const EMPTY_ADD_FORM = { name: '', qty_supplied: '', reorder_level: '', unit_cost: '', selling_price: '', supplier: '' };
const EMPTY_RESTOCK_FORM = { menu_item_id: '', quantity: '', unit_cost: '', reference: '' };
// Every stock item this screen ever creates is a simple, sold-as-one-unit
// resale item (a canned drink, a snack) — the actual measurement unit
// never matters for that case, unlike a cocktail's own recipe (ml, for
// instance), so it's a fixed internal default rather than one more field.
const DEFAULT_UNIT = 'unit';

/**
 * MenuItemsTab — user-requested consolidation: everything about a
 * sellable item (its price, and optionally its own real inventory) in one
 * place, mirroring `StockItemsTab.jsx`'s own single-category-selection
 * redesign, instead of splitting "make it sellable" (Setup) and "track
 * its stock" (Stock) across two separate screens for the common case of a
 * simple, directly-resold item. This is not a new backend capability —
 * every action here is the same real `pos_menu_items`/`stock_items`/
 * `pos_menu_item_components` write Setup/Stock/Recipes already expose,
 * just orchestrated from one form instead of three.
 *
 * A compound item (several ingredients in different ratios, e.g. a
 * cocktail) is deliberately NOT built here, per the confirmed scope — that
 * still goes through the dedicated Stock → Recipes screen, unchanged. An
 * item counts as "linked" by THIS screen only when it has EXACTLY one
 * recipe component (`resolveLink` below): zero means "not stock-tracked"
 * (Restock unavailable — including every menu item created before this
 * screen existed), and more than one means "a compound recipe, managed
 * elsewhere" — never silently adopted here.
 *
 * Creating an item is a real, multi-step client-side orchestration, not
 * one atomic backend transaction spanning two modules — there is no such
 * transaction to have. The MENU item (the one write that actually makes
 * the item sellable) always goes first, so even if a later step fails,
 * the item is already usable in the Register; every later step's own
 * failure is reported as an honest partial-success message — the exact
 * shape `SetupTab.jsx`'s own former "item saved, but its photo wasn't"
 * case already established — never a silent rollback attempt (there is no
 * delete endpoint for a stock item to roll one back with, only archive).
 */
export function MenuItemsTab({ activeProperty, outletId, outletName, isOffline = false }) {
  const [categories, setCategories] = useState(null);
  const [menuItems, setMenuItems] = useState(null);
  const [stockItems, setStockItems] = useState(null);
  // menuItemId (string) -> { stockItemId } | null — see `resolveLinks`.
  const [linksByMenuItemId, setLinksByMenuItemId] = useState(null);
  const [error, setError] = useState(null);
  const [showCostPrices, setShowCostPrices] = useState(false);

  const [selectedRowKey, setSelectedRowKey] = useState(null);

  // Only one of Add/Edit is ever open at a time, matching `StockItemsTab`'s
  // own single-open-panel discipline.
  const [activePanel, setActivePanel] = useState(null);
  // { type: 'add', sectionKey, categoryName, sectionTitle }
  // { type: 'edit', item }

  const [addForm, setAddForm] = useState(EMPTY_ADD_FORM);
  const [addPhoto, setAddPhoto] = useState(null);
  const [addPhotoKey, setAddPhotoKey] = useState(0);
  const [addError, setAddError] = useState(null);
  const [addSubmitting, setAddSubmitting] = useState(false);

  const [editForm, setEditForm] = useState({ name: '', category: '', price: '', cost_price: '', reorder_level: '', supplier: '' });
  const [editPhoto, setEditPhoto] = useState(null);
  const [editImageUrl, setEditImageUrl] = useState(null);
  const [editError, setEditError] = useState(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [restockForm, setRestockForm] = useState(EMPTY_RESTOCK_FORM);
  const [restockError, setRestockError] = useState(null);
  const [restockSubmitting, setRestockSubmitting] = useState(false);
  const [restockSaved, setRestockSaved] = useState(false);

  async function reloadCategories() {
    try {
      setCategories(await posApi.listMenuCategories());
    } catch {
      setCategories([]);
    }
  }

  /** A category renamed or archived changes which menu items show it, so refresh both. */
  async function handleCategoriesChanged() {
    await reloadCategories();
    await reloadItems();
  }

  /**
   * Resolves, for every menu item, its recipe shape — the value stored per
   * item id is `{stockItemId}` for exactly one component (this screen's
   * own "linked" case), the string `'compound'` for more than one (a real
   * recipe, managed via Stock → Recipes, never adopted here), or `null`
   * for zero (not stock-tracked at all). A real N+1 fetch (one
   * `listMenuItemComponents` call per menu item) — accepted here the same
   * way `StockRecipesTab.jsx` already accepts one call per recipe lookup;
   * POS catalogues at this screen's own scale (an outlet's own menu) are
   * small enough that this stays fast, and there is no bulk
   * "components for every item" endpoint to call instead.
   */
  async function resolveLinks(menuList) {
    const entries = await Promise.all(
      menuList.map(async (item) => {
        try {
          const components = await stockApi.listMenuItemComponents(item.id);
          if (components.length === 1) return [item.id, { stockItemId: components[0].stock_item_id }];
          if (components.length > 1) return [item.id, 'compound'];
          return [item.id, null];
        } catch {
          return [item.id, null];
        }
      })
    );
    setLinksByMenuItemId(Object.fromEntries(entries));
  }

  async function reloadItems() {
    try {
      const [menuList, stockList] = await Promise.all([posApi.listMenuItems(outletId), stockApi.listStockItems({ outletId })]);
      setMenuItems(menuList);
      setStockItems(stockList);
      setError(null);
      await resolveLinks(menuList);
    } catch (caught) {
      setMenuItems([]);
      setStockItems([]);
      setLinksByMenuItemId({});
      setError(caught instanceof ApiError ? caught.message : 'Could not load this outlet.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; categories are shared across every outlet, fetched once regardless of which one is selected
    reloadCategories();
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: resets every piece of this outlet's own state before fetching the newly-selected outlet's data, the same reset-on-selection-change shape `StockItemsTab.jsx`'s own `handleFilterChange` already establishes
    setMenuItems(null);
    setStockItems(null);
    setLinksByMenuItemId(null);
    setActivePanel(null);
    setSelectedRowKey(null);
    reloadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to `outletId` changing only
  }, [outletId]);

  const stockItemsById = useMemo(() => new Map((stockItems ?? []).map((item) => [String(item.id), item])), [stockItems]);

  /** The linked stock item's own real row, or `null` for "not tracked"/"compound recipe" — the one place every card below asks this question. */
  function linkedStockItemFor(menuItemId) {
    const link = linksByMenuItemId?.[menuItemId];
    if (!link || link === 'compound') return null;
    return stockItemsById.get(String(link.stockItemId)) ?? null;
  }

  const sections = useMemo(
    () => (menuItems === null || categories === null ? null : computeCategorySections(categories, menuItems, { includeUncategorized: false, noun: 'menu category' })),
    [menuItems, categories]
  );
  const currentSection = sections ? (sections.find((section) => section.selectId === selectedRowKey) ?? null) : null;

  /** Mirrors `StockItemsTab.jsx`'s own identical effect — see that file's header for the full reasoning. */
  useEffect(() => {
    if (!sections || sections.length === 0) return;
    if (sections.some((section) => section.selectId === selectedRowKey)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: this effect's whole job IS correcting `selectedRowKey` once `sections` resolves or changes shape underneath it
    setSelectedRowKey(sections[0].selectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to `sections` changing only; including `selectedRowKey` would fight a deliberate click by re-running right after it changes
  }, [sections]);

  /**
   * Options for the Edit form's category dropdown only — the Add form has
   * none at all (category is implied by which section "Add item" was
   * opened from), matching `StockItemsTab.jsx`'s identical reasoning. An
   * item already in a category that is no longer active keeps that value
   * selectable, so opening its edit form never silently changes it.
   */
  function categoryOptions(current) {
    const names = (categories ?? []).map((category) => category.name);
    if (current && !names.includes(current)) names.push(current);
    return names;
  }

  function selectSection(row) {
    setActivePanel(null);
    setRestockForm(EMPTY_RESTOCK_FORM);
    setRestockError(null);
    setRestockSaved(false);
    setSelectedRowKey(row.id ?? row.key);
  }

  const extraRows = sections
    ? sections.filter((section) => section.key.startsWith('archived-category-')).map((section) => ({ key: section.key, name: section.title, item_count: section.items.length }))
    : [];

  function openAdd(section) {
    setActivePanel({ type: 'add', sectionKey: section.key, categoryName: section.categoryName, sectionTitle: section.title });
    setAddForm(EMPTY_ADD_FORM);
    setAddPhoto(null);
    setAddPhotoKey((key) => key + 1);
    setAddError(null);
  }

  function openEdit(item) {
    const link = linkedStockItemFor(item.id);
    setActivePanel({ type: 'edit', item });
    setEditForm({
      name: item.name,
      category: item.category,
      price: item.price,
      cost_price: item.cost_price ?? '',
      reorder_level: link?.reorder_level ?? '',
      supplier: link?.supplier ?? '',
    });
    setEditPhoto(null);
    setEditImageUrl(item.image_url ?? null);
    setEditError(null);
  }

  /**
   * Creates the menu item (making it real and sellable), then a linked
   * stock item and 1-quantity recipe if any inventory field was filled
   * in — see this file's own header for why the menu item always goes
   * first, and why a later step's failure degrades to a message rather
   * than any kind of rollback.
   */
  async function handleAddSubmit(event) {
    event.preventDefault();
    setAddSubmitting(true);
    setAddError(null);

    const photoIssue = photoProblem(addPhoto);
    if (photoIssue) {
      setAddError(photoIssue);
      setAddSubmitting(false);
      return;
    }
    if (addForm.qty_supplied && !addForm.unit_cost) {
      setAddError('Unit cost is required to record the quantity supplied.');
      setAddSubmitting(false);
      return;
    }

    // Code-review fix (mirrors `StockItemsTab.jsx`'s own identical one):
    // read the category from the CURRENT sections list, never the name
    // frozen into `activePanel` when the panel was opened — a category can
    // be renamed while its own Add panel stays open.
    const liveSection = sections?.find((section) => section.key === activePanel.sectionKey);
    const categoryName = liveSection ? liveSection.categoryName : activePanel.categoryName;
    const form = addForm;

    let menuItem = null;
    try {
      menuItem = await posApi.createMenuItem({ outletId, name: form.name, category: categoryName, price: form.selling_price, costPrice: form.unit_cost || undefined });
      // The item is real and sellable now — clear the form immediately, so
      // a retry after a failure further down can never create it twice.
      setAddForm(EMPTY_ADD_FORM);
      setAddPhoto(null);
      setAddPhotoKey((key) => key + 1);
    } catch (caught) {
      setAddError(caught instanceof ApiError ? caught.message : 'Could not create this item.');
      setAddSubmitting(false);
      return;
    }

    const problems = [];
    try {
      if (addPhoto) await posApi.uploadMenuItemImage(menuItem.id, addPhoto);
    } catch (caught) {
      problems.push(`its photo was not (${caught instanceof ApiError ? caught.message : 'unknown error'})`);
    }

    try {
      const trackingRequested = form.qty_supplied || form.reorder_level || form.unit_cost || form.supplier;
      if (trackingRequested) {
        const stockItem = await stockApi.createStockItem({
          outletId,
          name: form.name,
          unit: DEFAULT_UNIT,
          purchaseCost: form.unit_cost || undefined,
          supplier: form.supplier || undefined,
          reorderLevel: form.reorder_level || undefined,
        });
        if (form.qty_supplied) {
          await stockApi.recordGoodsReceived({
            outletId,
            reference: 'Initial stock',
            lines: [{ stockItemId: stockItem.id, quantity: form.qty_supplied, unitCost: form.unit_cost }],
          });
        }
        await stockApi.upsertMenuItemComponents(menuItem.id, [{ stockItemId: stockItem.id, quantity: '1' }]);
      }
    } catch (caught) {
      problems.push(`inventory tracking could not be set up (${caught instanceof ApiError ? caught.message : 'unknown error'})`);
    }

    if (problems.length > 0) {
      setAddError(`"${form.name}" was added and is sellable in the Register, but ${problems.join(', and ')}. You can retry via Edit, or Stock → Recipes.`);
    }
    await reloadItems();
    setAddSubmitting(false);
  }

  /**
   * Mirrors `SetupTab.jsx`'s own former `handleEditMenuItem` exactly — a
   * single try, a `saved` flag distinguishing "the real update failed" (an
   * early, unambiguous error, nothing else attempted) from "the update
   * itself succeeded but a later step didn't" (an honest partial-success
   * message, and the list still reloads to reflect what DID save) — now
   * extended with one more optional step (the linked stock item's own
   * reorder level/supplier) alongside the existing photo upload.
   */
  async function handleEditSubmit(event) {
    event.preventDefault();
    setEditSubmitting(true);
    setEditError(null);
    const photoIssue = photoProblem(editPhoto);
    if (photoIssue) {
      setEditError(photoIssue);
      setEditSubmitting(false);
      return;
    }

    const item = activePanel.item;
    const link = linkedStockItemFor(item.id);
    let saved = false;
    try {
      await posApi.updateMenuItem(item.id, { name: editForm.name, category: editForm.category, price: editForm.price, cost_price: editForm.cost_price || null });
      saved = true;
      if (editPhoto) await posApi.uploadMenuItemImage(item.id, editPhoto);
      if (link) await stockApi.updateStockItem(link.id, { supplier: editForm.supplier || null, reorderLevel: editForm.reorder_level });
      setActivePanel(null);
      await reloadItems();
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Could not update this item.';
      setEditError(saved ? `Your changes were saved, but not everything: ${message}` : message);
      if (saved) await reloadItems();
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleRemovePhoto() {
    setEditError(null);
    try {
      await posApi.removeMenuItemImage(activePanel.item.id);
      setEditImageUrl(null);
      await reloadItems();
    } catch (caught) {
      setEditError(caught instanceof ApiError ? caught.message : 'Could not remove this photo.');
    }
  }

  async function handleToggleAvailability(item) {
    try {
      await posApi.setMenuItemAvailability(item.id, !item.is_available);
      await reloadItems();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update availability.');
    }
  }

  async function handleRestockSubmit(event) {
    event.preventDefault();
    setRestockSubmitting(true);
    setRestockError(null);
    setRestockSaved(false);
    // Re-resolved at submit time, never trusted from a value frozen when
    // the item was picked — the same "read live, not frozen" discipline
    // this file's own `handleAddSubmit` already applies to a category
    // name, in case a background reload changed the underlying link.
    const link = linksByMenuItemId?.[restockForm.menu_item_id];
    if (!link || link === 'compound') {
      setRestockError('This item no longer has a linked stock item to restock — pick another, or refresh the page.');
      setRestockSubmitting(false);
      return;
    }
    try {
      await stockApi.recordGoodsReceived({
        outletId,
        reference: restockForm.reference || undefined,
        lines: [{ stockItemId: link.stockItemId, quantity: restockForm.quantity, unitCost: restockForm.unit_cost }],
      });
      setRestockForm(EMPTY_RESTOCK_FORM);
      setRestockSaved(true);
      await reloadItems();
    } catch (caught) {
      setRestockError(caught instanceof ApiError ? caught.message : 'Could not record this delivery.');
    } finally {
      setRestockSubmitting(false);
    }
  }

  const restockableItems = (currentSection?.items ?? []).filter((item) => {
    const link = linksByMenuItemId?.[item.id];
    return link && link !== 'compound';
  });

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Menu items cannot be added, edited, restocked, or archived until connectivity returns.</p>}

      <MenuCategoriesCard categories={categories} onChanged={handleCategoriesChanged} extraRows={extraRows} selectedRowKey={selectedRowKey} onSelectRow={selectSection} />

      {currentSection === null ? (
        <DataTable state="loading" columns={[]} rows={[]} rowKey={(row) => row.id} />
      ) : (
        (() => {
          const section = currentSection;
          const addOpenHere = activePanel?.type === 'add' && activePanel.sectionKey === section.key;
          const liveEditItem = activePanel?.type === 'edit' ? section.items.find((item) => item.id === activePanel.item.id) : null;
          const editingItem = activePanel?.type === 'edit' && liveEditItem ? liveEditItem : null;
          const editingLink = editingItem ? linkedStockItemFor(editingItem.id) : null;

          return (
            <div className={formStyles.categorySection}>
              <DataTable
                title={`Items — ${section.title} (${outletName})`}
                state={section.items.length === 0 ? 'empty' : 'success'}
                emptyMessage="No items yet — add the first one below."
                footer={
                  section.canAddItem && !addOpenHere ? (
                    <Button type="button" variant="secondary" size="compact" disabled={isOffline} onClick={() => openAdd(section)}>
                      Add item
                    </Button>
                  ) : null
                }
                columns={[
                  {
                    key: 'image_url',
                    label: 'Photo',
                    render: (row) => (row.image_url ? <img className={formStyles.thumb} src={row.image_url} alt={`Photo of ${row.name}`} loading="lazy" /> : '—'),
                  },
                  { key: 'name', label: 'Name' },
                  { key: 'price', label: 'Selling price', align: 'right', render: (row) => <Money amount={row.price} currencyCode={activeProperty.base_currency} /> },
                  {
                    key: 'stock',
                    label: 'Stock',
                    align: 'right',
                    render: (row) => {
                      if (linksByMenuItemId?.[row.id] === 'compound') return 'Compound recipe';
                      const link = linkedStockItemFor(row.id);
                      if (!link) return 'Not tracked';
                      const level = stockLevelTone(link.current_quantity, link.reorder_level);
                      return (
                        <>
                          {formatQuantity(link.current_quantity, link.unit)}
                          {level && ` (${level.label})`}
                        </>
                      );
                    },
                  },
                  { key: 'reorder_level', label: 'Reorder level', align: 'right', render: (row) => formatQuantity(linkedStockItemFor(row.id)?.reorder_level, linkedStockItemFor(row.id)?.unit) },
                  {
                    key: 'unit_cost',
                    label: 'Unit cost',
                    align: 'right',
                    render: (row) => {
                      const link = linkedStockItemFor(row.id);
                      return link?.purchase_cost != null ? <Money amount={link.purchase_cost} currencyCode={activeProperty.base_currency} /> : '—';
                    },
                  },
                  { key: 'supplier', label: 'Supplier', render: (row) => linkedStockItemFor(row.id)?.supplier ?? '—' },
                  { key: 'is_available', label: 'Available', render: (row) => (row.is_available ? 'Yes' : 'Stocked out') },
                ]}
                rows={section.items}
                rowKey={(row) => row.id}
                actions={(row) => (
                  <>
                    <Button size="compact" variant="ghost" disabled={isOffline} onClick={() => openEdit(row)}>
                      Edit
                    </Button>
                    <Button size="compact" variant="ghost" disabled={isOffline} onClick={() => handleToggleAvailability(row)}>
                      {row.is_available ? 'Mark stocked out' : 'Mark available'}
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
                      <span className={formStyles.label}>Name</span>
                      <input className={formStyles.input} value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} required disabled={isOffline} />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Selling price</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.01"
                        min="0"
                        value={addForm.selling_price}
                        onChange={(e) => setAddForm({ ...addForm, selling_price: e.target.value })}
                        required
                        disabled={isOffline}
                      />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Qty supplied (optional)</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.001"
                        min="0"
                        value={addForm.qty_supplied}
                        onChange={(e) => setAddForm({ ...addForm, qty_supplied: e.target.value })}
                        disabled={isOffline}
                      />
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
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Unit cost (optional)</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.01"
                        min="0"
                        value={addForm.unit_cost}
                        onChange={(e) => setAddForm({ ...addForm, unit_cost: e.target.value })}
                        disabled={isOffline}
                      />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Supplier name (optional)</span>
                      <input className={formStyles.input} value={addForm.supplier} onChange={(e) => setAddForm({ ...addForm, supplier: e.target.value })} disabled={isOffline} />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Item image (optional)</span>
                      <input
                        key={addPhotoKey}
                        className={formStyles.fileInput}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(e) => setAddPhoto(e.target.files?.[0] ?? null)}
                        disabled={isOffline}
                      />
                    </label>
                    <p className={formStyles.hint}>
                      Leaving Qty supplied/Reorder level/Unit cost/Supplier all blank creates a sellable item with no inventory tracking — you can add that later via Edit.
                    </p>
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
                  <form className={formStyles.row} onSubmit={handleEditSubmit}>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Name</span>
                      <input className={formStyles.input} value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required disabled={isOffline} />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Selling price</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.01"
                        min="0"
                        value={editForm.price}
                        onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
                        required
                        disabled={isOffline}
                      />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Menu category</span>
                      <select className={formStyles.select} value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} required disabled={isOffline}>
                        {categoryOptions(editForm.category).map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Cost price (optional)</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.01"
                        min="0"
                        value={editForm.cost_price}
                        onChange={(e) => setEditForm({ ...editForm, cost_price: e.target.value })}
                        disabled={isOffline}
                      />
                    </label>
                    {editingLink ? (
                      <>
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
                        <label className={formStyles.field}>
                          <span className={formStyles.label}>Supplier name</span>
                          <input className={formStyles.input} value={editForm.supplier} onChange={(e) => setEditForm({ ...editForm, supplier: e.target.value })} disabled={isOffline} />
                        </label>
                      </>
                    ) : (
                      <p className={formStyles.hint}>This item has no linked stock item (not tracked, or a compound recipe) — reorder level/supplier are not editable here.</p>
                    )}
                    <div className={formStyles.field}>
                      <span className={formStyles.label}>Item image</span>
                      {editImageUrl ? (
                        <img className={formStyles.photoPreview} src={editImageUrl} alt={`Current photo of ${editForm.name}`} />
                      ) : (
                        <span className={formStyles.hint}>No photo yet.</span>
                      )}
                      <input
                        key={editingItem.id}
                        className={formStyles.fileInput}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        aria-label={editImageUrl ? 'Replace photo' : 'Add photo'}
                        onChange={(e) => setEditPhoto(e.target.files?.[0] ?? null)}
                        disabled={isOffline}
                      />
                      {editImageUrl && (
                        <Button type="button" size="compact" variant="ghost" disabled={isOffline} onClick={handleRemovePhoto}>
                          Remove photo
                        </Button>
                      )}
                    </div>
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

              <Card title={`Restock — ${section.title}`}>
                {restockError && (
                  <p role="alert" className={formStyles.errorBanner}>
                    {restockError}
                  </p>
                )}
                {restockSaved && <p className={formStyles.hint}>Stock recorded.</p>}
                {restockableItems.length === 0 ? (
                  <p className={formStyles.hint}>No stock-tracked items in this menu category yet — add one above with Qty supplied/Unit cost filled in, or link a recipe via Stock → Recipes.</p>
                ) : (
                  <form className={formStyles.row} onSubmit={handleRestockSubmit}>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Item</span>
                      <select
                        className={formStyles.select}
                        value={restockForm.menu_item_id}
                        onChange={(e) => setRestockForm({ ...restockForm, menu_item_id: e.target.value })}
                        required
                        disabled={isOffline}
                      >
                        <option value="" disabled>
                          Select an item
                        </option>
                        {restockableItems.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Quantity</span>
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.001"
                        min="0"
                        value={restockForm.quantity}
                        onChange={(e) => setRestockForm({ ...restockForm, quantity: e.target.value })}
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
                        value={restockForm.unit_cost}
                        onChange={(e) => setRestockForm({ ...restockForm, unit_cost: e.target.value })}
                        required
                        disabled={isOffline}
                      />
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Reference (optional)</span>
                      <input
                        className={formStyles.input}
                        placeholder="Delivery note number"
                        value={restockForm.reference}
                        onChange={(e) => setRestockForm({ ...restockForm, reference: e.target.value })}
                        disabled={isOffline}
                      />
                    </label>
                    <div className={formStyles.actionsRow}>
                      <Button type="submit" loading={restockSubmitting} disabled={isOffline}>
                        Record stock
                      </Button>
                    </div>
                  </form>
                )}
              </Card>
            </div>
          );
        })()
      )}

      {/* Every item's cost price in one table, so the Sales/margin reports can show profit. Behind a toggle: it repeats every item, and is a one-off chore, not the everyday view. */}
      {menuItems !== null && linksByMenuItemId !== null && (
        <div className={formStyles.form}>
          <div className={formStyles.actionsRow}>
            <Button type="button" variant="secondary" onClick={() => setShowCostPrices((open) => !open)} aria-expanded={showCostPrices}>
              {showCostPrices ? 'Hide cost prices' : 'Set cost prices for all items'}
            </Button>
          </div>
        </div>
      )}
      {showCostPrices && menuItems !== null && linksByMenuItemId !== null && (
        <CostPricesCard
          menuItems={menuItems}
          recipeKind={(id) => (linksByMenuItemId[id] === 'compound' ? 'compound' : linksByMenuItemId[id] ? 'stock' : 'none')}
          linkedStockItemFor={linkedStockItemFor}
          activeProperty={activeProperty}
          isOffline={isOffline}
          onSaved={reloadItems}
        />
      )}
    </div>
  );
}
