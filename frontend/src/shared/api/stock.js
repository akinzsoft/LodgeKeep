import { request } from './client.js';

/**
 * PLAN.md Phase 6's POS inventory & stock control module
 * (PRODUCT_REQUIREMENTS.md §3.4). Same shape as `pos.js`: plain exported
 * functions, each a thin wrapper over `request()`, matching the real
 * backend response shapes in `backend/src/modules/stock`.
 *
 * `recordWastage`, `recordGoodsReceived`, and `completeStockTake` each
 * carry a fresh `Idempotency-Key` header (ARCHITECTURE.md §7) — all three
 * go through the backend's own `runIdempotentMutation` (`stock/controller.js`'s
 * own header: "every real quantity-affecting" mutation, not only money).
 * Stock item CRUD, recipe upsert, and stock-take open/count/cancel are NOT
 * idempotency-gated — each is either plain configuration (naturally
 * idempotent on retry) or already made safe by its own upsert/gap-lock
 * shape, matching the backend controller's own documented reasoning.
 */

function idempotencyKey() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------
// Stock items
// ---------------------------------------------------------------------

export function listStockItems({ outletId, lowStockOnly } = {}) {
  const params = new URLSearchParams();
  if (outletId) params.set('outlet_id', outletId);
  if (lowStockOnly) params.set('low_stock', 'true');
  const query = params.toString();
  return request(`/pos/stock/items${query ? `?${query}` : ''}`);
}

export function createStockItem({ outletId, name, unit, purchaseCost, supplier, reorderLevel }) {
  return request('/pos/stock/items', {
    method: 'POST',
    body: { outlet_id: outletId, name, unit, purchase_cost: purchaseCost, supplier, reorder_level: reorderLevel },
  });
}

export function updateStockItem(id, { name, unit, supplier, reorderLevel } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (unit !== undefined) body.unit = unit;
  if (supplier !== undefined) body.supplier = supplier;
  if (reorderLevel !== undefined) body.reorder_level = reorderLevel;
  return request(`/pos/stock/items/${id}`, { method: 'PATCH', body });
}

export function archiveStockItem(id) {
  return request(`/pos/stock/items/${id}/archive`, { method: 'POST', body: {} });
}

/** `pos.stock_view` — a floor action, reachable by pos_operator. `reason` is mandatory (backend-enforced; validate non-blank client-side too). */
export function recordWastage(stockItemId, { quantity, reason }) {
  return request(`/pos/stock/items/${stockItemId}/wastage`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { quantity, reason },
  });
}

// ---------------------------------------------------------------------
// Recipe / BOM
// ---------------------------------------------------------------------

export function listMenuItemComponents(menuItemId) {
  return request(`/pos/stock/menu-items/${menuItemId}/components`);
}

/** Full replace-all upsert — `components`: `[{stockItemId, quantity}]`. */
export function upsertMenuItemComponents(menuItemId, components) {
  return request(`/pos/stock/menu-items/${menuItemId}/components`, {
    method: 'PUT',
    body: { components: components.map((c) => ({ stock_item_id: c.stockItemId, quantity: c.quantity })) },
  });
}

// ---------------------------------------------------------------------
// Goods received
// ---------------------------------------------------------------------

/** `lines`: `[{stockItemId, quantity, unitCost}]`. Response carries `{outletId, reference, count, items}`. */
export function recordGoodsReceived({ outletId, reference, lines }) {
  return request('/pos/stock/goods-received', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: {
      outlet_id: outletId,
      reference,
      lines: lines.map((line) => ({ stock_item_id: line.stockItemId, quantity: line.quantity, unit_cost: line.unitCost })),
    },
  });
}

// ---------------------------------------------------------------------
// Stock takes — blind counting
// ---------------------------------------------------------------------

export function listStockTakes({ outletId, status } = {}) {
  const params = new URLSearchParams();
  if (outletId) params.set('outlet_id', outletId);
  if (status) params.set('status', status);
  const query = params.toString();
  return request(`/pos/stock/takes${query ? `?${query}` : ''}`);
}

/** Returns `{stockTake, lines}`. `lines` carries `theoretical_quantity`/`variance` as `null` for every line until the take is completed — see file header. */
export function getStockTake(id) {
  return request(`/pos/stock/takes/${id}`);
}

export function openStockTake({ outletId }) {
  return request('/pos/stock/takes', { method: 'POST', body: { outlet_id: outletId } });
}

/** The operator's own blind input — never reveals `theoretical_quantity`/`variance` (both stay `null` in the response until `completeStockTake`). A plain upsert; recounting the same item before completion is a normal correction. */
export function recordStockTakeCount(stockTakeId, stockItemId, countedQuantity) {
  return request(`/pos/stock/takes/${stockTakeId}/lines/${stockItemId}`, { method: 'PATCH', body: { counted_quantity: countedQuantity } });
}

/** Reveals `theoretical_quantity`/`variance` for the first time — returns `{stockTake, lines}`. This cannot be undone. */
export function completeStockTake(stockTakeId) {
  return request(`/pos/stock/takes/${stockTakeId}/complete`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() }, body: {} });
}

export function cancelStockTake(stockTakeId, reason) {
  return request(`/pos/stock/takes/${stockTakeId}/cancel`, { method: 'POST', body: { reason } });
}

// ---------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------

export function getCostOfSales({ dateFrom, dateTo, outletId }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  if (outletId) params.set('outlet_id', outletId);
  return request(`/pos/stock/reports/cost-of-sales?${params}`);
}

export function getStockVariance({ dateFrom, dateTo, outletId }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  if (outletId) params.set('outlet_id', outletId);
  return request(`/pos/stock/reports/variance?${params}`);
}
