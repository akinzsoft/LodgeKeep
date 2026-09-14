import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';
import { MenuCategoriesCard } from './MenuCategoriesCard.jsx';

/**
 * SetupTab — PLAN.md Phase 4's POS core: outlets, terminals, menu items.
 * One tab for all three, the same "closely-related simple reference-data
 * lists share one tab" reasoning `ReferenceDataTab`'s own header already
 * used for market segments/booking sources/cancellation policies.
 *
 * Gated on `pos.manage` at the API layer, not here — this tab is always
 * reachable once the POS nav item itself is visible (`pos.operate`), the
 * same "UI-level RBAC is convenience only" rule this codebase's own
 * CLAUDE.md states; a pos_operator submitting a create/edit here gets a
 * real 403 from the backend, same as every other under-permissioned
 * action in this app.
 *
 * Bug fix (see `POSScreen`'s own header): the menu-item price column used
 * to hardcode `currencyCode="NGN"` — `pos_menu_items` carries no currency
 * column of its own, so the real source of truth is the active property's
 * `base_currency`, now threaded in as a prop.
 *
 * Gap closure (found in this session's own broader "REVIEW and test POS"
 * pass): the real backend has always had `PATCH /pos/outlets/:id`,
 * `/terminals/:id`, `/menu-items/:id` — this tab had create-and-archive
 * only, no way to fix a typo'd name, retype a terminal's device ref, or
 * correct a menu item's price/category once created. Building this
 * surfaced (and fixed, in `backend/src/modules/pos/controller.js`) a real,
 * previously-uncalled bug in all three endpoints: each took `req.body`
 * straight through with no field allowlist. The three edit forms below
 * mirror `StockItemsTab.jsx`'s own edit pattern (`editingId`/`editForm`/
 * `editError`/`editSubmitting`), and each edit is scoped to exactly its
 * own sibling `create*` form's fields — `status` stays reachable only
 * through Archive, matching `RoomTypesTab.jsx`'s own precedent.
 */
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** A client-side pre-check so an oversized or wrong-type file fails fast; the server checks the real bytes regardless. */
function photoProblem(file) {
  if (!file) return null;
  if (!PHOTO_TYPES.includes(file.type)) return 'The photo must be a JPG, PNG, or WebP image.';
  if (file.size > MAX_PHOTO_BYTES) return 'The photo must be 2 MB or smaller.';
  return null;
}

