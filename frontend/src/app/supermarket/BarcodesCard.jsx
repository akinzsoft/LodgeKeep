import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Button, ConfirmDialog } from '../../shared/components/index.js';
import { supermarketApi, ApiError } from '../../shared/api/index.js';
import { CameraScanDialog } from './CameraScanDialog.jsx';
import formStyles from '../pos/POSForm.module.css';
import styles from './Supermarket.module.css';

/** Groups the flat barcode rows by product, keeping the server's product-name order. */
function groupByProduct(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.menu_item_id);
    if (!groups.has(key)) groups.set(key, { id: key, name: row.item_name, onTill: row.on_till, archived: row.item_status !== 'active', barcodes: [] });
    groups.get(key).barcodes.push(row);
  }
  return [...groups.values()];
}

const matches = (group, query) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return String(group.name ?? '').toLowerCase().includes(q) || group.barcodes.some((row) => row.barcode.toLowerCase().includes(q));
};

/**
 * BarcodesCard — Supermarket → Setup: every barcode registered at the property
 * (unique property-wide, so a code on a restaurant item shows too), grouped by
 * product, with whether the product is on this outlet's till. A manager can
 * remove a barcode (after a confirm; the product, its sales and stock are
 * untouched) and add another barcode to a product that already has one —
 * typed, or read with the phone camera into the field (single-read mode, the
 * same as "Products needing setup"), then saved with Add.
 *
 * `refreshKey` reloads the list when barcodes change elsewhere on the tab;
 * `onChanged` tells the tab after an add or remove (a product that lost its
 * last barcode reappears under "Products needing setup").
 */
export function BarcodesCard({ outletId, isOffline = false, canUseCamera = false, scanDebug = false, refreshKey = 0, onChanged = () => {} }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(null); // the product id being saved
  const [removeTarget, setRemoveTarget] = useState(null);
  const [scanTarget, setScanTarget] = useState(null);
  const focusFieldFor = useRef(null);
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    const token = (loadToken.current += 1);
    try {
      const data = await supermarketApi.listBarcodes(outletId);
      if (token !== loadToken.current) return;
      setRows(data);
      setError(null);
    } catch (caught) {
      if (token !== loadToken.current) return;
      setRows((current) => current ?? []);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the barcodes.');
    }
  }, [outletId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on outlet change and on outside changes
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (scanTarget || focusFieldFor.current === null) return;
    document.getElementById(`barcode-add-${focusFieldFor.current}`)?.focus();
    focusFieldFor.current = null;
  }, [scanTarget]);

  async function handleAdd(event, group) {
    event.preventDefault();
    const code = (drafts[group.id] ?? '').trim();
    if (!code || busy) return;
    setBusy(group.id);
    try {
      await supermarketApi.addBarcode(group.id, code);
      setDrafts((current) => ({ ...current, [group.id]: '' }));
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not add that barcode.');
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    const target = removeTarget;
    setRemoveTarget(null);
    try {
      await supermarketApi.removeBarcode(target.id);
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove that barcode.');
    }
  }

  function fillFromCamera(code) {
    const group = scanTarget;
    if (!group) return;
    setDrafts((current) => ({ ...current, [group.id]: code }));
    focusFieldFor.current = group.id;
    setScanTarget(null);
  }

  const groups = rows ? groupByProduct(rows).filter((group) => matches(group, query)) : [];

  return (
    <Card title="Barcodes">
      <p className={styles.hint}>Every barcode registered at this property, by product. Remove a wrong one, or add another (for example a multipack).</p>
      {error && <p className={styles.errorBanner} role="alert">{error}</p>}
      <label className={styles.barcodeSearch}>
        <span className={formStyles.label}>Search barcodes or products</span>
        <input className={formStyles.input} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {rows === null && <p className={styles.hint}>Loading barcodes…</p>}
      {rows !== null && rows.length === 0 && !error && <p className={styles.hint}>No barcodes yet. Add them under “Products needing setup”, or with Products import.</p>}
      {rows !== null && rows.length > 0 && groups.length === 0 && <p className={styles.hint}>No barcode or product matches “{query.trim()}”.</p>}
      {groups.length > 0 && (
        <ul className={styles.setupList} aria-label="Barcodes by product">
          {groups.map((group) => (
            <li key={group.id} className={styles.setupRow}>
              <span className={styles.setupName}>{group.name}</span>
              <span className={styles.setupBadges}>
                {group.archived ? (
                  <span className={styles.badgeNeutral}>Archived product</span>
                ) : group.onTill === true ? (
                  <span className={styles.badgeSuccess}>On this till</span>
                ) : group.onTill === false ? (
                  <span className={styles.badgeNeutral}>Not on this till</span>
                ) : null}
              </span>
              <ul className={styles.barcodeChips} aria-label={`Barcodes for ${group.name}`}>
                {group.barcodes.map((row) => (
                  <li key={row.id} className={styles.barcodeChip}>
                    <span className={styles.barcodeCode}>{row.barcode}</span>
                    <button
                      type="button"
                      className={styles.chipRemove}
                      aria-label={`Remove barcode ${row.barcode} from ${group.name}`}
                      disabled={isOffline}
                      onClick={() => setRemoveTarget({ id: row.id, barcode: row.barcode, name: group.name })}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              {!group.archived && (
                <form className={styles.barcodeForm} onSubmit={(event) => handleAdd(event, group)}>
                  <input
                    id={`barcode-add-${group.id}`}
                    className={formStyles.input}
                    aria-label={`Another barcode for ${group.name}`}
                    placeholder="Another barcode"
                    value={drafts[group.id] ?? ''}
                    onChange={(event) => setDrafts((current) => ({ ...current, [group.id]: event.target.value }))}
                    disabled={isOffline}
                  />
                  {canUseCamera && (
                    <Button type="button" size="compact" variant="secondary" aria-label={`Scan another barcode for ${group.name}`} disabled={isOffline} onClick={() => setScanTarget(group)}>
                      <svg className={styles.cameraIcon} viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
                      Scan
                    </Button>
                  )}
                  <Button type="submit" size="compact" variant="secondary" disabled={isOffline || busy === group.id || !(drafts[group.id] ?? '').trim()}>Add</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {removeTarget && (
        <ConfirmDialog
          title={`Remove barcode ${removeTarget.barcode}?`}
          consequence={`Scanning ${removeTarget.barcode} will no longer find ${removeTarget.name}. The product, its sales and its stock are not changed.`}
          confirmLabel="Remove barcode"
          onConfirm={handleRemove}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
      {scanTarget && !isOffline && (
        <CameraScanDialog
          single
          title={`Scan another barcode for ${scanTarget.name}`}
          hint="The barcode fills the field. Check it, then tap Add."
          onDetected={fillFromCamera}
          onClose={() => setScanTarget(null)}
          debug={scanDebug}
        />
      )}
    </Card>
  );
}
