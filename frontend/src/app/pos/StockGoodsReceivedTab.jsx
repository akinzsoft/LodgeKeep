import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { formatQuantity } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import { StockItemOptions } from './stockItemOptions.jsx';
import formStyles from './POSForm.module.css';

function emptyLine() {
  return { key: `${Date.now()}-${Math.random()}`, stock_item_id: '', quantity: '', unit_cost: '' };
}

/**
 * StockGoodsReceivedTab — PLAN.md Phase 6: record a real delivery in one
 * batch. `pos.stock_manage` only, backend-enforced. `purchase_cost` on
 * every named stock item is wholesale-replaced by THIS delivery's own line
 * (`stock/service.js`'s "last-cost only, never a weighted average") — the
 * result card shows exactly what changed, not a generic "saved" message,
 * since that replacement is a real, consequential side effect.
 *
 * Bug fix (see `POSScreen`'s own header): the new-cost column used to
 * hardcode a literal NGN currency code — `stock_items` carries no currency
 * column of its own, so the real source of truth is the active property's
 * `base_currency`, now threaded in as a prop.
 *
 * Gap closure (user-reported: "Goods received currently shows only an
 * outlet selector with nothing below it until one is chosen"): the delivery
 * form now renders immediately, matching the Wastage/Stock Takes tabs' own
 * established pattern of disabling only the outlet-DEPENDENT control (the
 * stock-item select) rather than hiding the whole form. A "Recent
 * deliveries" list is new too — this tab's own submission used to vanish
 * the moment you navigated away, since nothing anywhere surfaced
 * `listStockMovements` (a real, working backend function that had simply
 * never been routed).
 */
export function StockGoodsReceivedTab({ activeProperty, isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState('');
  const [stockItems, setStockItems] = useState(null);
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState([emptyLine()]);

  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [recentMovements, setRecentMovements] = useState(null);

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
  }, []);

  async function loadRecentMovements(outletId) {
    try {
      setRecentMovements(await stockApi.listStockMovements({ outletId, type: 'received', limit: 20 }));
    } catch {
      setRecentMovements([]);
    }
  }

  async function handleSelectOutlet(outletId) {
    setSelectedOutletId(outletId);
    setResult(null);
    setError(null);
    setRecentMovements(null);
    if (!outletId) {
      setStockItems(null);
      return;
    }
    try {
      setStockItems(await stockApi.listStockItems({ outletId }));
    } catch (caught) {
      setStockItems([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load stock items for this outlet.');
    }
    await loadRecentMovements(outletId);
  }

  function updateLine(key, changes) {
    setLines(lines.map((line) => (line.key === key ? { ...line, ...changes } : line)));
  }

  function addLine() {
    setLines([...lines, emptyLine()]);
  }

  function removeLine(key) {
    setLines(lines.length === 1 ? [emptyLine()] : lines.filter((line) => line.key !== key));
  }

  const validLines = lines.filter((line) => line.stock_item_id && line.quantity && line.unit_cost);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await stockApi.recordGoodsReceived({
        outletId: selectedOutletId,
        reference: reference || undefined,
        lines: validLines.map((line) => ({ stockItemId: line.stock_item_id, quantity: line.quantity, unitCost: line.unit_cost })),
      });
      setResult(response);
      setLines([emptyLine()]);
      setReference('');
      setStockItems(await stockApi.listStockItems({ outletId: selectedOutletId }));
      await loadRecentMovements(selectedOutletId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record this delivery.');
    } finally {
      setSubmitting(false);
    }
  }

  const stockItemsById = new Map((stockItems ?? []).map((item) => [String(item.id), item]));

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Deliveries cannot be recorded until connectivity returns.</p>}

      <label className={formStyles.field}>
        <span className={formStyles.label}>Outlet</span>
        <select className={formStyles.select} value={selectedOutletId} onChange={(event) => handleSelectOutlet(event.target.value)} disabled={isOffline}>
          <option value="">Select an outlet</option>
          {(outlets ?? []).map((outlet) => (
            <option key={outlet.id} value={outlet.id}>
              {outlet.name}
            </option>
          ))}
        </select>
      </label>

      <Card title="New delivery">
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Reference (optional)</span>
            <input className={formStyles.input} placeholder="Delivery note number" value={reference} onChange={(event) => setReference(event.target.value)} disabled={isOffline} />
          </label>

          {lines.map((line) => (
            <div className={formStyles.row} key={line.key}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Stock item</span>
                <select
                  className={formStyles.select}
                  value={line.stock_item_id}
                  onChange={(event) => updateLine(line.key, { stock_item_id: event.target.value })}
                  disabled={isOffline || !selectedOutletId}
                >
                  <option value="">{selectedOutletId ? 'Select a stock item' : 'Select an outlet first'}</option>
                  <StockItemOptions items={stockItems} />
                </select>
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Quantity</span>
                <input
                  className={formStyles.input}
                  type="number"
                  step="0.001"
                  min="0"
                  value={line.quantity}
                  onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
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
                  value={line.unit_cost}
                  onChange={(event) => updateLine(line.key, { unit_cost: event.target.value })}
                  disabled={isOffline}
                />
              </label>
              <div className={formStyles.actionsRow}>
                <Button type="button" size="compact" variant="danger" disabled={isOffline} onClick={() => removeLine(line.key)}>
                  Remove line
                </Button>
              </div>
            </div>
          ))}

          <div className={formStyles.actionsRow}>
            <Button type="button" variant="secondary" disabled={isOffline} onClick={addLine}>
              Add another line
            </Button>
            <Button type="submit" loading={submitting} disabled={isOffline || !selectedOutletId || validLines.length === 0}>
              Record delivery
            </Button>
          </div>
        </form>
      </Card>

      {result && (
        <Card title="Delivery recorded">
          <p className={formStyles.hint}>
            {result.count} line{result.count === 1 ? '' : 's'} received{result.reference ? ` — reference "${result.reference}"` : ''}. Cost on each item below is now this delivery&rsquo;s own
            unit cost.
          </p>
          <DataTable
            columns={[
              { key: 'name', label: 'Stock item' },
              { key: 'current_quantity', label: 'New quantity on hand', align: 'right', render: (row) => formatQuantity(row.current_quantity, row.unit) },
              { key: 'purchase_cost', label: 'New cost', align: 'right', render: (row) => <Money amount={row.purchase_cost} currencyCode={activeProperty.base_currency} /> },
            ]}
            rows={result.items}
            rowKey={(row) => row.id}
          />
        </Card>
      )}

      {stockItemsById.size === 0 && selectedOutletId && stockItems !== null && (
        <p className={formStyles.hint}>This outlet has no stock items yet — add one on the Stock Items tab first.</p>
      )}

      {selectedOutletId && (
        <DataTable
          title="Recent deliveries"
          columns={[
            { key: 'business_date', label: 'Date' },
            { key: 'stock_item_name', label: 'Stock item' },
            { key: 'quantity', label: 'Quantity', align: 'right', render: (row) => formatQuantity(row.quantity, row.stock_item_unit) },
            { key: 'unit_cost', label: 'Unit cost', align: 'right', render: (row) => <Money amount={row.unit_cost} currencyCode={activeProperty.base_currency} /> },
            { key: 'reference', label: 'Reference', render: (row) => row.reference ?? '—' },
          ]}
          rows={recentMovements ?? []}
          rowKey={(row) => row.id}
          state={recentMovements === null ? 'loading' : 'success'}
          emptyMessage="No deliveries recorded yet for this outlet."
        />
      )}
    </div>
  );
}
