import { useEffect, useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

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

  async function runReports(event) {
    event?.preventDefault();
    setError(null);
    try {
      const [cos, varianceResult, marginResult] = await Promise.all([
        stockApi.getCostOfSales({ dateFrom, dateTo, outletId: outletId || undefined }),
        stockApi.getStockVariance({ dateFrom, dateTo, outletId: outletId || undefined }),
        stockApi.getCostOfSalesMargin({ dateFrom, dateTo, outletId: outletId || undefined }),
      ]);
      setCostOfSales(cos);
      setVariance(varianceResult);
      setMargin(marginResult);
    } catch (caught) {
      setCostOfSales(null);
      setVariance(null);
      setMargin(null);
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
          { key: 'category', label: 'Category', render: (row) => row.category ?? '—' },
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
        title="Cost-of-sales margin — by category"
        state={margin === null || margin.byCategory.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the reports."
        columns={[
          { key: 'category', label: 'Category', render: (row) => row.category ?? 'No category' },
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
