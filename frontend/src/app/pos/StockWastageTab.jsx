import { useEffect, useState } from 'react';
import { Card, Button } from '../../shared/components/index.js';
import { formatQuantity } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

/**
 * StockWastageTab — PLAN.md Phase 6: record a real loss (breakage, spoilage,
 * a spill) against one stock item. `pos.stock_view` — a floor action,
 * deliberately reachable by `pos_operator`, not manager-only, matching this
 * pass's own confirmed RBAC split (`stock/routes.js`'s own header).
 *
 * The reason field is mandatory — both here (client-side, so a person gets
 * an immediate, specific message rather than a round trip) and on the real
 * backend (`MissingWastageReasonError`, the actual enforcement). Matches
 * `AdjustmentForm`'s own established shape in `CashieringScreen.jsx` — a
 * plain, required-reason form, not a `ConfirmDialog`, for a reasoned write
 * that isn't itself a void/checkout-shaped irreversible action.
 */
export function StockWastageTab({ isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState('');
  const [stockItems, setStockItems] = useState(null);
  const [selectedStockItemId, setSelectedStockItemId] = useState('');

  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [validationError, setValidationError] = useState(null);
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
    setSelectedStockItemId('');
    setResult(null);
    try {
      setStockItems(await stockApi.listStockItems({ outletId }));
      setError(null);
    } catch (caught) {
      setStockItems([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load stock items for this outlet.');
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    // Client-side, so the reason is caught before a round trip — the real
    // enforcement is still the backend's own `MissingWastageReasonError`.
    if (reason.trim().length === 0) {
      setValidationError('A reason is required to record wastage.');
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    try {
      const item = await stockApi.recordWastage(selectedStockItemId, { quantity, reason: reason.trim() });
      setResult(item);
      setQuantity('');
      setReason('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record this wastage.');
    } finally {
      setSubmitting(false);
    }
  }

  const selectedStockItem = (stockItems ?? []).find((item) => String(item.id) === String(selectedStockItemId));

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Wastage cannot be recorded until connectivity returns.</p>}

      <Card title="Record wastage">
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Outlet</span>
              <select className={formStyles.select} value={selectedOutletId} onChange={(event) => handleSelectOutlet(event.target.value)} required disabled={isOffline}>
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
              <span className={formStyles.label}>Stock item</span>
              <select
                className={formStyles.select}
                value={selectedStockItemId}
                onChange={(event) => setSelectedStockItemId(event.target.value)}
                required
                disabled={isOffline || !selectedOutletId}
              >
                <option value="" disabled>
                  Select a stock item
                </option>
                {(stockItems ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.unit})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Quantity lost</span>
              <input className={formStyles.input} type="number" step="0.001" min="0" value={quantity} onChange={(event) => setQuantity(event.target.value)} required disabled={isOffline} />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Reason</span>
              {/* Deliberately NOT `required` at the HTML level — the browser's
                  own native constraint validation would block `onSubmit` from
                  ever firing on an empty field, silently skipping the explicit
                  `validationError` message below (and a whitespace-only value
                  would pass native `required` outright). The JS check in
                  `handleSubmit` is the one real client-side gate here; the
                  backend's own `MissingWastageReasonError` is the real
                  enforcement regardless. */}
              <input className={formStyles.input} value={reason} onChange={(event) => setReason(event.target.value)} disabled={isOffline} />
            </label>
          </div>
          {validationError && (
            <p role="alert" className={formStyles.errorBanner}>
              {validationError}
            </p>
          )}
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={isOffline || !selectedStockItemId}>
              Record wastage
            </Button>
          </div>
        </form>
      </Card>

      {result && (
        <Card title="Recorded">
          <p className={formStyles.hint}>
            {selectedStockItem?.name ?? result.name} is now at {formatQuantity(result.current_quantity, result.unit)} on hand.
          </p>
        </Card>
      )}
    </div>
  );
}
