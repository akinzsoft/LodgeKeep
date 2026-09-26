import { useEffect, useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import { formatQuantity } from './stockFormat.js';
import { UNCATEGORIZED_LABEL } from './stockItemOptions.jsx';
import formStyles from './POSForm.module.css';

const MOVEMENT_LIMIT = 200;

/** Plain-language names for `stock_movements.type` — a Register sale is what most people are looking for here. */
const MOVEMENT_LABEL = {
  sold: 'Register sale',
  sale_reversal: 'Sale reversed',
  received: 'Received',
  wastage: 'Wastage',
  count_adjustment: 'Stock-take adjustment',
  transfer: 'Transfer',
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * StockReportsTab — PLAN.md Phase 6: cost-of-sales and stock-variance
 * reporting. `pos.stock_manage` only (a cost/margin figure is a
 * manager-tier concern, matching `stock/reporting.js`'s own header — the
 * same RBAC gate this pass's own CRUD/goods-received/stock-take endpoints
 * already use), backend-enforced; no client-side check hides this tab.
 *
 * No CSV export here — unlike `RevenueTab.jsx`, the real backend
 * (`stock/routes.js`) exposes no `?format=csv` variant of either report
 * endpoint, so adding a download button here would call an endpoint that
 * doesn't exist. Both reports render as plain tables instead, the same
 * "run report" shape `RevenueTab.jsx`/`OccupancyTab.jsx` already establish.
 *
 * Bug fix (see `POSScreen`'s own header): every cost figure here used to
 * hardcode a literal NGN currency code — `stock_items`/cost-of-sales rows
 * carry no currency column of their own, so the real source of truth is
 * the active property's `base_currency`, now threaded in as a prop.
 *
 * Bug fix (found in this session's own broader "REVIEW and test POS" pass):
 * both reports' own `stockItemId` columns rendered the bare numeric id —
 * `stock/reporting.js`'s own response shape never carries a name (see that
 * file's header: ids are grouped/summed there, never joined against
 * `stock_items`), and nothing on this tab ever resolved one either, so a
 * manager reading a cost/variance report saw "20" instead of the actual
 * ingredient name. Fixed the same way `GuestOrdersTab.jsx` already resolves
 * `menu_item_id` client-side: a plain id-to-name lookup built from
 * `stockApi.listStockItems()` (no outlet filter, since either report can
 * span every outlet), falling back to `#id` for an item since archived.
 *
 * Gap closure: a third report, cost-of-sales MARGIN — revenue, cost, and
 * margin per menu item (and rolled up by the menu item's own category),
 * unlike the two reports above which only ever show the cost side. A row
 * with no recipe and no `cost_price` configured shows "Unknown" rather
 * than a false "0.00" — `stock/reporting.js`'s own header on why a
 * genuinely unknown cost is never treated as free.
 */
export function StockReportsTab({ activeProperty }) {
  const [outlets, setOutlets] = useState(null);
  const [outletId, setOutletId] = useState('');
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(todayIso());

  const [costOfSales, setCostOfSales] = useState(null);
  const [variance, setVariance] = useState(null);
  const [margin, setMargin] = useState(null);
  // Every stock item/category with the period's movements folded on (see `stock/reporting.js`'s `computeStockOverview`), and — once an outlet is chosen — its raw movement history, including Register sales.
  const [overview, setOverview] = useState(null);
  const [movements, setMovements] = useState(null);
  const [error, setError] = useState(null);
  const [stockItemsById, setStockItemsById] = useState({});

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
    stockApi
      .listStockItems()
      .then((items) => setStockItemsById(Object.fromEntries(items.map((item) => [String(item.id), item]))))
      .catch(() => setStockItemsById({}));
  }, []);

  function stockItemName(stockItemId) {
    return stockItemsById[String(stockItemId)]?.name ?? `#${stockItemId}`;
  }

  function stockItemCategory(stockItemId) {
    const item = stockItemsById[String(stockItemId)];
    return item ? item.category?.trim() || UNCATEGORIZED_LABEL : '—';
  }

  async function runReports(event) {
    event?.preventDefault();
    setError(null);
    try {
      const [cos, varianceResult, marginResult, overviewResult, movementList] = await Promise.all([
        stockApi.getCostOfSales({ dateFrom, dateTo, outletId: outletId || undefined }),
        stockApi.getStockVariance({ dateFrom, dateTo, outletId: outletId || undefined }),
        stockApi.getCostOfSalesMargin({ dateFrom, dateTo, outletId: outletId || undefined }),
        stockApi.getStockOverview({ dateFrom, dateTo, outletId: outletId || undefined }),
        // The movement list needs an outlet (its endpoint requires one or a stock item).
        outletId ? stockApi.listStockMovements({ outletId, dateFrom, dateTo, limit: MOVEMENT_LIMIT }) : Promise.resolve(null),
      ]);
      setCostOfSales(cos);
      setVariance(varianceResult);
      setMargin(marginResult);
      setOverview(overviewResult);
      setMovements(movementList);
    } catch (caught) {
      setCostOfSales(null);
      setVariance(null);
      setMargin(null);
      setOverview(null);
      setMovements(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load these reports.');
    }
  }

  /** `null` means genuinely unknown cost (no recipe, no cost_price) — never rendered as a false "0.00". */
  function moneyOrUnknown(amount, currencyCode) {
    return amount === null ? 'Unknown' : <Money amount={amount} currencyCode={currencyCode} />;
  }

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      {/* Outside DataTable's own toolbar slot, deliberately — see
          `RevenueTab.jsx`'s own identical comment: Card only renders
          `children` while `state === 'success'`, so a persistent
          date-range/outlet control must never live inside it. */}
      <form className={formStyles.row} onSubmit={runReports}>
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
          <span className={formStyles.label}>From</span>
          <input type="date" className={formStyles.input} value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} required />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>To</span>
          <input type="date" className={formStyles.input} value={dateTo} onChange={(event) => setDateTo(event.target.value)} required />
        </label>
        <div className={formStyles.actionsRow}>
          <Button type="submit">Run reports</Button>
        </div>
      </form>

      {overview && (
        <p className={formStyles.hint}>
          {overview.totals.itemCount} active stock item{overview.totals.itemCount === 1 ? '' : 's'} — cost of sales <Money amount={overview.totals.soldCost} currencyCode={activeProperty.base_currency} />, wastage{' '}
          <Money amount={overview.totals.wastageCost} currencyCode={activeProperty.base_currency} />
        </p>
      )}

      <DataTable
        title="Stock categories — summary"
        state={overview === null || overview.byCategory.length === 0 ? 'empty' : 'success'}
        emptyMessage={overview === null ? 'Choose a date range and run the reports.' : 'No stock categories or items yet.'}
        columns={[
          { key: 'category', label: 'Stock category', render: (row) => row.category ?? UNCATEGORIZED_LABEL },
          { key: 'itemCount', label: 'Items', align: 'right' },
          { key: 'lowStockCount', label: 'Low / out of stock', align: 'right' },
          { key: 'soldCost', label: 'Cost of sales', align: 'right', render: (row) => <Money amount={row.soldCost} currencyCode={activeProperty.base_currency} /> },
          { key: 'wastageCost', label: 'Wastage', align: 'right', render: (row) => <Money amount={row.wastageCost} currencyCode={activeProperty.base_currency} /> },
        ]}
        rows={overview?.byCategory ?? []}
        rowKey={(row) => row.category ?? '__none__'}
      />

      <DataTable
        title="Every stock item — by stock category"
        state={overview === null || overview.items.length === 0 ? 'empty' : 'success'}
        emptyMessage={overview === null ? 'Choose a date range and run the reports.' : 'No stock items yet.'}
        columns={[
          { key: 'category', label: 'Stock category', render: (row) => row.category ?? UNCATEGORIZED_LABEL },
          { key: 'name', label: 'Stock item' },
          { key: 'currentQuantity', label: 'On hand', align: 'right', render: (row) => formatQuantity(row.currentQuantity, row.unit) },
          { key: 'soldQty', label: 'Sold', align: 'right', render: (row) => formatQuantity(row.soldQty, row.unit) },
          { key: 'soldCost', label: 'Cost of sales', align: 'right', render: (row) => <Money amount={row.soldCost} currencyCode={activeProperty.base_currency} /> },
          { key: 'receivedQty', label: 'Received', align: 'right', render: (row) => formatQuantity(row.receivedQty, row.unit) },
          { key: 'wastageQty', label: 'Wasted', align: 'right', render: (row) => formatQuantity(row.wastageQty, row.unit) },
          { key: 'adjustmentQty', label: 'Count adjustment', align: 'right', render: (row) => formatQuantity(row.adjustmentQty, row.unit) },
        ]}
        rows={overview?.items ?? []}
        rowKey={(row) => row.stockItemId}
      />

      {/* Outside the table's own state slot, deliberately — a persistent hint must not vanish with an empty result. */}
      {overview && movements === null && <p className={formStyles.hint}>Choose an outlet and run the reports to also see its stock movement history, including Register sales.</p>}
      {movements !== null && movements.length >= MOVEMENT_LIMIT && (
        <p className={formStyles.hint}>Showing the latest {MOVEMENT_LIMIT} movements — narrow the date range to see earlier ones.</p>
      )}
      {movements !== null && (
        <DataTable
          title="Stock movements — including Register sales"
          state={movements.length === 0 ? 'empty' : 'success'}
          emptyMessage="No stock movements in this range for this outlet."
          columns={[
            { key: 'business_date', label: 'Date' },
            { key: 'category', label: 'Stock category', render: (row) => row.stock_item_category?.trim() || UNCATEGORIZED_LABEL },
            { key: 'stock_item_name', label: 'Stock item' },
            { key: 'type', label: 'Type', render: (row) => MOVEMENT_LABEL[row.type] ?? row.type },
            { key: 'quantity', label: 'Quantity', align: 'right', render: (row) => formatQuantity(row.quantity, row.stock_item_unit) },
          ]}
          rows={movements}
          rowKey={(row) => row.id}
        />
      )}

      {costOfSales && (
        <p className={formStyles.hint}>
          Total cost of sales: <Money amount={costOfSales.totalCost} currencyCode={activeProperty.base_currency} />
        </p>
      )}

      <DataTable
        title="Cost of sales — by day"
        state={costOfSales === null || costOfSales.byDay.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the reports."
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'cost', label: 'Cost', align: 'right', render: (row) => <Money amount={row.cost} currencyCode={activeProperty.base_currency} /> },
        ]}
        rows={costOfSales?.byDay ?? []}
        rowKey={(row) => row.date}
      />

      <DataTable
        title="Cost of sales — by stock item"
        state={costOfSales === null || costOfSales.byItem.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the reports."
        columns={[
          { key: 'category', label: 'Stock category', render: (row) => stockItemCategory(row.stockItemId) },
          { key: 'stockItemId', label: 'Stock item', render: (row) => stockItemName(row.stockItemId) },
          { key: 'cost', label: 'Cost', align: 'right', render: (row) => <Money amount={row.cost} currencyCode={activeProperty.base_currency} /> },
        ]}
        rows={costOfSales?.byItem ?? []}
        rowKey={(row) => row.stockItemId}
      />

      <DataTable
        title="Stock variance — every completed stock take in range"
        state={variance === null || variance.summaryByItem.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the reports."
        columns={[
          { key: 'category', label: 'Stock category', render: (row) => stockItemCategory(row.stockItemId) },
          { key: 'stockItemId', label: 'Stock item', render: (row) => stockItemName(row.stockItemId) },
          { key: 'totalVariance', label: 'Total variance', align: 'right' },
        ]}
        rows={variance?.summaryByItem ?? []}
        rowKey={(row) => row.stockItemId}
      />

      {margin && (
        <p className={formStyles.hint}>
          Total revenue: {moneyOrUnknown(margin.totals.revenue, activeProperty.base_currency)} — total cost:{' '}
          {moneyOrUnknown(margin.totals.cost, activeProperty.base_currency)} — total margin: {moneyOrUnknown(margin.totals.margin, activeProperty.base_currency)}
          {margin.totals.itemsWithUnknownCost > 0 &&
            ` (${margin.totals.itemsWithUnknownCost} item${margin.totals.itemsWithUnknownCost === 1 ? '' : 's'} with no recipe or cost price configured, excluded from the cost/margin totals)`}
        </p>
      )}

      <DataTable
        title="Cost-of-sales margin — by menu item"
        state={margin === null || margin.byMenuItem.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the reports."
        columns={[
          { key: 'name', label: 'Menu item' },
          { key: 'category', label: 'Menu category', render: (row) => row.category ?? '—' },
          { key: 'quantity', label: 'Qty sold', align: 'right' },
          { key: 'revenue', label: 'Revenue', align: 'right', render: (row) => <Money amount={row.revenue} currencyCode={activeProperty.base_currency} /> },
          { key: 'cost', label: 'Cost', align: 'right', render: (row) => moneyOrUnknown(row.cost, activeProperty.base_currency) },
          { key: 'margin', label: 'Margin', align: 'right', render: (row) => moneyOrUnknown(row.margin, activeProperty.base_currency) },
          { key: 'marginPct', label: 'Margin %', align: 'right', render: (row) => (row.marginPct === null ? '—' : `${row.marginPct.toFixed(1)}%`) },
        ]}
        rows={margin?.byMenuItem ?? []}
        rowKey={(row) => row.menuItemId}
      />

      <DataTable
        title="Cost-of-sales margin — by menu category"
        state={margin === null || margin.byCategory.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the reports."
        columns={[
          { key: 'category', label: 'Menu category', render: (row) => row.category ?? 'No menu category' },
          { key: 'revenue', label: 'Revenue', align: 'right', render: (row) => <Money amount={row.revenue} currencyCode={activeProperty.base_currency} /> },
          { key: 'cost', label: 'Cost', align: 'right', render: (row) => moneyOrUnknown(row.cost, activeProperty.base_currency) },
          { key: 'margin', label: 'Margin', align: 'right', render: (row) => moneyOrUnknown(row.margin, activeProperty.base_currency) },
        ]}
        rows={margin?.byCategory ?? []}
        rowKey={(row) => row.category ?? '__none__'}
      />
    </div>
  );
}