export function SetupTab({ activeProperty }) {
  const [outlets, setOutlets] = useState(null);
  const [terminals, setTerminals] = useState(null);
  const [menuItems, setMenuItems] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState(null);

  const [outletForm, setOutletForm] = useState({ code: '', name: '', type: 'bar' });
  const [outletSubmitting, setOutletSubmitting] = useState(false);
  const [outletError, setOutletError] = useState(null);
  const [editingOutletId, setEditingOutletId] = useState(null);
  const [outletEditForm, setOutletEditForm] = useState({ code: '', name: '', type: 'bar' });
  const [outletEditSubmitting, setOutletEditSubmitting] = useState(false);
  const [outletEditError, setOutletEditError] = useState(null);

  const [terminalForm, setTerminalForm] = useState({ device_ref: '', supports_contactless: false });
  const [terminalSubmitting, setTerminalSubmitting] = useState(false);
  const [terminalError, setTerminalError] = useState(null);
  const [editingTerminalId, setEditingTerminalId] = useState(null);
  const [terminalEditForm, setTerminalEditForm] = useState({ device_ref: '', supports_contactless: false });
  const [terminalEditSubmitting, setTerminalEditSubmitting] = useState(false);
  const [terminalEditError, setTerminalEditError] = useState(null);

  const [menuForm, setMenuForm] = useState({ name: '', category: '', price: '', costPrice: '' });
  const [menuSubmitting, setMenuSubmitting] = useState(false);
  const [menuError, setMenuError] = useState(null);
  const [editingMenuItemId, setEditingMenuItemId] = useState(null);
  const [menuEditForm, setMenuEditForm] = useState({ name: '', category: '', price: '', cost_price: '' });
  const [menuEditSubmitting, setMenuEditSubmitting] = useState(false);
  const [menuEditError, setMenuEditError] = useState(null);
  // Photo files chosen in the add / edit forms, uploaded after the item saves.
  const [menuPhoto, setMenuPhoto] = useState(null);
  const [menuEditPhoto, setMenuEditPhoto] = useState(null);
  const [menuEditImageUrl, setMenuEditImageUrl] = useState(null);
  const [photoInputKey, setPhotoInputKey] = useState(0);
  // Registered menu categories (shared by every outlet) feeding the category dropdowns.
  const [categories, setCategories] = useState(null);

  async function reload() {
    try {
      setOutlets(await posApi.listOutlets());
    } catch (caught) {
      setOutlets([]);
      setOutletError(caught instanceof ApiError ? caught.message : 'Could not load outlets.');
    }
  }

  async function reloadCategories() {
    try {
      setCategories(await posApi.listMenuCategories());
    } catch {
      setCategories([]);
    }
  }

  /** A category renamed or archived changes the menu items shown, so refresh both. */
  async function handleCategoriesChanged() {
    await reloadCategories();
    if (selectedOutletId) await reloadOutletDetail(selectedOutletId);
  }

  /**
   * Options for a category dropdown. A menu item already in a category that
   * is no longer active keeps that value selectable, so opening its edit form
   * never silently changes it.
   */
  function categoryOptions(current) {
    const names = (categories ?? []).map((category) => category.name);
    if (current && !names.includes(current)) names.push(current);
    return names;
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
    posApi
      .listMenuCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  async function reloadOutletDetail(outletId) {
    try {
      const [terminalList, menuList] = await Promise.all([posApi.listTerminals(outletId), posApi.listMenuItems(outletId)]);
      setTerminals(terminalList);
      setMenuItems(menuList);
    } catch (caught) {
      setTerminals([]);
      setMenuItems([]);
      const message = caught instanceof ApiError ? caught.message : 'Could not load this outlet.';
      setTerminalError(message);
      setMenuError(message);
    }
  }

  function handleSelectOutlet(outlet) {
    setSelectedOutletId(outlet.id);
    setTerminals(null);
    setMenuItems(null);
    setEditingTerminalId(null);
    setEditingMenuItemId(null);
    reloadOutletDetail(outlet.id);
  }

  async function handleCreateOutlet(event) {
    event.preventDefault();
    setOutletSubmitting(true);
    setOutletError(null);
    try {
      await posApi.createOutlet(outletForm);
      setOutletForm({ code: '', name: '', type: 'bar' });
      await reload();
    } catch (caught) {
      setOutletError(caught instanceof ApiError ? caught.message : 'Could not create this outlet.');
    } finally {
      setOutletSubmitting(false);
    }
  }

  async function handleArchiveOutlet(outlet) {
    try {
      await posApi.archiveOutlet(outlet.id);
      if (selectedOutletId === outlet.id) setSelectedOutletId(null);
      await reload();
    } catch (caught) {
      setOutletError(caught instanceof ApiError ? caught.message : 'Could not archive this outlet.');
    }
  }

  function startEditOutlet(outlet) {
    setEditingOutletId(outlet.id);
    setOutletEditError(null);
    setOutletEditForm({ code: outlet.code, name: outlet.name, type: outlet.type });
  }

  async function handleEditOutlet(event) {
    event.preventDefault();
    setOutletEditSubmitting(true);
    setOutletEditError(null);
    try {
      await posApi.updateOutlet(editingOutletId, outletEditForm);
      setEditingOutletId(null);
      await reload();
    } catch (caught) {
      setOutletEditError(caught instanceof ApiError ? caught.message : 'Could not update this outlet.');
    } finally {
      setOutletEditSubmitting(false);
    }
  }

  async function handleCreateTerminal(event) {
    event.preventDefault();
    setTerminalSubmitting(true);
    setTerminalError(null);
    try {
      await posApi.createTerminal({ outletId: selectedOutletId, deviceRef: terminalForm.device_ref, supportsContactless: terminalForm.supports_contactless });
      setTerminalForm({ device_ref: '', supports_contactless: false });
      await reloadOutletDetail(selectedOutletId);
    } catch (caught) {
      setTerminalError(caught instanceof ApiError ? caught.message : 'Could not create this terminal.');
    } finally {
      setTerminalSubmitting(false);
    }
  }

  function startEditTerminal(terminal) {
    setEditingTerminalId(terminal.id);
    setTerminalEditError(null);
    setTerminalEditForm({ device_ref: terminal.device_ref, supports_contactless: !!terminal.supports_contactless });
  }

  async function handleEditTerminal(event) {
    event.preventDefault();
    setTerminalEditSubmitting(true);
    setTerminalEditError(null);
    try {
      await posApi.updateTerminal(editingTerminalId, terminalEditForm);
      setEditingTerminalId(null);
      await reloadOutletDetail(selectedOutletId);
    } catch (caught) {
      setTerminalEditError(caught instanceof ApiError ? caught.message : 'Could not update this terminal.');
    } finally {
      setTerminalEditSubmitting(false);
    }
  }

  async function handleCreateMenuItem(event) {
    event.preventDefault();
    setMenuSubmitting(true);
    setMenuError(null);
    const problem = photoProblem(menuPhoto);
    if (problem) {
      setMenuError(problem);
      setMenuSubmitting(false);
      return;
    }
    let created = null;
    try {
      created = await posApi.createMenuItem({ outletId: selectedOutletId, ...menuForm });
      // The item exists now — clear the form straight away, so a retry after
      // a failed photo upload can never add the same item a second time.
      setMenuForm({ name: '', category: '', price: '', costPrice: '' });
      setMenuPhoto(null);
      setPhotoInputKey((key) => key + 1);
      if (menuPhoto) await posApi.uploadMenuItemImage(created.id, menuPhoto);
      await reloadOutletDetail(selectedOutletId);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Could not create this item.';
      // The item itself saved; only the photo failed — say so, and show the new item.
      setMenuError(created ? `The item was added, but its photo was not: ${message} Use Edit to add the photo.` : message);
      if (created) await reloadOutletDetail(selectedOutletId);
    } finally {
      setMenuSubmitting(false);
    }
  }

  function startEditMenuItem(item) {
    setEditingMenuItemId(item.id);
    setMenuEditError(null);
    setMenuEditForm({ name: item.name, category: item.category, price: item.price, cost_price: item.cost_price ?? '' });
    setMenuEditPhoto(null);
    setMenuEditImageUrl(item.image_url ?? null);
  }

  async function handleEditMenuItem(event) {
    event.preventDefault();
    setMenuEditSubmitting(true);
    setMenuEditError(null);
    const problem = photoProblem(menuEditPhoto);
    if (problem) {
      setMenuEditError(problem);
      setMenuEditSubmitting(false);
      return;
    }
    let saved = false;
    try {
      await posApi.updateMenuItem(editingMenuItemId, menuEditForm);
      saved = true;
      if (menuEditPhoto) await posApi.uploadMenuItemImage(editingMenuItemId, menuEditPhoto);
      setEditingMenuItemId(null);
      await reloadOutletDetail(selectedOutletId);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Could not update this item.';
      // The changes saved; only the photo failed — say so, and refresh the list to show them.
      setMenuEditError(saved ? `Your changes were saved, but the photo was not: ${message}` : message);
      if (saved) await reloadOutletDetail(selectedOutletId);
    } finally {
      setMenuEditSubmitting(false);
    }
  }

  async function handleRemovePhoto() {
    setMenuEditError(null);
    try {
      await posApi.removeMenuItemImage(editingMenuItemId);
      setMenuEditImageUrl(null);
      await reloadOutletDetail(selectedOutletId);
    } catch (caught) {
      setMenuEditError(caught instanceof ApiError ? caught.message : 'Could not remove this photo.');
    }
  }

  async function handleToggleAvailability(item) {
    try {
      await posApi.setMenuItemAvailability(item.id, !item.is_available);
      await reloadOutletDetail(selectedOutletId);
    } catch (caught) {
      setMenuError(caught instanceof ApiError ? caught.message : 'Could not update availability.');
    }
  }

  const selectedOutlet = outlets?.find((o) => o.id === selectedOutletId);

  return (
    <div className={formStyles.form}>
      <Card title="New outlet">
        {outletError && (
          <p role="alert" className={formStyles.errorBanner}>
            {outletError}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreateOutlet}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input className={formStyles.input} value={outletForm.code} onChange={(e) => setOutletForm({ ...outletForm, code: e.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input className={formStyles.input} value={outletForm.name} onChange={(e) => setOutletForm({ ...outletForm, name: e.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Type</span>
              <select className={formStyles.select} value={outletForm.type} onChange={(e) => setOutletForm({ ...outletForm, type: e.target.value })}>
                <option value="bar">Bar</option>
                <option value="restaurant">Restaurant</option>
                <option value="room_service">Room service</option>
                <option value="spa">Spa</option>
                <option value="poolside">Poolside</option>
              </select>
            </label>
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={outletSubmitting}>
              Add outlet
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        title="Outlets"
        state={outlets === null ? 'loading' : outlets.length === 0 ? 'empty' : 'success'}
        emptyMessage="No outlets yet — add one above."
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'type', label: 'Type' },
        ]}
        rows={outlets ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <>
            <Button size="compact" variant="ghost" onClick={() => handleSelectOutlet(row)}>
              Manage
            </Button>
            <Button size="compact" variant="ghost" onClick={() => startEditOutlet(row)}>
              Edit
            </Button>
            <Button size="compact" variant="danger" onClick={() => handleArchiveOutlet(row)}>
              Archive
            </Button>
          </>
        )}
      />

      {editingOutletId !== null && (
        <Card title="Edit outlet">
          {outletEditError && (
            <p role="alert" className={formStyles.errorBanner}>
              {outletEditError}
            </p>
          )}
          <form className={formStyles.row} onSubmit={handleEditOutlet}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input className={formStyles.input} value={outletEditForm.code} onChange={(e) => setOutletEditForm({ ...outletEditForm, code: e.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input className={formStyles.input} value={outletEditForm.name} onChange={(e) => setOutletEditForm({ ...outletEditForm, name: e.target.value })} required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Type</span>
              <select className={formStyles.select} value={outletEditForm.type} onChange={(e) => setOutletEditForm({ ...outletEditForm, type: e.target.value })}>
                <option value="bar">Bar</option>
                <option value="restaurant">Restaurant</option>
                <option value="room_service">Room service</option>
                <option value="spa">Spa</option>
                <option value="poolside">Poolside</option>
              </select>
            </label>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={outletEditSubmitting}>
                Save changes
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditingOutletId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      <MenuCategoriesCard categories={categories} onChanged={handleCategoriesChanged} />

      {selectedOutlet && (
        <>
          <Card title={`Terminals — ${selectedOutlet.name}`}>
            {terminalError && (
              <p role="alert" className={formStyles.errorBanner}>
                {terminalError}
              </p>
            )}
            <form className={formStyles.row} onSubmit={handleCreateTerminal}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Device ref</span>
                <input
                  className={formStyles.input}
                  value={terminalForm.device_ref}
                  onChange={(e) => setTerminalForm({ ...terminalForm, device_ref: e.target.value })}
                  required
                />
              </label>
              <label className={formStyles.checkboxField}>
                <input
                  className={formStyles.checkbox}
                  type="checkbox"
                  checked={terminalForm.supports_contactless}
                  onChange={(e) => setTerminalForm({ ...terminalForm, supports_contactless: e.target.checked })}
                />
                <span className={formStyles.label}>Supports contactless</span>
              </label>
              <div className={formStyles.actionsRow}>
                <Button type="submit" loading={terminalSubmitting}>
                  Add terminal
                </Button>
              </div>
            </form>
            <DataTable
              state={terminals === null ? 'loading' : terminals.length === 0 ? 'empty' : 'success'}
              emptyMessage="No terminals yet."
              columns={[
                { key: 'device_ref', label: 'Device ref' },
                { key: 'supports_contactless', label: 'Contactless', render: (row) => (row.supports_contactless ? 'Yes' : 'No') },
              ]}
              rows={terminals ?? []}
              rowKey={(row) => row.id}
              actions={(row) => (
                <>
                  <Button size="compact" variant="ghost" onClick={() => startEditTerminal(row)}>
                    Edit
                  </Button>
                  <Button size="compact" variant="danger" onClick={() => posApi.archiveTerminal(row.id).then(() => reloadOutletDetail(selectedOutletId))}>
                    Archive
                  </Button>
                </>
              )}
            />

          </Card>

          {editingTerminalId !== null && (
            <Card title="Edit terminal">
              {terminalEditError && (
                <p role="alert" className={formStyles.errorBanner}>
                  {terminalEditError}
                </p>
              )}
              <form className={formStyles.row} onSubmit={handleEditTerminal}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Device ref</span>
                  <input
                    className={formStyles.input}
                    value={terminalEditForm.device_ref}
                    onChange={(e) => setTerminalEditForm({ ...terminalEditForm, device_ref: e.target.value })}
                    required
                  />
                </label>
                <label className={formStyles.checkboxField}>
                  <input
                    className={formStyles.checkbox}
                    type="checkbox"
                    checked={terminalEditForm.supports_contactless}
                    onChange={(e) => setTerminalEditForm({ ...terminalEditForm, supports_contactless: e.target.checked })}
                  />
                  <span className={formStyles.label}>Supports contactless</span>
                </label>
                <div className={formStyles.actionsRow}>
                  <Button type="submit" loading={terminalEditSubmitting}>
                    Save changes
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setEditingTerminalId(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}

          <Card title={`Menu — ${selectedOutlet.name}`}>
            {menuError && (
              <p role="alert" className={formStyles.errorBanner}>
                {menuError}
              </p>
            )}
            {categories !== null && categories.length === 0 && (
              <p className={formStyles.hint}>Add a category in Menu categories above before adding menu items.</p>
            )}
            <form className={formStyles.row} onSubmit={handleCreateMenuItem}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Name</span>
                <input className={formStyles.input} value={menuForm.name} onChange={(e) => setMenuForm({ ...menuForm, name: e.target.value })} required />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Category</span>
                <select className={formStyles.select} value={menuForm.category} onChange={(e) => setMenuForm({ ...menuForm, category: e.target.value })} required>
                  <option value="">Choose a category</option>
                  {categoryOptions('').map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Selling price</span>
                <input
                  className={formStyles.input}
                  type="number"
                  step="0.01"
                  min="0"
                  value={menuForm.price}
                  onChange={(e) => setMenuForm({ ...menuForm, price: e.target.value })}
                  required
                />
              </label>
              <div className={formStyles.field}>
                {/* Explicit id/htmlFor, help text OUTSIDE the label — a
                    wrapping <label> computes its accessible name from ALL
                    its text content, so a help paragraph nested inside one
                    (as this field originally had it) silently became part
                    of the field's own spoken name and broke an exact-match
                    getByLabelText query the same way (the door-access
                    SettingsTab gap-closure pass found and fixed the
                    identical bug once already). */}
                <label className={formStyles.label} htmlFor="menu-item-cost-price">
                  Cost price (optional)
                </label>
                <input
                  id="menu-item-cost-price"
                  className={formStyles.input}
                  type="number"
                  step="0.01"
                  min="0"
                  value={menuForm.costPrice}
                  onChange={(e) => setMenuForm({ ...menuForm, costPrice: e.target.value })}
                />
                <p className={formStyles.hint}>
                  Only used for margin reporting when this item has no recipe/BOM (see Stock). A recipe&apos;s own cost always wins.
                </p>
              </div>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Photo (optional)</span>
                <input
                  key={photoInputKey}
                  className={formStyles.fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => setMenuPhoto(e.target.files?.[0] ?? null)}
                />
              </label>
              <div className={formStyles.actionsRow}>
                <Button type="submit" loading={menuSubmitting}>
                  Add item
                </Button>
              </div>
            </form>
            <DataTable
              state={menuItems === null ? 'loading' : menuItems.length === 0 ? 'empty' : 'success'}
              emptyMessage="No menu items yet."
              columns={[
                {
                  key: 'image_url',
                  label: 'Photo',
                  render: (row) => (row.image_url ? <img className={formStyles.thumb} src={row.image_url} alt={`Photo of ${row.name}`} loading="lazy" /> : '—'),
                },
                { key: 'name', label: 'Name' },
                { key: 'category', label: 'Category' },
                { key: 'price', label: 'Price', align: 'right', render: (row) => <Money amount={row.price} currencyCode={activeProperty.base_currency} /> },
                {
                  key: 'cost_price',
                  label: 'Cost',
                  align: 'right',
                  render: (row) => (row.cost_price != null ? <Money amount={row.cost_price} currencyCode={activeProperty.base_currency} /> : '—'),
                },
                { key: 'is_available', label: 'Available', render: (row) => (row.is_available ? 'Yes' : 'Stocked out') },
              ]}
              rows={menuItems ?? []}
              rowKey={(row) => row.id}
              actions={(row) => (
                <>
                  <Button size="compact" variant="ghost" onClick={() => startEditMenuItem(row)}>
                    Edit
                  </Button>
                  <Button size="compact" variant="ghost" onClick={() => handleToggleAvailability(row)}>
                    {row.is_available ? 'Mark stocked out' : 'Mark available'}
                  </Button>
                </>
              )}
            />

          </Card>

          {editingMenuItemId !== null && (
            <Card title="Edit menu item">
              {menuEditError && (
                <p role="alert" className={formStyles.errorBanner}>
                  {menuEditError}
                </p>
              )}
              <form className={formStyles.row} onSubmit={handleEditMenuItem}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Name</span>
                  <input className={formStyles.input} value={menuEditForm.name} onChange={(e) => setMenuEditForm({ ...menuEditForm, name: e.target.value })} required />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Category</span>
                  <select className={formStyles.select} value={menuEditForm.category} onChange={(e) => setMenuEditForm({ ...menuEditForm, category: e.target.value })} required>
                    {categoryOptions(menuEditForm.category).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Selling price</span>
                  <input
                    className={formStyles.input}
                    type="number"
                    step="0.01"
                    min="0"
                    value={menuEditForm.price}
                    onChange={(e) => setMenuEditForm({ ...menuEditForm, price: e.target.value })}
                    required
                  />
                </label>
                <div className={formStyles.field}>
                  <label className={formStyles.label} htmlFor="menu-item-edit-cost-price">
                    Cost price (optional)
                  </label>
                  <input
                    id="menu-item-edit-cost-price"
                    className={formStyles.input}
                    type="number"
                    step="0.01"
                    min="0"
                    value={menuEditForm.cost_price}
                    onChange={(e) => setMenuEditForm({ ...menuEditForm, cost_price: e.target.value })}
                  />
                  <p className={formStyles.hint}>
                    Only used for margin reporting when this item has no recipe/BOM (see Stock). A recipe&apos;s own cost always wins.
                  </p>
                </div>
                <div className={formStyles.field}>
                  <span className={formStyles.label}>Photo</span>
                  {menuEditImageUrl ? (
                    <img className={formStyles.photoPreview} src={menuEditImageUrl} alt={`Current photo of ${menuEditForm.name}`} />
                  ) : (
                    <span className={formStyles.hint}>No photo yet.</span>
                  )}
                  <input
                    key={editingMenuItemId}
                    className={formStyles.fileInput}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label={menuEditImageUrl ? 'Replace photo' : 'Add photo'}
                    onChange={(e) => setMenuEditPhoto(e.target.files?.[0] ?? null)}
                  />
                  {menuEditImageUrl && (
                    <Button type="button" size="compact" variant="ghost" onClick={handleRemovePhoto}>
                      Remove photo
                    </Button>
                  )}
                </div>
                <div className={formStyles.actionsRow}>
                  <Button type="submit" loading={menuEditSubmitting}>
                    Save changes
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setEditingMenuItemId(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
