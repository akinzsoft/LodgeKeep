import { request, requestBlob } from './client.js';
import { approvalHeaders } from './approvals.js';

/**
 * Discounts, comps and their reasons/limits (backend `src/modules/discounts`). The client names a scope, a type, a
 * value and a reason; the SERVER works out every amount. Creating and approving carry an `Idempotency-Key`; an
 * approval carries the manager's token in the `X-Manager-Approval` header, never the body.
 */

const idempotencyKey = () => crypto.randomUUID();

export function listReasons({ includeArchived = false } = {}) {
  return request(`/discounts/reasons${includeArchived ? '?include_archived=true' : ''}`);
}

export function createReason({ code, name, kind }) {
  return request('/discounts/reasons', { method: 'POST', body: { code, name, kind } });
}

export function updateReason(id, changes) {
  return request(`/discounts/reasons/${id}`, { method: 'PATCH', body: changes });
}

/** `[{role, max_percent, is_default}]`. */
export function listLimits() {
  return request('/discounts/limits');
}

export function setLimit(role, maxPercent) {
  return request(`/discounts/limits/${role}`, { method: 'PUT', body: { max_percent: maxPercent } });
}

/** An open check's live discounts (pending and active), the active ones with their current amount. */
export function listOrderDiscounts(orderId) {
  return request(`/pos/orders/${orderId}/discounts`);
}

/**
 * `{scope: 'order'|'line', kind: 'discount'|'comp', type: 'percent'|'fixed', value, reasonId, itemId?, overrideReason?}`.
 * Resolves to the discount plus `amount`, `approvalRequired` and `approvalAction`.
 */
export function createOrderDiscount(orderId, { scope, kind, type, value, reasonId, itemId, overrideReason }) {
  return request(`/pos/orders/${orderId}/discounts`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { scope, kind, type, value, reason_id: reasonId, item_id: itemId, override_reason: overrideReason || undefined },
  });
}

/** A supermarket request, made against the cart BEFORE the sale: `items` is `[{menu_item_id, quantity}]`. */
export function createCartDiscount({ outletId, items, scope, kind, type, value, reasonId, menuItemId }) {
  return request('/supermarket/discounts', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { outlet_id: outletId, items, scope, kind, type, value, reason_id: reasonId, menu_item_id: menuItemId },
  });
}

/** Activates a pending discount with a manager's approval token (`approvalsApi.requestApproval`). */
export function approveDiscount(id, approval) {
  return request(`/discounts/${id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey(), ...approvalHeaders(approval) }, body: {} });
}

export function removeDiscount(id, reason, { overrideReason } = {}) {
  return request(`/discounts/${id}/remove`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() }, body: { reason, override_reason: overrideReason || undefined } });
}

export function getReport({ dateFrom, dateTo, outletId }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  if (outletId) params.set('outlet_id', outletId);
  return request(`/discounts/report?${params}`);
}

export function getReportCsv({ dateFrom, dateTo, outletId }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, format: 'csv' });
  if (outletId) params.set('outlet_id', outletId);
  return requestBlob(`/discounts/report?${params}`);
}
