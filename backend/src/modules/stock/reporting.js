'use strict';

/**
 * Stock reporting — PLAN.md Phase 6. Both reads are `pos.stock_manage`-gated
 * (route layer) — a cost/margin figure is a manager-tier concern, matching
 * this pass's own confirmed RBAC split (stock CRUD/goods-received/stock-take
 * lifecycle are all `pos.stock_manage` too).
 */

const { scopedDb } = require('../../db');
const { sumMoney, negateMoney, toCents, fromCents } = require('../../shared/money');
const { sumQuantity, negateQuantity, extendedCost } = require('../../shared/quantity');
const { computeMenuItemSalesTotals } = require('../pos/sales-report');

/**
 * Cost of sales — the real cost side of every `sold`/`sale_reversal`
 * `stock_movements` row in range. `sale_reversal` is included
 * deliberately, not just `sold`: a settlement voided mid-period must
 * reduce the period's cost-of-sales exactly as much as the original sale
 * increased it (the two rows are, by construction, equal and opposite —
 * `reverseStockForSettlement` preserves the original's own cost basis).
 * Grouped both per stock item (drill-down) and per day (trend), the same
 * "a breakdown alongside a total" shape `reporting/service.js`'s own
 * `computeOccupancy`/`computeRevenue` already establish.
 *
 * `stock_movements.total_cost` is signed to match `quantity` — a `sold`
 * row's own total_cost is negative (it decreases current_quantity). This
 * report negates the aggregate so the reported figure reads as a
 * conventional positive cost, not the ledger's own signed convention.
 */
