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
// Stock item categories — gap closure, mirrors pos.js's menu-category
// wrappers exactly.
// ---------------------------------------------------------------------

/** The property's shared stock categories (matching the menu categories). Pass `outletId` for just the ones that outlet carries. */
export function listStockItemCategories({ includeArchived, outletId } = {}) {
  const params = new URLSearchParams();
  if (includeArchived) params.set('include_archived', 'true');
  if (outletId) params.set('outlet_id', String(outletId));
  const query = params.toString();
  return request(`/pos/stock/categories${query ? `?${query}` : ''}`);
}

export function createStockItemCategory({ outletId, name, sortOrder }) {
  return request('/pos/stock/categories', { method: 'POST', body: { outlet_id: outletId, name, sort_order: sortOrder } });
}

export function updateStockItemCategory(id, { name, sortOrder } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (sortOrder !== undefined) body.sort_order = sortOrder;
  return request(`/pos/stock/categories/${id}`, { method: 'PATCH', body });
}

export function archiveStockItemCategory(id) {
  return request(`/pos/stock/categories/${id}/archive`, { method: 'POST', body: {} });
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

export function createStockItem({ outletId, name, unit, category, purchaseCost, supplier, reorderLevel }) {
  return request('/pos/stock/items', {
    method: 'POST',
    body: { outlet_id: outletId, name, unit, category, purchase_cost: purchaseCost, supplier, reorder_level: reorderLevel },
  });
}

/** With `outletId`, a `reorderLevel` change is that outlet's own; without, it is the item's default. */
export function updateStockItem(id, { name, unit, category, supplier, reorderLevel, outletId } = {}) {
  const body = {};
  if (outletId !== undefined && outletId !== null) body.outlet_id = outletId;
  if (name !== undefined) body.name = name;
  if (unit !== undefined) body.unit = unit;
  if (category !== undefined) body.category = category;
  if (supplier !== undefined) body.supplier = supplier;
  if (reorderLevel !== undefined) body.reorder_level = reorderLevel;
  return request(`/pos/stock/items/${id}`, { method: 'PATCH', body });
}

export function archiveStockItem(id) {
  return request(`/pos/stock/items/${id}/archive`, { method: 'POST', body: {} });
}

/** `pos.stock_view` — a floor action, reachable by pos_operator. `reason` is mandatory (backend-enforced; validate non-blank client-side too). `outletId`: where it was lost (stock is counted per outlet). */
export function recordWastage(stockItemId, { outletId, quantity, reason }) {
  return request(`/pos/stock/items/${stockItemId}/wastage`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { outlet_id: outletId, quantity, reason },
  });
}

/**
 * Moves stock from one outlet to another — two ledger legs, written together
 * (`stock/service.js`'s `transferStock`). Refused outright if the source does
 * not hold enough. Idempotency-keyed like every other quantity-moving call.
 */
export function transferStock({ stockItemId, fromOutletId, toOutletId, quantity, note }) {
  return request('/pos/stock/transfers', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { stock_item_id: stockItemId, from_outlet_id: fromOutletId, to_outlet_id: toOutletId, quantity, note: note || undefined },
  });
}

/** Recent transfers, one row per transfer; `outletId` narrows to those in or out of that outlet. Quantities only, no cost. */
export function listTransfers({ outletId, limit } = {}) {
  const params = new URLSearchParams();
  if (outletId) params.set('outlet_id', outletId);
  if (limit) params.set('limit', limit);
  return request(`/pos/stock/transfers?${params}`);
}

/**
 * Stock requests — an outlet asks another (normally the store) for several
 * items; the storekeeper issues them, in full or in part, or rejects the
 * request with a reason. Issuing moves the stock immediately, as
 * transfers. `lines` is `[{stockItemId, quantity}]`; quantities are exact
 * decimal strings, never numbers.
 */
