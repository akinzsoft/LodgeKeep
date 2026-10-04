import { request, requestBlob, requestMultipart } from './client.js';

/**
 * Supermarket quick-sale endpoints (`backend/src/modules/supermarket`).
 * `createSale` and `voidSale` are financial mutations and carry an
 * `Idempotency-Key`; a retry of the SAME sale attempt reuses its key.
 */

export function listMyOutlets() {
  return request('/supermarket/my-outlets');
}

/** One product by scanned barcode at an outlet. */
export function lookupBarcode(outletId, barcode) {
  return request(`/supermarket/lookup?${new URLSearchParams({ outlet_id: outletId, barcode })}`);
}

/** Products at an outlet whose name contains `q`. */
export function searchItems(outletId, q) {
  return request(`/supermarket/lookup?${new URLSearchParams({ outlet_id: outletId, q })}`);
}

/**
 * Rings a sale. `items`: `[{menu_item_id | barcode, quantity}]`; `method`: 'cash' | 'terminal'.
 * Pass the same `idempotencyKey` when retrying the same attempt.
 */
export function createSale({ outletId, items, method, idempotencyKey }) {
  return request('/supermarket/sales', {
    method: 'POST',
    body: { outlet_id: outletId, items, method },
    headers: { 'Idempotency-Key': idempotencyKey ?? crypto.randomUUID() },
  });
}

export function getSale(id) {
  return request(`/supermarket/sales/${id}`);
}

export function listSales({ outletId, from, to } = {}) {
  const params = new URLSearchParams();
  if (outletId) params.set('outlet_id', outletId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request(`/supermarket/sales?${params}`);
}

export function getReport({ outletId, from, to } = {}) {
  const params = new URLSearchParams();
  if (outletId) params.set('outlet_id', outletId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request(`/supermarket/report?${params}`);
}

export function voidSale(id, reason) {
  return request(`/supermarket/sales/${id}/void`, { method: 'POST', body: { reason }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
}

/** Products at an outlet needing setup: no barcode and/or no stock recipe. */
export function getSetupFlags(outletId) {
  return request(`/supermarket/setup-flags?${new URLSearchParams({ outlet_id: outletId })}`);
}

/** Stock at or below its reorder level at an outlet, lowest first, for the till banner. */
export function getLowStock(outletId) {
  return request(`/supermarket/low-stock?${new URLSearchParams({ outlet_id: outletId })}`);
}

/** The caller's own sales on the current business date, for reprinting a receipt. */
export function listMySales(outletId) {
  return request(`/supermarket/my-sales?${new URLSearchParams({ outlet_id: outletId })}`);
}

/** Every barcode at the property with its product; with an outlet, `on_till` says whether that outlet sells it. */
export function listBarcodes(outletId) {
  return request(`/supermarket/barcodes?${new URLSearchParams(outletId ? { outlet_id: outletId } : {})}`);
}

/** Removes one barcode (the product, its sales and stock are untouched). */
export function removeBarcode(id) {
  return request(`/supermarket/barcodes/${id}`, { method: 'DELETE' });
}

export function addBarcode(menuItemId, barcode) {
  return request('/supermarket/barcodes', { method: 'POST', body: { menu_item_id: menuItemId, barcode } });
}

// ---------------------------------------------------------------- Stage 3: bulk CSV product import (supermarket.manage)

export function downloadProductsTemplate() {
  return requestBlob('/supermarket/imports/template');
}

/** Uploads the CSV for an outlet and runs the dry run straight away. Resolves `{run, errors, summary}`. */
export function uploadProductsImport({ outletId, file }) {
  const formData = new FormData();
  formData.append('outlet_id', outletId);
  formData.append('file', file);
  return requestMultipart('/supermarket/imports', formData);
}

/** `{run, errors, summary}` — `summary.kind` is 'predicted' before commit, 'imported' after. */
export function getProductsImport(id) {
  return request(`/supermarket/imports/${id}`);
}

export function listProductsImports(outletId) {
  return request(`/supermarket/imports?${new URLSearchParams({ outlet_id: outletId })}`);
}

export function commitProductsImport(id) {
  return request(`/supermarket/imports/${id}/commit`, { method: 'POST', body: {} });
}

/** Undo: removes the products nobody has touched since. Resolves `{status, rowsRolledBack, rowsRefused}`. */
export function rollbackProductsImport(id, reason) {
  return request(`/supermarket/imports/${id}/rollback`, { method: 'POST', body: { reason } });
}