async function computeCostOfSales({ context, dateFrom, dateTo, outletId }) {
  const db = scopedDb().for(context);
  let query = db
    .table('stock_movements')
    .whereIn('type', ['sold', 'sale_reversal'])
    .whereBetween('business_date', [dateFrom, dateTo]);
  if (outletId) query = query.where({ outlet_id: outletId });
  const rows = await query.select('stock_item_id', 'business_date', 'total_cost');

  const byItem = new Map();
  const byDay = new Map();
  for (const row of rows) {
    const cost = row.total_cost ?? '0.00';
    const itemKey = String(row.stock_item_id);
    byItem.set(itemKey, sumMoney([byItem.get(itemKey) ?? '0.00', cost]));
    const dayKey = String(row.business_date);
    byDay.set(dayKey, sumMoney([byDay.get(dayKey) ?? '0.00', cost]));
  }

  // `stockItemId` stays a STRING throughout, matching ARCHITECTURE.md §10
  // ("IDs are serialized as strings in JSON") and this connection's own
  // `bigNumberStrings: true` setting — every BIGINT id already round-trips
  // as a string end to end, so coercing it to a JS number here would make
  // this one field the odd one out against every id a caller already
  // holds from an earlier response.
  const byItemArray = [...byItem.entries()]
    .map(([stockItemId, total]) => ({ stockItemId, cost: negateMoney(total) }))
    .sort((a, b) => Number(a.stockItemId) - Number(b.stockItemId));
  const byDayArray = [...byDay.entries()]
    .map(([date, total]) => ({ date, cost: negateMoney(total) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totalCost = negateMoney(sumMoney(rows.map((row) => row.total_cost ?? '0.00')));

  return { dateFrom, dateTo, outletId: outletId ?? null, totalCost, byItem: byItemArray, byDay: byDayArray };
}

/**
 * Stock variance — every COMPLETED stock take's own lines in range
 * (`stock_takes.business_date`, set only at completion — an open or
 * cancelled take contributes nothing). Individual lines for drill-down,
 * plus a per-item summary total variance across every completed take in
 * range, the same "breakdown plus summary" shape `computeCostOfSales`
 * above uses.
 */
async function computeStockVariance({ context, dateFrom, dateTo, outletId }) {
  const db = scopedDb().for(context);
  let query = db
    .table('stock_take_lines')
    .joinScoped('stock_takes', (join) => join.on('stock_takes.id', '=', 'stock_take_lines.stock_take_id'))
    .where('stock_takes.status', 'completed')
    .whereBetween('stock_takes.business_date', [dateFrom, dateTo]);
  if (outletId) query = query.where('stock_takes.outlet_id', outletId);

  const rows = await query.select(
    'stock_take_lines.id as line_id',
    'stock_take_lines.stock_take_id as stock_take_id',
    'stock_take_lines.stock_item_id as stock_item_id',
    'stock_take_lines.counted_quantity as counted_quantity',
    'stock_take_lines.theoretical_quantity as theoretical_quantity',
    'stock_take_lines.variance as variance',
    'stock_takes.business_date as business_date'
  );

  const summaryByItem = new Map();
  for (const row of rows) {
    const key = String(row.stock_item_id);
    summaryByItem.set(key, sumQuantity([summaryByItem.get(key) ?? '0.000', row.variance ?? '0.000']));
  }

  return {
    dateFrom,
    dateTo,
    outletId: outletId ?? null,
    lines: rows,
    summaryByItem: [...summaryByItem.entries()]
      .map(([stockItemId, totalVariance]) => ({ stockItemId, totalVariance }))
      .sort((a, b) => Number(a.stockItemId) - Number(b.stockItemId)),
  };
}

/** Money × a plain (non-fractional) integer count — the exact `computeItemLineTotal`/`pos-pricing.js` idiom, reused here for "cost per one unit sold" × "how many units sold." */
function multiplyMoneyByCount(moneyStr, count) {
  return fromCents(toCents(moneyStr) * BigInt(count));
}

/**
 * Cost-of-sales MARGIN — gap closure, user-requested. Unlike
 * `computeCostOfSales` above (which reads the historically-accurate
 * `stock_movements` ledger but only groups by STOCK ITEM, not by menu
 * item — a real constraint, since one stock item can be a component of
 * several different menu items, so its movements can't be attributed back
 * to a single selling price), this report is grouped by MENU ITEM, the
 * level margin is actually meaningful at: revenue is earned per menu item
 * sold, not per stock item consumed.
 *
 * Real revenue per menu item comes from `computeMenuItemSalesTotals`
 * (`pos/sales-report.js`) — the exact "what actually sold, excluding
 * voided checks/items" computation the Sales report's own top-sellers list
 * already uses.
 *
 * Cost per menu item (the confirmed priority): if the item has a real
 * recipe (`pos_menu_item_components`), cost = sum over its components of
 * (component quantity × that stock item's CURRENT `purchase_cost`),
 * multiplied by the quantity sold. Using CURRENT cost rather than a
 * historical per-sale snapshot is a deliberate, flagged simplification —
 * `stock_movements` snapshots cost per STOCK ITEM per settlement, not per
 * menu item, so reconstructing a true historical per-menu-item cost would
 * need a new stock_movements-to-order-item link this pass was not asked to
 * build. A recipe's own ingredient quantities rarely change and
 * `purchase_cost` only moves on a new delivery, so this is a reasonable
 * approximation, not treated as exact. A menu item with NO recipe falls
 * back to its own `cost_price` (also current-value, never historical —
 * that column carries no history at all). A menu item with neither a
 * recipe nor a `cost_price` reports `cost: null`/`margin: null` — a
 * genuinely unknown cost is never silently treated as free.
 *
 * Grouped by menu item (the report's own primary breakdown) and rolled up
 * by the menu item's own `category` (already a real column, unrelated to
 * this pass's new `stock_items.category`) — the same "breakdown plus
 * summary" shape `computeCostOfSales`/`computeStockVariance` above already
 * establish.
 */
async function computeCostOfSalesMargin({ context, dateFrom, dateTo, outletId }) {
  const db = scopedDb().for(context);
  const property = await db.table('properties').where({ id: context.propertyId }).first('base_currency');

  const sales = await computeMenuItemSalesTotals({ db, dateFrom, dateTo, outletId });
  if (sales.length === 0) {
    return { dateFrom, dateTo, outletId: outletId ?? null, currency: property?.base_currency ?? null, byMenuItem: [], byCategory: [], totals: { revenue: '0.00', cost: '0.00', margin: '0.00' } };
  }

  const menuItemIds = sales.map((row) => row.menuItemId);
  const menuItems = await db.table('pos_menu_items').whereIn('id', menuItemIds).select('id', 'category', 'cost_price');
  const menuItemById = new Map(menuItems.map((row) => [String(row.id), row]));

  const components = await db.table('pos_menu_item_components').whereIn('menu_item_id', menuItemIds).select('menu_item_id', 'stock_item_id', 'quantity');
  const stockItemIds = [...new Set(components.map((row) => row.stock_item_id))];
  const stockItems = stockItemIds.length ? await db.table('stock_items').whereIn('id', stockItemIds).select('id', 'purchase_cost') : [];
  const purchaseCostByStockItem = new Map(stockItems.map((row) => [String(row.id), row.purchase_cost]));
  const componentsByMenuItem = new Map();
  for (const component of components) {
    const key = String(component.menu_item_id);
    if (!componentsByMenuItem.has(key)) componentsByMenuItem.set(key, []);
    componentsByMenuItem.get(key).push(component);
  }

  const byMenuItem = sales.map((row) => {
    const menuItem = menuItemById.get(String(row.menuItemId));
    const recipe = componentsByMenuItem.get(String(row.menuItemId));
    let unitCost = null;
    let costSource = 'unknown';
    if (recipe && recipe.length) {
      unitCost = sumMoney(recipe.map((component) => extendedCost(purchaseCostByStockItem.get(String(component.stock_item_id)) ?? '0.00', component.quantity)));
      costSource = 'recipe';
    } else if (menuItem?.cost_price != null) {
      unitCost = menuItem.cost_price;
      costSource = 'cost_price';
    }
    const cost = unitCost === null ? null : multiplyMoneyByCount(unitCost, row.quantity);
    const margin = cost === null ? null : sumMoney([row.revenue, negateMoney(cost)]);
    const marginPct = cost === null || row.revenue === '0.00' ? null : (Number(margin) / Number(row.revenue)) * 100;
    return {
      menuItemId: row.menuItemId,
      name: row.name,
      category: menuItem?.category ?? null,
      quantity: row.quantity,
      revenue: row.revenue,
      cost,
      costSource,
      margin,
      marginPct,
    };
  });

  const byCategoryMap = new Map();
  for (const row of byMenuItem) {
    const key = row.category ?? '';
    if (!byCategoryMap.has(key)) byCategoryMap.set(key, { category: row.category, revenue: [], cost: [], hasUnknownCost: false });
    const bucket = byCategoryMap.get(key);
    bucket.revenue.push(row.revenue);
    if (row.cost === null) bucket.hasUnknownCost = true;
    else bucket.cost.push(row.cost);
  }
  const byCategory = [...byCategoryMap.values()]
    .map(({ category, revenue, cost, hasUnknownCost }) => {
      const revenueTotal = sumMoney(revenue);
      const costTotal = cost.length ? sumMoney(cost) : hasUnknownCost ? null : '0.00';
      return {
        category,
        revenue: revenueTotal,
        cost: costTotal,
        margin: costTotal === null ? null : sumMoney([revenueTotal, negateMoney(costTotal)]),
      };
    })
    .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? ''));

  const knownCosts = byMenuItem.filter((row) => row.cost !== null);
  const totalRevenue = sumMoney(byMenuItem.map((row) => row.revenue));
  const totalCost = sumMoney(knownCosts.map((row) => row.cost));
  const totals = {
    revenue: totalRevenue,
    cost: totalCost,
    margin: sumMoney([totalRevenue, negateMoney(totalCost)]),
    itemsWithUnknownCost: byMenuItem.length - knownCosts.length,
  };

  return {
    dateFrom,
    dateTo,
    outletId: outletId ?? null,
    currency: property?.base_currency ?? null,
    byMenuItem: byMenuItem.sort((a, b) => a.name.localeCompare(b.name)),
    byCategory,
    totals,
  };
}

/**
 * Stock overview by category — every ACTIVE stock item and every registered
 * stock category, whether or not anything moved in the range. The other
 * reports here are ledger-driven (they only show what has a movement row),
 * so an item just created, never sold, or an empty category was simply
 * absent from them (user-reported: "ensure all in stock — categories and
 * items — report in stock"). This report starts from the items and
 * categories themselves and folds the period's movements onto them, so
 * nothing is left out, and adds each item's own category — which no other
 * report carried.
 *
 * Per item (all quantities in the item's own unit, all exact decimals):
 * `soldQty`/`soldCost` (net of reversals — this is what Register sales did
 * to stock), `receivedQty`, `wastageQty`/`wastageCost`, and the signed
 * stock-take `adjustmentQty`, plus its current on-hand and reorder level.
 * Per category: how many items, how many are at/below reorder level, and
 * the period's sold/wastage cost (cost only — quantities in different
 * units are never summed). Uncategorized items, and an item whose category
 * is no longer registered (archived), get their own rows so nothing is
 * hidden. `stock_movements.quantity`/`total_cost` are signed (a sale
 * decreases stock), so sold and wastage figures are negated to read as
 * positive amounts, the same convention `computeCostOfSales` uses.
 */
async function computeStockOverview({ context, dateFrom, dateTo, outletId }) {
  const db = scopedDb().for(context);

  // Sequential reads, joined in JS (this codebase never runs parallel queries on one accessor).
  const categories = await db.table('stock_item_categories').where({ status: 'active' }).orderBy('sort_order').orderBy('name').select('name');
  let itemQuery = db.table('stock_items').where({ status: 'active' });
  if (outletId) itemQuery = itemQuery.where({ outlet_id: outletId });
  const items = await itemQuery.select('id', 'outlet_id', 'name', 'unit', 'category', 'current_quantity', 'reorder_level', 'purchase_cost');

  let movementQuery = db.table('stock_movements').whereBetween('business_date', [dateFrom, dateTo]);
  if (outletId) movementQuery = movementQuery.where({ outlet_id: outletId });
  const movements = await movementQuery.select('stock_item_id', 'type', 'quantity', 'total_cost');

  const totals = new Map();
  const bucket = (id) => {
    const key = String(id);
    if (!totals.has(key)) totals.set(key, { sold: [], soldCost: [], received: [], wastage: [], wastageCost: [], adjustment: [] });
    return totals.get(key);
  };
  for (const row of movements) {
    const entry = bucket(row.stock_item_id);
    const quantity = row.quantity ?? '0.000';
    const cost = row.total_cost ?? '0.00';
    if (row.type === 'sold' || row.type === 'sale_reversal') {
      entry.sold.push(quantity);
      entry.soldCost.push(cost);
    } else if (row.type === 'received') {
      entry.received.push(quantity);
    } else if (row.type === 'wastage') {
      entry.wastage.push(quantity);
      entry.wastageCost.push(cost);
    } else if (row.type === 'count_adjustment') {
      entry.adjustment.push(quantity);
    }
  }

  const itemRows = items.map((item) => {
    const entry = totals.get(String(item.id)) ?? bucket(item.id);
    const currentQuantity = item.current_quantity ?? '0.000';
    const reorderLevel = item.reorder_level ?? '0.000';
    return {
      stockItemId: String(item.id),
      outletId: String(item.outlet_id),
      name: item.name,
      unit: item.unit,
      category: item.category ?? null,
      currentQuantity,
      reorderLevel,
      purchaseCost: item.purchase_cost,
      atOrBelowReorder: Number(reorderLevel) > 0 && Number(currentQuantity) <= Number(reorderLevel),
      soldQty: negateQuantity(sumQuantity(entry.sold)),
      soldCost: negateMoney(sumMoney(entry.soldCost)),
      receivedQty: sumQuantity(entry.received),
      wastageQty: negateQuantity(sumQuantity(entry.wastage)),
      wastageCost: negateMoney(sumMoney(entry.wastageCost)),
      adjustmentQty: sumQuantity(entry.adjustment),
    };
  });

  // One row per registered category (display order), then Uncategorized, then any category an item still names that is no longer registered.
  const registered = categories.map((row) => row.name);
  const registeredSet = new Set(registered);
  const unregistered = [...new Set(itemRows.map((row) => row.category).filter((name) => name !== null && !registeredSet.has(name)))].sort();
  const categoryOrder = [...registered, null, ...unregistered];
  const orderOf = new Map(categoryOrder.map((name, index) => [name, index]));

  const byCategory = categoryOrder.map((name) => {
    const rows = itemRows.filter((row) => row.category === name);
    return {
      category: name,
      registered: name === null ? null : registeredSet.has(name),
      itemCount: rows.length,
      lowStockCount: rows.filter((row) => row.atOrBelowReorder).length,
      soldCost: sumMoney(rows.map((row) => row.soldCost)),
      wastageCost: sumMoney(rows.map((row) => row.wastageCost)),
    };
  });

  itemRows.sort((a, b) => orderOf.get(a.category) - orderOf.get(b.category) || a.name.localeCompare(b.name));

  return {
    dateFrom,
    dateTo,
    outletId: outletId ?? null,
    totals: { itemCount: itemRows.length, soldCost: sumMoney(itemRows.map((row) => row.soldCost)), wastageCost: sumMoney(itemRows.map((row) => row.wastageCost)) },
    byCategory,
    items: itemRows,
  };
}

module.exports = { computeCostOfSales, computeStockVariance, computeCostOfSalesMargin, computeStockOverview };
