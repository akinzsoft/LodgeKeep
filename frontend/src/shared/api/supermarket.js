import { request } from './client.js';

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
