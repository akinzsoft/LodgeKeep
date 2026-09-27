import { useEffect, useRef, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { formatQuantity, compareQuantity } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import { StockItemOptions } from './stockItemOptions.jsx';
import { isStoreOutlet } from './outletTypes.js';
import formStyles from './POSForm.module.css';

/**
 * StockTransferTab — issue stock from one outlet to another (typically the
 * store to a bar) in one action. The server writes both ledger legs together
 * and refuses to take the source below zero; the warning here is only a
 * faster way of saying the same thing. Stock arrives at the destination the
 * moment it is issued — there is no confirm-on-receipt step and no
 * request/approve trail in this version.
 *
 * `pos.stock_transfer` (Storekeeper, Manager, Admin, Super admin). Every
 * outlet, stores included, can be a source or a destination.
 */
export function StockTransferTab({ isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [fromOutletId, setFromOutletId] = useState('');
  const [toOutletId, setToOutletId] = useState('');
  const [stockItems, setStockItems] = useState(null);
  const [stockItemId, setStockItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(null);
  const itemsRequest = useRef(0);
  const historyRequest = useRef(0);

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch((caught) => {
        setOutlets([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load outlets.');
      });
  }, []);

  // Only the newest request may write: switching "From" quickly must never
  // leave an older, slower response showing another outlet's transfers.
  async function loadHistory(outletId) {
    const requestId = (historyRequest.current += 1);
    let rows;
    try {
      rows = await stockApi.listTransfers({ outletId: outletId || undefined, limit: 20 });
    } catch {
      rows = [];
    }
    if (requestId === historyRequest.current) setHistory(rows);
  }

  useEffect(() => {
    const requestId = (historyRequest.current += 1);
    stockApi
      .listTransfers({ limit: 20 })
      .catch(() => [])
      .then((rows) => {
        if (requestId === historyRequest.current) setHistory(rows);
      });
  }, []);

  async function loadSourceItems(outletId) {
    const requestId = (itemsRequest.current += 1);
    setStockItems(null);
    try {
      const rows = await stockApi.listStockItems({ outletId });
      if (requestId === itemsRequest.current) setStockItems(rows);
    } catch (caught) {
      if (requestId !== itemsRequest.current) return;
      setStockItems([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load stock items for this outlet.');
    }
  }

  function handleSelectFrom(outletId) {
    setFromOutletId(outletId);
    setStockItemId('');
    setResult(null);
    setError(null);
    if (outletId === toOutletId) setToOutletId('');
    loadSourceItems(outletId);
    loadHistory(outletId);
  }

  const selectedItem = (stockItems ?? []).find((item) => String(item.id) === String(stockItemId));
  const onHand = selectedItem?.current_quantity ?? null;
  const quantityValid = /^\d+(\.\d{1,3})?$/.test(quantity.trim()) && compareQuantity(quantity.trim(), '0') > 0;
  const exceeds = quantityValid && onHand !== null && compareQuantity(quantity.trim(), onHand) > 0;
  const fromOutlet = (outlets ?? []).find((outlet) => String(outlet.id) === String(fromOutletId));
  const canSubmit = !isOffline && !submitting && fromOutletId && toOutletId && fromOutletId !== toOutletId && stockItemId && quantityValid && !exceeds;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const transfer = await stockApi.transferStock({ stockItemId, fromOutletId, toOutletId, quantity: quantity.trim(), note: note.trim() });
      setResult(transfer);
      setQuantity('');
      setNote('');
      await loadSourceItems(fromOutletId);
      await loadHistory(fromOutletId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not transfer this stock.');
    } finally {
      setSubmitting(false);
    }
  }

  const outletLabel = (outlet) => (isStoreOutlet(outlet) ? `${outlet.name} (store)` : outlet.name);

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Stock cannot be transferred until connectivity returns.</p>}

      <Card title="Transfer stock">
        <p className={formStyles.hint}>
          Moves stock from one outlet to another at its current cost. It arrives at the destination straight away, and a transfer can never take the source below zero.
        </p>
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>From</span>
              <select className={formStyles.select} value={fromOutletId} onChange={(event) => handleSelectFrom(event.target.value)} required disabled={isOffline}>
                <option value="" disabled>
                  Select an outlet
                </option>
                {(outlets ?? []).map((outlet) => (
                  <option key={outlet.id} value={outlet.id}>
                    {outletLabel(outlet)}
                  </option>
                ))}
              </select>
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>To</span>
              <select className={formStyles.select} value={toOutletId} onChange={(event) => setToOutletId(event.target.value)} required disabled={isOffline}>
                <option value="" disabled>
                  Select an outlet
                </option>
                {(outlets ?? []).map((outlet) => (
                  <option key={outlet.id} value={outlet.id} disabled={String(outlet.id) === String(fromOutletId)}>
                    {outletLabel(outlet)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Stock item</span>
              <select
                className={formStyles.select}
                value={stockItemId}
                onChange={(event) => setStockItemId(event.target.value)}
                required
                disabled={isOffline || !fromOutletId}
              >
                <option value="" disabled>
                  {fromOutletId ? 'Select a stock item' : 'Choose where it comes from first'}
                </option>
                <StockItemOptions items={stockItems} />
              </select>
              {selectedItem && (
                <span className={formStyles.hint}>
                  {formatQuantity(onHand, selectedItem.unit)} on hand at {fromOutlet?.name ?? 'this outlet'}
                </span>
              )}
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Quantity</span>
              <input
                className={formStyles.input}
                inputMode="decimal"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
                disabled={isOffline}
                aria-invalid={exceeds || undefined}
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Note (optional)</span>
              <input className={formStyles.input} value={note} onChange={(event) => setNote(event.target.value)} maxLength={255} disabled={isOffline} />
            </label>
          </div>
          {exceeds && (
            <p role="alert" className={formStyles.errorBanner}>
              Only {formatQuantity(onHand, selectedItem.unit)} of {selectedItem.name} is on hand at {fromOutlet?.name ?? 'this outlet'} — a transfer can&apos;t take it below zero.
            </p>
          )}
          {fromOutletId && stockItems?.length === 0 && <p className={formStyles.hint}>This outlet has no stock to issue yet.</p>}
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={!canSubmit}>
              Transfer
            </Button>
          </div>
        </form>
      </Card>

      {result && (
        <Card title="Transfer recorded">
          <p className={formStyles.hint}>
            Moved {formatQuantity(result.quantity, result.stockItem.unit)} of {result.stockItem.name} from {result.from.outletName} (now{' '}
            {formatQuantity(result.from.newQuantity, result.stockItem.unit)}) to {result.to.outletName} (now {formatQuantity(result.to.newQuantity, result.stockItem.unit)}).
          </p>
        </Card>
      )}

      <DataTable
        title={fromOutlet ? `Recent transfers — ${fromOutlet.name}` : 'Recent transfers'}
        columns={[
          { key: 'businessDate', label: 'Date' },
          { key: 'stockItemName', label: 'Stock item' },
          { key: 'quantity', label: 'Quantity', align: 'right', render: (row) => formatQuantity(row.quantity, row.unit) },
          { key: 'from', label: 'From', render: (row) => row.from?.outletName ?? '—' },
          { key: 'to', label: 'To', render: (row) => row.to?.outletName ?? '—' },
          { key: 'note', label: 'Note', render: (row) => row.note ?? '—' },
        ]}
        rows={history ?? []}
        rowKey={(row) => row.reference}
        state={history === null ? 'loading' : history.length === 0 ? 'empty' : 'success'}
        emptyMessage="No transfers recorded yet."
      />
    </div>
  );
}
