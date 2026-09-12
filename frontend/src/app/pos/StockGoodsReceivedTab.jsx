import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { formatQuantity } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
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
 */
export function StockGoodsReceivedTab({ isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState('');
  const [stockItems, setStockItems] = useState(null);
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState([emptyLine()]);

  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
  }, []);

  async function handleSelectOutlet(outletId) {
    setSelectedOutletId(outletId);
    setResult(null);
    setError(null);
    try {
      setStockItems(await stockApi.listStockItems({ outletId }));
    } catch (caught) {
      setStockItems([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load stock items for this outlet.');
    }
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

      {selectedOutletId && (
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
                  <select className={formStyles.select} value={line.stock_item_id} onChange={(event) => updateLine(line.key, { stock_item_id: event.target.value })} disabled={isOffline}>
                    <option value="">Select a stock item</option>
                    {(stockItems ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.unit})
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
              <Button type="submit" loading={submitting} disabled={isOffline || validLines.length === 0}>
                Record delivery
              </Button>
            </div>
          </form>
        </Card>
      )}

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
              { key: 'purchase_cost', label: 'New cost', align: 'right', render: (row) => <Money amount={row.purchase_cost} currencyCode="NGN" /> },
            ]}
            rows={result.items}
            rowKey={(row) => row.id}
          />
        </Card>
      )}

      {stockItemsById.size === 0 && selectedOutletId && stockItems !== null && (
        <p className={formStyles.hint}>This outlet has no stock items yet — add one on the Stock Items tab first.</p>
      )}
    </div>
  );
}
