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

// ---------------------------------------------------------------- vouchers

/** A manager's vouchers, newest first, with their use counts. */
export function listVouchers() {
  return request('/discounts/vouchers');
}

/**
 * `{type: 'percent'|'fixed', value, validTo, validFrom?, maxAmount?, maxTotalUses?, outletIds?, note?, overrideLimit?}`.
 * The SERVER generates the code and resolves to the voucher with it. `overrideLimit` needs comp authority.
 */
export function createVoucher({ type, value, validTo, validFrom, maxAmount, maxTotalUses, outletIds, note, overrideLimit }) {
  return request('/discounts/vouchers', {
    method: 'POST',
    body: {
      type,
      value,
      valid_to: validTo,
      valid_from: validFrom || undefined,
      max_amount: maxAmount || undefined,
      max_total_uses: maxTotalUses || undefined,
      outlet_ids: outletIds?.length ? outletIds : undefined,
      note: note || undefined,
      override_limit: overrideLimit ? true : undefined,
    },
  });
}

/**
 * Changes a voucher. Only the fields given are sent; the code never changes. A voucher that has been used refuses a new
 * type, amount or start date (409). `maxAmount: null` removes the cap, `maxTotalUses: null` removes the limit.
 */
export function updateVoucher(id, changes) {
  const body = {};
  if (changes.type !== undefined) body.type = changes.type;
  if (changes.value !== undefined) body.value = changes.value;
  if (changes.maxAmount !== undefined) body.max_amount = changes.maxAmount;
  if (changes.validFrom !== undefined) body.valid_from = changes.validFrom;
  if (changes.validTo !== undefined) body.valid_to = changes.validTo;
  if (changes.maxTotalUses !== undefined) body.max_total_uses = changes.maxTotalUses;
  if (changes.outletIds !== undefined) body.outlet_ids = changes.outletIds;
  if (changes.note !== undefined) body.note = changes.note;
  if (changes.overrideLimit) body.override_limit = true;
  return request(`/discounts/vouchers/${id}`, { method: 'PATCH', body });
}

/** Super admin only. Refused (409) once the voucher has ever been put on a check: disable it instead. */
export function deleteVoucher(id) {
  return request(`/discounts/vouchers/${id}/delete`, { method: 'POST', body: {} });
}

export function disableVoucher(id, reason) {
  return request(`/discounts/vouchers/${id}/disable`, { method: 'POST', body: { reason } });
}

export function enableVoucher(id) {
  return request(`/discounts/vouchers/${id}/enable`, { method: 'POST', body: {} });
}

/** The cashier types a code on an open Register check; nothing else is sent (the server knows the voucher's value). */
export function applyOrderVoucher(orderId, { code, overrideReason }) {
  return request(`/pos/orders/${orderId}/voucher`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { code, override_reason: overrideReason || undefined },
  });
}

/** A code typed at the supermarket till BEFORE the sale: `items` is `[{menu_item_id, quantity}]`. */
export function applyCartVoucher({ outletId, items, code }) {
  return request('/supermarket/voucher', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { outlet_id: outletId, items, code },
  });
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
