import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { formatQuantity } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

const STATUS_TONE = { open: 'info', completed: 'success', cancelled: 'neutral' };
const STATUS_LABEL = { open: 'Open', completed: 'Completed', cancelled: 'Cancelled' };

/**
 * StockTakesTab — PLAN.md Phase 6's blind stock take: open, blind-count,
 * complete (revealing variance and posting real adjusting stock movements)
 * or cancel. `pos.stock_manage` only, backend-enforced.
 *
 * ── BLIND COUNTING IS STRUCTURAL HERE TOO, NOT JUST ON THE BACKEND ───────
 *
 * The exact same discipline `ShiftsTab.jsx`'s own blind cash-up already
 * establishes for this screen: while a take is `open`, this component never
 * reads or renders `theoretical_quantity`/`variance` at all — the count
 * entry table has no columns for either, and the backend itself returns
 * both as `null` for every line until `completeStockTake` is actually
 * called (`stock_take_lines`' own migration header). Only once that call
 * returns does a genuinely different, read-only result view appear, with
 * both values revealed for the first time — there is no code path here
 * that could show a number before the operator has finished counting.
 */
export function StockTakesTab({ isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [openOutletId, setOpenOutletId] = useState('');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(null);

  const [takes, setTakes] = useState(null);
  const [listError, setListError] = useState(null);

  const [selectedTakeId, setSelectedTakeId] = useState(null);
  const [detail, setDetail] = useState(null); // {stockTake, lines}
  const [detailError, setDetailError] = useState(null);
  const [outletStockItems, setOutletStockItems] = useState(null);

  const [countInputs, setCountInputs] = useState({});
  const [countSubmittingId, setCountSubmittingId] = useState(null);
  const [countError, setCountError] = useState(null);

  const [confirmingComplete, setConfirmingComplete] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState(null);

  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelError, setCancelError] = useState(null);

  async function reloadTakes() {
    try {
      setTakes(await stockApi.listStockTakes());
      setListError(null);
    } catch (caught) {
      setTakes([]);
      setListError(caught instanceof ApiError ? caught.message : 'Could not load stock takes.');
    }
  }

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadTakes();
  }, []);

  async function handleSelectTake(id) {
    setSelectedTakeId(id);
    setDetail(null);
    setDetailError(null);
    setCountError(null);
    setCompleteError(null);
    setCancelError(null);
    try {
      const result = await stockApi.getStockTake(id);
      setDetail(result);
      // Stock items for this take's own outlet are loaded regardless of
      // status — needed both for the blind count-entry picker (open) and
      // to resolve a stock item's real name on the revealed result table
      // (completed), never just the raw id.
      const items = await stockApi.listStockItems({ outletId: result.stockTake.outlet_id });
      setOutletStockItems(items);
      if (result.stockTake.status === 'open') {
        const inputs = {};
        for (const item of items) {
          const existingLine = result.lines.find((line) => String(line.stock_item_id) === String(item.id));
          inputs[item.id] = existingLine ? existingLine.counted_quantity : '';
        }
        setCountInputs(inputs);
      }
    } catch (caught) {
      setDetailError(caught instanceof ApiError ? caught.message : 'Could not load this stock take.');
    }
  }

  async function handleOpenTake(event) {
    event.preventDefault();
    setOpening(true);
    setOpenError(null);
    try {
      const created = await stockApi.openStockTake({ outletId: openOutletId });
      setOpenOutletId('');
      await reloadTakes();
      await handleSelectTake(created.id);
    } catch (caught) {
      setOpenError(caught instanceof ApiError ? caught.message : 'Could not open a stock take for this outlet.');
    } finally {
      setOpening(false);
    }
  }

  async function handleSubmitCount(stockItemId) {
    setCountSubmittingId(stockItemId);
    setCountError(null);
    try {
      const line = await stockApi.recordStockTakeCount(selectedTakeId, stockItemId, countInputs[stockItemId]);
      setDetail((prev) => ({
        ...prev,
        lines: [...prev.lines.filter((existing) => String(existing.stock_item_id) !== String(stockItemId)), line],
      }));
    } catch (caught) {
      setCountError(caught instanceof ApiError ? caught.message : 'Could not save this count.');
    } finally {
      setCountSubmittingId(null);
    }
  }

  async function handleComplete() {
    setConfirmingComplete(false);
    setCompleting(true);
    setCompleteError(null);
    try {
      const result = await stockApi.completeStockTake(selectedTakeId);
      setDetail(result);
      await reloadTakes();
    } catch (caught) {
      setCompleteError(caught instanceof ApiError ? caught.message : 'Could not complete this stock take.');
    } finally {
      setCompleting(false);
    }
  }

  async function handleCancel(reason) {
    setConfirmingCancel(false);
    setCancelError(null);
    try {
      const stockTake = await stockApi.cancelStockTake(selectedTakeId, reason);
      setDetail((prev) => ({ ...prev, stockTake }));
      await reloadTakes();
    } catch (caught) {
      setCancelError(caught instanceof ApiError ? caught.message : 'Could not cancel this stock take.');
    }
  }

  const outletsById = new Map((outlets ?? []).map((outlet) => [String(outlet.id), outlet]));
  const stockItemsById = new Map((outletStockItems ?? []).map((item) => [String(item.id), item]));

  return (
    <div className={formStyles.form}>
      {listError && (
        <p role="alert" className={formStyles.errorBanner}>
          {listError}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Stock takes cannot be opened, counted, completed, or cancelled until connectivity returns.</p>}

      <Card title="Open a new stock take">
        {openError && (
          <p role="alert" className={formStyles.errorBanner}>
            {openError}
          </p>
        )}
        <form className={formStyles.row} onSubmit={handleOpenTake}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Outlet</span>
            <select className={formStyles.select} value={openOutletId} onChange={(event) => setOpenOutletId(event.target.value)} required disabled={isOffline}>
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
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={opening} disabled={isOffline}>
              Open stock take
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        title="Stock takes"
        state={takes === null ? 'loading' : takes.length === 0 ? 'empty' : 'success'}
        emptyMessage="No stock takes yet — open one above."
        columns={[
          { key: 'outlet', label: 'Outlet', render: (row) => outletsById.get(String(row.outlet_id))?.name ?? `#${row.outlet_id}` },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={STATUS_TONE[row.status]} label={STATUS_LABEL[row.status]} /> },
          { key: 'opened_at', label: 'Opened' },
        ]}
        rows={takes ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <Button size="compact" variant="ghost" onClick={() => handleSelectTake(row.id)}>
            View
          </Button>
        )}
      />

      {detailError && (
        <p role="alert" className={formStyles.errorBanner}>
          {detailError}
        </p>
      )}

      {detail && (
        <Card title={`Stock take #${detail.stockTake.id} — ${outletsById.get(String(detail.stockTake.outlet_id))?.name ?? `#${detail.stockTake.outlet_id}`}`}>
          <p>
            Status: <StatusPill tone={STATUS_TONE[detail.stockTake.status]} label={STATUS_LABEL[detail.stockTake.status]} />
          </p>

          {detail.stockTake.status === 'open' && (
            <>
              <p className={formStyles.hint}>Enter what you counted for each item. Nothing here shows what the system expects until this take is completed.</p>
              {countError && (
                <p role="alert" className={formStyles.errorBanner}>
                  {countError}
                </p>
              )}
              <DataTable
                state={(outletStockItems ?? []).length === 0 ? (outletStockItems === null ? 'loading' : 'empty') : 'success'}
                emptyMessage="This outlet has no stock items yet."
                columns={[
                  { key: 'name', label: 'Stock item' },
                  { key: 'unit', label: 'Unit' },
                  {
                    key: 'counted_quantity',
                    label: 'Counted quantity',
                    align: 'right',
                    render: (row) => (
                      <input
                        className={formStyles.input}
                        type="number"
                        step="0.001"
                        min="0"
                        aria-label={`Counted quantity for ${row.name}`}
                        value={countInputs[row.id] ?? ''}
                        onChange={(event) => setCountInputs({ ...countInputs, [row.id]: event.target.value })}
                        disabled={isOffline}
                      />
                    ),
                  },
                ]}
                rows={outletStockItems ?? []}
                rowKey={(row) => row.id}
                actions={(row) => (
                  <Button size="compact" loading={countSubmittingId === row.id} disabled={isOffline || countInputs[row.id] === ''} onClick={() => handleSubmitCount(row.id)}>
                    Save count
                  </Button>
                )}
              />

              {completeError && (
                <p role="alert" className={formStyles.errorBanner}>
                  {completeError}
                </p>
              )}
              <div className={formStyles.actionsRow}>
                <Button type="button" loading={completing} disabled={isOffline} onClick={() => setConfirmingComplete(true)}>
                  Complete stock take
                </Button>
                <Button type="button" variant="danger" disabled={isOffline} onClick={() => setConfirmingCancel(true)}>
                  Cancel stock take
                </Button>
              </div>
            </>
          )}

          {detail.stockTake.status === 'completed' && (
            <DataTable
              title="Result"
              state={detail.lines.length === 0 ? 'empty' : 'success'}
              emptyMessage="No items were counted before this take was completed."
              columns={[
                { key: 'stock_item', label: 'Stock item', render: (row) => stockItemsById.get(String(row.stock_item_id))?.name ?? `#${row.stock_item_id}` },
                { key: 'counted_quantity', label: 'Counted', align: 'right', render: (row) => formatQuantity(row.counted_quantity, stockItemsById.get(String(row.stock_item_id))?.unit) },
                {
                  key: 'theoretical_quantity',
                  label: 'Theoretical',
                  align: 'right',
                  render: (row) => formatQuantity(row.theoretical_quantity, stockItemsById.get(String(row.stock_item_id))?.unit),
                },
                { key: 'variance', label: 'Variance', align: 'right', render: (row) => formatQuantity(row.variance, stockItemsById.get(String(row.stock_item_id))?.unit) },
              ]}
              rows={detail.lines}
              rowKey={(row) => row.id}
            />
          )}

          {detail.stockTake.status === 'cancelled' && (
            <p className={formStyles.hint}>
              Cancelled{detail.stockTake.cancel_reason ? ` — ${detail.stockTake.cancel_reason}` : ''}.
            </p>
          )}
        </Card>
      )}

      {confirmingComplete && (
        <ConfirmDialog
          title="Complete this stock take?"
          consequence="This locks the count and posts real adjusting stock movements for any variance found. This cannot be undone."
          confirmLabel="Complete"
          onConfirm={handleComplete}
          onCancel={() => setConfirmingComplete(false)}
        />
      )}

      {confirmingCancel && (
        <ConfirmDialog
          title="Cancel this stock take?"
          consequence="This abandons the count with no stock effect at all. Any quantities already entered are discarded."
          requireReason
          confirmLabel="Cancel stock take"
          onConfirm={handleCancel}
          onCancel={() => setConfirmingCancel(false)}
        />
      )}

      {cancelError && (
        <p role="alert" className={formStyles.errorBanner}>
          {cancelError}
        </p>
      )}
    </div>
  );
}
