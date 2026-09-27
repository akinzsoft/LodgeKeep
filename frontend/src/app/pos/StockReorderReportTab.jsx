import { useEffect, useMemo, useState } from 'react';
import { DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import { formatQuantity, quantityShortfall, stockLevelTone } from './stockFormat.js';
import { UNCATEGORIZED_LABEL } from './stockItemOptions.jsx';
import formStyles from './POSForm.module.css';

const STATUS_FILTERS = [
  { value: 'all', label: 'Out of stock and low stock' },
  { value: 'out', label: 'Out of stock only' },
  { value: 'low', label: 'Low stock only' },
];

/**
 * StockReorderReportTab — user-requested: every active stock item that is
 * out of stock or at/below its reorder level, so someone can see what to
 * order. Reads the same `GET /pos/stock/items?low_stock=true` the Stock
 * items screen's "Low stock only" filter uses (exact `current_quantity <=
 * reorder_level` on the backend), so the two can never disagree. Out of
 * stock (on hand at or below zero) sorts first, then low stock, each by
 * name. "To reorder" is the shortfall back up to the reorder level — a
 * minimum, not a suggested order size (no par level exists to aim for).
 * Always shows the live position — there is no date range; it is "now".
 */
export function StockReorderReportTab({ activeProperty }) {
  const [outlets, setOutlets] = useState(null);
  const [outletId, setOutletId] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);

  async function load(forOutletId = outletId) {
    setError(null);
    try {
      setItems(await stockApi.listStockItems({ outletId: forOutletId || undefined, lowStockOnly: true }));
      setLoadedAt(new Date());
    } catch (caught) {
      setItems([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the reorder report.');
    }
  }

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: reloads whenever the outlet filter changes
    setItems(null);
    load(outletId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the outlet filter only
  }, [outletId]);

  const outletNameById = useMemo(() => new Map((outlets ?? []).map((outlet) => [String(outlet.id), outlet.name])), [outlets]);

  const rows = useMemo(() => {
    if (items === null) return null;
    return items
      .map((item) => ({ ...item, level: stockLevelTone(item.current_quantity, item.reorder_level) }))
      .filter((item) => item.level !== null)
      .sort((a, b) => (a.level.tone === b.level.tone ? a.name.localeCompare(b.name) : a.level.tone === 'danger' ? -1 : 1));
  }, [items]);

  const outCount = rows?.filter((row) => row.level.tone === 'danger').length ?? 0;
  const lowCount = rows?.filter((row) => row.level.tone === 'warning').length ?? 0;
  const shown = rows?.filter((row) => statusFilter === 'all' || (statusFilter === 'out' ? row.level.tone === 'danger' : row.level.tone === 'warning')) ?? null;

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Outlet</span>
          <select className={formStyles.select} value={outletId} onChange={(event) => setOutletId(event.target.value)}>
            <option value="">All outlets</option>
            {(outlets ?? []).map((outlet) => (
              <option key={outlet.id} value={outlet.id}>
                {outlet.name}
              </option>
            ))}
          </select>
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Show</span>
          <select className={formStyles.select} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            {STATUS_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>
        <div className={formStyles.actionsRow}>
          <Button type="button" variant="ghost" onClick={() => load()}>
            Refresh
          </Button>
        </div>
      </div>

      {rows !== null && (
        <p className={formStyles.hint}>
          {outCount} out of stock, {lowCount} low stock (at or below the reorder level)
          {loadedAt && ` — as of ${loadedAt.toLocaleTimeString()}`}.
        </p>
      )}

      <DataTable
        title="Reorder report"
        state={shown === null ? 'loading' : shown.length === 0 ? 'empty' : 'success'}
        emptyMessage={rows?.length ? 'Nothing matches this filter.' : 'Nothing to reorder — every stock item is above its reorder level.'}
        columns={[
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={row.level.tone} label={row.level.label} /> },
          { key: 'name', label: 'Stock item' },
          { key: 'category', label: 'Stock category', render: (row) => row.category?.trim() || UNCATEGORIZED_LABEL },
          { key: 'outlet', label: 'Outlet', render: (row) => outletNameById.get(String(row.outlet_id)) ?? '—' },
          { key: 'current_quantity', label: 'Stock balance', align: 'right', render: (row) => formatQuantity(row.current_quantity, row.unit) },
          { key: 'reorder_level', label: 'Reorder level', align: 'right', render: (row) => formatQuantity(row.reorder_level, row.unit) },
          { key: 'shortfall', label: 'To reorder (at least)', align: 'right', render: (row) => formatQuantity(quantityShortfall(row.reorder_level, row.current_quantity), row.unit) },
          { key: 'supplier', label: 'Supplier', render: (row) => row.supplier || '—' },
          {
            key: 'purchase_cost',
            label: 'Unit cost',
            align: 'right',
            render: (row) => (row.purchase_cost != null ? <Money amount={row.purchase_cost} currencyCode={activeProperty.base_currency} /> : '—'),
          },
        ]}
        rows={shown ?? []}
        rowKey={(row) => row.id}
      />
    </div>
  );
}
