import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Button, ConfirmDialog } from '../../shared/components/index.js';
import { supermarketApi, posApi, ApiError } from '../../shared/api/index.js';
import formStyles from '../pos/POSForm.module.css';
import styles from './Supermarket.module.css';

// Money stays an exact decimal string; a type="number" input would report '' for text it cannot parse.
const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

const matches = (row, query, category) => {
  if (category && row.category !== category) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return String(row.name ?? '').toLowerCase().includes(q) || row.barcodes.some((code) => code.toLowerCase().includes(q));
};

/**
 * ProductsCard — Supermarket → Setup (supermarket.manage): the mart's products
 * with an inline price edit, an Edit dialog (name, category, cost price) and
 * Archive / Restore. A change never touches a past sale (receipts keep the
 * price they sold at). A product whose category a hotel outlet also sells is
 * locked here ("Also sold at <outlet>"): the shared row would change that
 * menu, and the server refuses it.
 *
 * `refreshKey` reloads the list when the tab changes products elsewhere;
 * `onChanged` tells the tab after any change (the till menu and the setup
 * flags depend on it).
 */
export function ProductsCard({ outletId, isOffline = false, refreshKey = 0, onChanged = () => {} }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [categories, setCategories] = useState([]);
  const [priceDrafts, setPriceDrafts] = useState({});
  const [busy, setBusy] = useState(null); // the product id being saved
  const [editTarget, setEditTarget] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: '', category: '', cost: '' });
  const [editError, setEditError] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    const token = (loadToken.current += 1);
    try {
      const data = await supermarketApi.listProducts(outletId, { includeArchived: showArchived });
      if (token !== loadToken.current) return;
      setRows(data);
      setError(null);
    } catch (caught) {
      if (token !== loadToken.current) return;
      setRows((current) => current ?? []);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the products.');
    }
  }, [outletId, showArchived]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on outlet / filter change and on outside changes
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    // The categories this outlet carries (the only ones a product can move to); a failure just leaves the list empty.
    let current = true;
    posApi
      .listMenuCategories({ outletId })
      .then((list) => {
        if (current) setCategories((list ?? []).filter((row) => row.status === 'active').map((row) => row.name));
      })
      .catch(() => {
        if (current) setCategories([]);
      });
    return () => {
      current = false;
    };
  }, [outletId, refreshKey]);

  function applyChange(updated) {
    setRows((current) => (current ?? []).map((row) => (row.id === updated.id ? updated : row)).filter((row) => showArchived || row.status === 'active'));
    onChanged();
  }

  async function savePrice(row) {
    const draft = (priceDrafts[row.id] ?? row.price).trim();
    if (busy || draft === row.price) return;
    if (!MONEY_PATTERN.test(draft)) {
      setError(`The price for ${row.name} must be an amount with at most 2 decimal places.`);
      return;
    }
    setBusy(row.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await supermarketApi.updateProduct(row.id, outletId, { price: draft });
      setPriceDrafts((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      applyChange(updated);
      setNotice(`${updated.name} now sells at ${updated.price}. Past sales keep the price they sold at.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change that price.');
    } finally {
      setBusy(null);
    }
  }

  function openEdit(row) {
    setEditTarget(row);
    setEditDraft({ name: row.name, category: row.category, cost: row.stock_cost ?? row.cost_price ?? '' });
    setEditError(null);
  }

  const editCost = editDraft.cost.trim();
  const editInvalid = !editDraft.name.trim() || (editCost !== '' && !MONEY_PATTERN.test(editCost));

  async function saveEdit() {
    const target = editTarget;
    const changes = {};
    if (editDraft.name.trim() !== target.name) changes.name = editDraft.name.trim();
    if (editDraft.category !== target.category) changes.category = editDraft.category;
    const originalCost = target.stock_cost ?? target.cost_price ?? '';
    if (editCost !== originalCost) changes.cost_price = editCost === '' ? null : editCost;
    if (Object.keys(changes).length === 0) {
      setEditTarget(null);
      return;
    }
    setBusy(target.id);
    setEditError(null);
    try {
      const updated = await supermarketApi.updateProduct(target.id, outletId, changes);
      setEditTarget(null);
      applyChange(updated);
      setNotice(`${updated.name} was updated.`);
    } catch (caught) {
      // The dialog stays open with the server's reason (a hotel-shared product, a duplicate name…).
      setEditError(caught instanceof ApiError ? caught.message : 'Could not save the changes.');
    } finally {
      setBusy(null);
    }
  }

  async function confirmArchive(reason) {
    const target = archiveTarget;
    setArchiveTarget(null);
    setBusy(target.row.id);
    setError(null);
    setNotice(null);
    try {
      const call = target.archive ? supermarketApi.archiveProduct : supermarketApi.restoreProduct;
      const updated = await call(target.row.id, outletId, reason);
      applyChange(updated);
      setNotice(target.archive ? `${updated.name} is archived and no longer on the till.` : `${updated.name} is back on the till.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : `Could not ${target.archive ? 'archive' : 'restore'} that product.`);
    } finally {
      setBusy(null);
    }
  }

  const categoryOptions = [...new Set([...categories, ...(rows ?? []).map((row) => row.category)])].sort((a, b) => a.localeCompare(b));
  const visible = (rows ?? []).filter((row) => matches(row, query, category));

  return (
    <Card title="Products">
      <p className={styles.hint}>Change a product&apos;s price, name, category or cost, or archive it. Past sales keep the price they sold at; archived products leave the till but stay in sales history.</p>
      {error && <p className={styles.errorBanner} role="alert">{error}</p>}
      {notice && <p className={styles.hint} role="status">{notice}</p>}
      <div className={styles.productFilters}>
        <label className={styles.barcodeSearch}>
          <span className={formStyles.label}>Search products or barcodes</span>
          <input className={formStyles.input} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className={styles.barcodeSearch}>
          <span className={formStyles.label}>Category</span>
          <select className={formStyles.input} value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>
            {categoryOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        <label className={formStyles.checkboxField}>
          <input className={formStyles.checkbox} type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          <span>Show archived</span>
        </label>
      </div>
      {rows === null && <p className={styles.hint}>Loading products…</p>}
      {rows !== null && rows.length === 0 && !error && <p className={styles.hint}>{showArchived ? 'No products yet.' : 'No active products. Use Products import to add some.'}</p>}
      {rows !== null && rows.length > 0 && visible.length === 0 && <p className={styles.hint}>No product matches that search.</p>}
      {visible.length > 0 && (
        <ul className={styles.setupList} aria-label="Products">
          {visible.map((row) => {
            const locked = row.shared_with.length > 0;
            const archived = row.status !== 'active';
            const draft = priceDrafts[row.id] ?? row.price;
            return (
              <li key={row.id} className={styles.productRow}>
                <span className={styles.setupName}>{row.name}</span>
                <span className={styles.setupBadges}>
                  {archived && <span className={styles.badgeNeutral}>Archived</span>}
                  {locked && <span className={styles.badgeWarning}>Also sold at {row.shared_with.join(', ')}</span>}
                </span>
                <span className={styles.productMeta}>
                  {row.category}
                  {row.units_on_hand !== null && ` · ${row.units_on_hand} in stock`}
                </span>
                <span className={styles.productPrice}>
                  <input
                    className={`${formStyles.input} ${styles.productPriceInput}`}
                    type="text"
                    inputMode="decimal"
                    aria-label={`Price for ${row.name}`}
                    value={draft}
                    disabled={isOffline || locked || busy === row.id}
                    onChange={(event) => setPriceDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') savePrice(row);
                    }}
                  />
                  <Button size="compact" variant="secondary" aria-label={`Save price for ${row.name}`} disabled={isOffline || locked || busy === row.id || draft.trim() === row.price} onClick={() => savePrice(row)}>
                    Save price
                  </Button>
                  <Button size="compact" variant="secondary" aria-label={`Edit ${row.name}`} disabled={isOffline || locked || busy === row.id} onClick={() => openEdit(row)}>
                    Edit
                  </Button>
                  <Button
                    size="compact"
                    variant="secondary"
                    aria-label={`${archived ? 'Restore' : 'Archive'} ${row.name}`}
                    disabled={isOffline || locked || busy === row.id}
                    onClick={() => setArchiveTarget({ row, archive: !archived })}
                  >
                    {archived ? 'Restore' : 'Archive'}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {editTarget && (
        <ConfirmDialog
          title={`Edit ${editTarget.name}`}
          consequence="Past sales keep their name and price. A new name or category is also applied to the product's stock item."
          confirmLabel="Save changes"
          confirmDisabled={isOffline || editInvalid || busy === editTarget.id}
          onConfirm={saveEdit}
          onCancel={() => setEditTarget(null)}
        >
          <div className={styles.editFields}>
            {editError && <p className={styles.errorBanner} role="alert">{editError}</p>}
            <label className={styles.editField}>
              <span className={formStyles.label}>Name</span>
              <input className={formStyles.input} value={editDraft.name} onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className={styles.editField}>
              <span className={formStyles.label}>Category</span>
              <select className={formStyles.input} value={editDraft.category} onChange={(event) => setEditDraft((current) => ({ ...current, category: event.target.value }))}>
                {[...new Set([editTarget.category, ...categories])].map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <div className={styles.editField}>
              <label htmlFor="product-edit-cost" className={formStyles.label}>Cost price</label>
              <input id="product-edit-cost" className={formStyles.input} type="text" inputMode="decimal" aria-describedby="product-edit-cost-hint" value={editDraft.cost} onChange={(event) => setEditDraft((current) => ({ ...current, cost: event.target.value }))} />
              <span id="product-edit-cost-hint" className={styles.productMeta}>Profit reports use the current cost, so past profit figures change; receipts and revenue do not.</span>
            </div>
          </div>
        </ConfirmDialog>
      )}
      {archiveTarget && (
        <ConfirmDialog
          title={`${archiveTarget.archive ? 'Archive' : 'Restore'} ${archiveTarget.row.name}?`}
          consequence={
            archiveTarget.archive
              ? 'It leaves the till and cannot be scanned or searched. Its sales history, barcodes and stock stay.'
              : 'It returns to the till and can be scanned and sold again.'
          }
          confirmLabel={archiveTarget.archive ? 'Archive product' : 'Restore product'}
          onConfirm={confirmArchive}
          onCancel={() => setArchiveTarget(null)}
        />
      )}
    </Card>
  );
}
