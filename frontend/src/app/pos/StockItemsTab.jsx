import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, DataTable, Button, ConfirmDialog, StatusPill } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { formatQuantity, stockLevelTone } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import { StockCategoriesCard } from './StockCategoriesCard.jsx';
import { computeCategorySections } from './categorySections.js';
import { SellInRegisterFields } from './SellInRegisterFields.jsx';
import { choiceFromSelection, classifyStockItem, defaultCategorySelection, sellStockItemInRegister, validateSellFields } from './sellInRegister.js';
import formStyles from './POSForm.module.css';

const EMPTY_ADD_FORM = { outlet_id: '', name: '', unit: '', purchase_cost: '', supplier: '', reorder_level: '' };
/** The sentence appended when a Register item's photo could not be saved — the item itself is fine. */
function photoNote(photoError) {
  return photoError ? ` Its photo was not saved (${photoError}) — add it under POS → Setup → Menu items → Edit.` : '';
}

const EMPTY_RECEIVE_FORM = { quantity: '', unit_cost: '', reference: '' };
// `name: null` means "not edited yet" — the Add form's own Name field is shown instead, so the two never drift apart until the user chooses to differ.
const EMPTY_SELL_FORM = { name: '', price: '', category: '', quantity: '1', photo: null };
const EMPTY_ADD_SELL_FORM = { name: null, price: '', category: '', quantity: '1', photo: null };

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

  // Which single section (a real category, "Uncategorized", or an
  // archived-but-still-referenced category) the items card below shows —
  // see `computeSections`' own `selectId` for what this value means for
  // each kind of section.
  const [selectedRowKey, setSelectedRowKey] = useState(null);

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

  // "Sell in Register" (see `sellInRegister.js`): which stock items are
  // already sold, and the registered Register (menu) categories a stock
  // item can be sold under. `links` is `null` while loading and
  // `'unavailable'` when the caller lacks `pos.stock_manage` (the
  // endpoint's gate) — the Register column and button then simply don't
  // render, with no error banner.
  const [links, setLinks] = useState(null);
  const [menuCategories, setMenuCategories] = useState(null);
  const [outletMenuNames, setOutletMenuNames] = useState([]);
  const [sellForm, setSellForm] = useState(EMPTY_SELL_FORM);
  const [sellError, setSellError] = useState(null);
  const [sellSubmitting, setSellSubmitting] = useState(false);
  // After a partial failure (the Register item was created but its stock link
  // failed), `{[stockItemId]: {menuItemId}}` — so a retry, whether from the
  // still-open panel, a reopened one, or an item added via the Add form's
  // checkbox, only redoes the recipe link and never creates a second menu
  // item. Keyed by stock item so it can never leak onto a different row.
  const [sellResumes, setSellResumes] = useState({});
  const sellPanelItemIdRef = useRef(null);
  // Which stock item's Sell panel is on screen right now — read by `handleSellSubmit` after its awaits.
  useEffect(() => {
    sellPanelItemIdRef.current = activePanel?.type === 'sell' ? String(activePanel.item.id) : null;
  }, [activePanel]);
  const sellResume = activePanel?.type === 'sell' ? (sellResumes[String(activePanel.item.id)] ?? null) : null;
  const [addSell, setAddSell] = useState(false);
  // Bumped to clear the (uncontrolled) Add-form image input after a submit or when selling is switched off.
  const [addPhotoKey, setAddPhotoKey] = useState(0);
  const [addSellForm, setAddSellForm] = useState(EMPTY_ADD_SELL_FORM);

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

  // Memoized so the reconciling effect below only re-runs when the
  // underlying data actually changes, not on every unrelated re-render
  // (e.g. typing into the Add/Edit form) — `computeSections` otherwise
  // returns a fresh array/object identity every single call.
  const sections = useMemo(() => (items === null || categories === null ? null : computeCategorySections(categories, items)), [items, categories]);
  const currentSection = sections ? (sections.find((section) => section.selectId === selectedRowKey) ?? null) : null;

  /**
   * Keeps `selectedRowKey` always pointing at a section that genuinely
   * exists: picks the first section the moment data first loads (the
   * confirmed "auto-select the first category" default — `selectedRowKey`
   * starts `null`, which matches nothing), and re-picks it whenever the
   * previously-selected section disappears out from under it — e.g. an
   * archived category with zero items drops out of `sections` entirely
   * the moment its last item is moved elsewhere. Selecting a different,
   * still-present section (an ordinary click) is untouched by this
   * effect; only an invalid selection is ever corrected.
   */
  useEffect(() => {
    if (!sections || sections.length === 0) return;
    if (sections.some((section) => section.selectId === selectedRowKey)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: this effect's whole job IS correcting `selectedRowKey` once `sections` resolves or changes shape underneath it; there's no external system to synchronize with instead
    setSelectedRowKey(sections[0].selectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to `sections` changing only; including `selectedRowKey` would fight a deliberate click by re-running right after it changes
  }, [sections]);

  /** The categories card's clicked row — a real category (`.id`) or one of `extraRows` below (`.key`). Also closes whatever Add/Edit/Receive panel was open for the previously-selected section, matching `handleFilterChange`'s own "never leave a control pointing at something no longer shown" rule. */
  function selectSection(row) {
    setActivePanel(null);
    setSelectedRowKey(row.id ?? row.key);
  }

  // The two kinds of section the categories card doesn't itself manage —
  // appended after the real categories in that same card's row list, per
  // the confirmed "Uncategorized (and an archived-but-referenced category)
  // as a row in the same list" decision.
  const extraRows = sections
    ? sections
        .filter((section) => section.key === 'uncategorized' || section.key.startsWith('archived-category-'))
        .map((section) => ({ key: section.key, name: section.title, item_count: section.items.length }))
    : [];

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
    // Deliberately not part of the try above: a role that can view stock
    // but not manage recipes (403) must still see the list — only the
    // Register column/button go away.
    try {
      setLinks(await stockApi.listMenuItemLinks({ outletId: outletFilter || undefined }));
    } catch {
      setLinks('unavailable');
    }
  }

  /** Registered Register (menu) categories — fetched lazily, the first time a sell form opens. Returns the list so a caller can derive a default from it immediately. */
  async function loadMenuCategories() {
    if (menuCategories !== null) return menuCategories;
    try {
      const list = await posApi.listMenuCategories();
      setMenuCategories(list);
      return list;
    } catch {
      setMenuCategories([]);
      return [];
    }
  }

  async function loadOutletMenuNames(outletId) {
    try {
      const menuItems = await posApi.listMenuItems(outletId);
      setOutletMenuNames(menuItems.map((menuItem) => menuItem.name.trim().toLowerCase()));
    } catch {
      setOutletMenuNames([]);
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
    setAddSell(false);
    setAddSellForm(EMPTY_ADD_SELL_FORM);
  }

  function openEdit(item) {
    setActivePanel({ type: 'edit', item });
    setEditForm({ name: item.name, unit: item.unit, category: item.category ?? '', supplier: item.supplier ?? '', reorder_level: item.reorder_level });
    setEditError(null);
  }

  async function openSell(item) {
    setActivePanel({ type: 'sell', item });
    setSellForm({ ...EMPTY_SELL_FORM, name: item.name });
    setSellError(null);
    loadOutletMenuNames(item.outlet_id);
    const list = await loadMenuCategories();
    // Only fills the category if the user hasn't already picked one while the list was loading.
    setSellForm((current) => (current.category === '' ? { ...current, category: defaultCategorySelection(item.category, list) } : current));
  }

  /** Ticking "Also sell in Register" on the Add form — loads the category list and pre-selects the one matching this section's stock category. */
  async function handleAddSellToggle(checked, categoryName, outletId) {
    setAddSell(checked);
    if (!checked) {
      // Not selling means no Register item to hold a picture — drop it rather than silently ignoring a chosen file.
      setAddSellForm((current) => ({ ...current, photo: null }));
      setAddPhotoKey((key) => key + 1);
      return;
    }
    setAddSellForm(EMPTY_ADD_SELL_FORM);
    if (outletId) loadOutletMenuNames(outletId);
    const list = await loadMenuCategories();
    setAddSellForm((current) => (current.category === '' ? { ...current, category: defaultCategorySelection(categoryName, list) } : current));
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
      const categoryName = (liveSection ? liveSection.categoryName : activePanel.categoryName) || undefined;

      // "Also sell in Register": validate BEFORE creating anything, so a bad
      // price never leaves a stock item created with the sale half-done.
      let sellInput = null;
      if (addSell) {
        sellInput = {
          name: addSellForm.name ?? addForm.name,
          price: addSellForm.price,
          quantityPerSale: addSellForm.quantity,
          photo: addSellForm.photo,
          categoryChoice: choiceFromSelection(addSellForm.category, categoryName),
        };
        const problem = validateSellFields(sellInput);
        if (problem) {
          setAddError(problem);
          return;
        }
      }

      const created = await stockApi.createStockItem({
        outletId: addForm.outlet_id,
        name: addForm.name,
        unit: addForm.unit,
        category: categoryName,
        purchaseCost: addForm.purchase_cost || undefined,
        supplier: addForm.supplier || undefined,
        reorderLevel: addForm.reorder_level || undefined,
      });
      // Keeps the SAME section's Add panel open and the outlet pre-filled —
      // adding several items to the same category/outlet in a row needs
      // neither reopening the form nor re-picking the outlet each time.
      setAddForm((current) => ({ ...EMPTY_ADD_FORM, outlet_id: current.outlet_id }));

      if (sellInput) {
        const result = await sellStockItemInRegister({ stockItem: created, ...sellInput });
        setAddSell(false);
        setAddSellForm(EMPTY_ADD_SELL_FORM);
        setAddPhotoKey((key) => key + 1);
        if (!result.ok) {
          if (result.step === 'link') {
            // The Register item exists already — remember it, so "Sell in Register" on this row only re-links it.
            setSellResumes((current) => ({ ...current, [String(created.id)]: result.resume }));
            loadOutletMenuNames(created.outlet_id);
            setAddError(`"${created.name}" was added to stock and to the Register, but its stock link failed (${result.message}). Use Sell in Register on its row to retry the link.${photoNote(result.photoError)}`);
          } else {
            setAddError(`"${created.name}" was added to stock, but it could not be put in the Register (${result.message}). Use Sell in Register on its row to try again.`);
          }
        } else if (result.photoError) {
          setAddError(`"${created.name}" was added to stock and to the Register.${photoNote(result.photoError)}`);
        }
      }
      await reloadItems();
    } catch (caught) {
      setAddError(caught instanceof ApiError ? caught.message : 'Could not create this stock item.');
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleSellSubmit(event) {
    event.preventDefault();
    const item = activePanel.item;
    const submission = {
      name: sellForm.name,
      price: sellForm.price,
      quantityPerSale: sellForm.quantity,
      photo: sellForm.photo,
      categoryChoice: choiceFromSelection(sellForm.category, item.category),
    };
    // A resume only re-links an already-created Register item, using the
    // remembered quantity — the (locked, possibly reopened and blank) form
    // fields are not needed, so they are not validated.
    const problem = sellResumes[String(item.id)] ? null : validateSellFields(submission);
    if (problem) {
      setSellError(problem);
      return;
    }

    setSellSubmitting(true);
    setSellError(null);
    try {
      const itemKey = String(item.id);
      const result = await sellStockItemInRegister({ stockItem: item, ...submission, resume: sellResumes[itemKey] });
      // The user may have closed this panel or opened another row's while the request ran — only touch what is still on screen.
      const stillOpen = sellPanelItemIdRef.current === itemKey;
      if (result.ok) {
        setSellResumes((current) => {
          const next = { ...current };
          delete next[itemKey];
          return next;
        });
        if (stillOpen) setActivePanel(null);
        await reloadItems();
        // After the reload — a successful reload clears the screen's error banner.
        if (result.photoError) setError(`"${submission.name.trim()}" is now in the Register.${photoNote(result.photoError)}`);
        return;
      }
      if (result.step === 'link') {
        // The Register item now exists (and is sellable); only the stock
        // link failed. Remember it so "Retry linking" never creates a second one.
        setSellResumes((current) => ({ ...current, [itemKey]: result.resume }));
        loadOutletMenuNames(item.outlet_id); // The new Register item now exists — keep the duplicate-name check current.
        if (stillOpen) setSellError(`"${submission.name.trim()}" was added to the Register, but its stock link failed (${result.message}). Retry linking, or set it up under Stock → Recipes.${photoNote(result.photoError)}`);
        await reloadItems();
      } else if (stillOpen) {
        setSellError(result.message);
      }
    } finally {
      setSellSubmitting(false);
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

      <StockCategoriesCard categories={categories} onChanged={handleCategoriesChanged} extraRows={extraRows} selectedRowKey={selectedRowKey} onSelectRow={selectSection} />

      {currentSection === null ? (
        <DataTable state="loading" columns={[]} rows={[]} rowKey={(row) => row.id} />
      ) : (
        (() => {
          const section = currentSection;
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
          const liveSellItem = activePanel?.type === 'sell' ? section.items.find((item) => item.id === activePanel.item.id) : null;
          const sellingItem = activePanel?.type === 'sell' && liveSellItem ? liveSellItem : null;
          const linksLoaded = Array.isArray(links);
          const registerState = (item) => classifyStockItem(item.id, links);
          const anyNotSold = linksLoaded && section.items.some((item) => registerState(item).kind === 'none');
          const editingRegisterState = editingItem && linksLoaded ? registerState(editingItem) : null;

          return (
            <div className={formStyles.categorySection} key={section.key}>
              {anyNotSold && (
                <p className={formStyles.hint}>Items marked &quot;Not sold&quot; don&apos;t appear in the POS Register until you use Sell in Register on them.</p>
              )}
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
                  ...(linksLoaded
                    ? [
                        {
                          key: 'register',
                          label: 'Register',
                          render: (row) => {
                            const state = registerState(row);
                            if (state.kind === 'direct') return <StatusPill tone="success" label={`In Register — ${state.menuItemName}`} />;
                            if (state.kind === 'ingredient') return <StatusPill tone="info" label="Ingredient only" />;
                            return <StatusPill tone="neutral" label="Not sold" />;
                          },
                        },
                      ]
                    : []),
                ]}
                rows={section.items}
                rowKey={(row) => row.id}
                actions={(row) => (
                  <>
                    <Button size="compact" variant="ghost" disabled={isOffline} onClick={() => openReceive(row)}>
                      Receive
                    </Button>
                    {linksLoaded && registerState(row).kind !== 'direct' && (
                      <Button size="compact" variant="ghost" disabled={isOffline} onClick={() => openSell(row)}>
                        Sell in Register
                      </Button>
                    )}
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
                    {linksLoaded && (
                      <div className={formStyles.field}>
                        <label className={formStyles.label} htmlFor="add-item-photo">
                          Item image (optional)
                        </label>
                        <input
                          id="add-item-photo"
                          key={addPhotoKey}
                          className={formStyles.fileInput}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          onChange={(e) => {
                            const photo = e.target.files?.[0] ?? null;
                            // The picture lives on the Register menu item (a stock item has no image of its own), so choosing one also turns on selling.
                            if (photo && !addSell) handleAddSellToggle(true, section.categoryName, addForm.outlet_id);
                            setAddSellForm((current) => ({ ...current, photo }));
                          }}
                          disabled={isOffline}
                        />
                        <p className={formStyles.hint}>Shown on the item&apos;s tile in the Register — choosing one also sells this item in the Register (set its price and category below).</p>
                      </div>
                    )}
                    {linksLoaded && (
                      <label className={formStyles.checkboxField}>
                        <input
                          className={formStyles.checkbox}
                          type="checkbox"
                          checked={addSell}
                          onChange={(e) => handleAddSellToggle(e.target.checked, section.categoryName, addForm.outlet_id)}
                          disabled={isOffline}
                        />
                        <span className={formStyles.label}>Also sell in Register</span>
                      </label>
                    )}
                    {addSell && (
                      <SellInRegisterFields
                        idPrefix="add-sell"
                        showPhoto={false}
                        values={{ ...addSellForm, name: addSellForm.name ?? addForm.name }}
                        // Keeps the Register name following the stock Name until the user types a different one.
                        onChange={(next) => setAddSellForm({ ...next, name: addSellForm.name === null && next.name === addForm.name ? null : next.name })}
                        menuCategories={menuCategories}
                        stockCategory={section.categoryName}
                        unit={addForm.unit}
                        duplicateName={outletMenuNames.includes((addSellForm.name ?? addForm.name).trim().toLowerCase()) && (addSellForm.name ?? addForm.name).trim() !== ''}
                        isOffline={isOffline}
                      />
                    )}
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
                  {editingRegisterState?.kind === 'direct' && (
                    <p className={formStyles.hint}>Sold in the Register as &quot;{editingRegisterState.menuItemName}&quot; — change its price or category under POS → Setup → Menu items.</p>
                  )}
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

              {sellingItem && (
                <Card title={`Sell in Register — ${sellingItem.name}`}>
                  {sellError && (
                    <p role="alert" className={formStyles.errorBanner}>
                      {sellError}
                    </p>
                  )}
                  <p className={formStyles.hint}>
                    Adds this item to the POS Register menu and links it to this stock item, so each sale is deducted from stock. It appears in the Register the next time the outlet is opened or its menu is refreshed.
                  </p>
                  {sellResume && <p className={formStyles.hint}>The Register item was already created — only its stock link is left to retry.</p>}
                  <form className={formStyles.row} onSubmit={handleSellSubmit}>
                    <SellInRegisterFields
                      idPrefix="sell"
                      values={sellForm}
                      onChange={setSellForm}
                      menuCategories={menuCategories}
                      stockCategory={sellingItem.category}
                      unit={sellingItem.unit}
                      onHand={sellingItem.current_quantity}
                      duplicateName={sellResume === null && sellForm.name.trim() !== '' && outletMenuNames.includes(sellForm.name.trim().toLowerCase())}
                      isOffline={isOffline || sellResume !== null}
                    />
                    <div className={formStyles.actionsRow}>
                      <Button type="submit" loading={sellSubmitting} disabled={isOffline}>
                        {sellResume ? 'Retry linking' : 'Sell in Register'}
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
        })()
      )}

      {archiving && (
        <ConfirmDialog
          title="Archive this stock item?"
          consequence={`This archives "${archiving.name}". It stops appearing in lists and pickers; its own past movement history is unaffected.${
            Array.isArray(links) && classifyStockItem(archiving.id, links).kind !== 'none'
              ? ` It is part of the recipe of ${classifyStockItem(archiving.id, links).menuItemCount} Register menu item(s) — check those afterwards.`
              : ''
          }`}
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