const toLineBodies = (lines) => lines.map((line) => ({ stock_item_id: line.stockItemId, quantity: line.quantity }));

/** `status`: pending | issued | rejected | cancelled (omit for all); `outletId` matches either side. */
export function listTransferRequests({ status, outletId, limit } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (outletId) params.set('outlet_id', outletId);
  if (limit) params.set('limit', limit);
  return request(`/pos/stock/transfer-requests?${params}`);
}

/** The outlets the signed-in user covers for stock requests: `{restricted: false}` or `{restricted: true, outletIds}`. */
export function getMyRequestOutlets() {
  return request('/pos/stock/transfer-requests/my-outlets');
}

/** One request by id — what a stock-request notification opens. */
export function getTransferRequest(requestId) {
  return request(`/pos/stock/transfer-requests/${requestId}`);
}

/** `topUpOfRequestId` — set by "Request the rest": the issued-short request this one asks the rest of. */
export function createTransferRequest({ fromOutletId, toOutletId, lines, note, topUpOfRequestId }) {
  return request('/pos/stock/transfer-requests', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: {
      from_outlet_id: fromOutletId,
      to_outlet_id: toOutletId,
      lines: toLineBodies(lines),
      note: note || undefined,
      top_up_of_request_id: topUpOfRequestId || undefined,
    },
  });
}

/** Every line of the request, once — `quantity` "0" for a line the store cannot send. */
export function issueTransferRequest(requestId, { lines, note }) {
  return request(`/pos/stock/transfer-requests/${requestId}/issue`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { lines: toLineBodies(lines), note: note || undefined },
  });
}

export function rejectTransferRequest(requestId, { reason }) {
  return request(`/pos/stock/transfer-requests/${requestId}/reject`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { reason },
  });
}

export function cancelTransferRequest(requestId, { reason } = {}) {
  return request(`/pos/stock/transfer-requests/${requestId}/cancel`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { reason: reason || undefined },
  });
}

/** Every outlet's quantity and reorder level for one stock item. */
export function listStockLevels(stockItemId) {
  return request(`/pos/stock/items/${stockItemId}/levels`);
}

// ---------------------------------------------------------------------
// Recipe / BOM
// ---------------------------------------------------------------------

export function listMenuItemComponents(menuItemId) {
  return request(`/pos/stock/menu-items/${menuItemId}/components`);
}

/** Every active menu item's recipe components, flattened — which stock items are sold in the Register. `outletId` optional. */
export function listMenuItemLinks({ outletId } = {}) {
  const query = outletId ? `?outlet_id=${encodeURIComponent(outletId)}` : '';
  return request(`/pos/stock/menu-links${query}`);
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
// Movement history — gap closure, backing Goods Received's own
// "recent deliveries" (a real backend function, previously never routed).
// ---------------------------------------------------------------------

/** Either `stockItemId` or `outletId` is required. Newest first, capped at `limit` (default 50). */
export function listStockMovements({ stockItemId, outletId, type, dateFrom, dateTo, limit } = {}) {
  const params = new URLSearchParams();
  if (stockItemId) params.set('stock_item_id', stockItemId);
  if (outletId) params.set('outlet_id', outletId);
  if (type) params.set('type', type);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  if (limit) params.set('limit', limit);
  return request(`/pos/stock/movements?${params}`);
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

/** Every active stock item and registered category, with the period's sold/received/wastage/adjustment figures — includes items with no movement. */
export function getStockOverview({ dateFrom, dateTo, outletId }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  if (outletId) params.set('outlet_id', outletId);
  return request(`/pos/stock/reports/overview?${params}`);
}

/** Gap closure: revenue, cost, and margin per menu item (and rolled up by category), grouped over the same date/outlet range. */
export function getCostOfSalesMargin({ dateFrom, dateTo, outletId }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  if (outletId) params.set('outlet_id', outletId);
  return request(`/pos/stock/reports/margin?${params}`);
}
