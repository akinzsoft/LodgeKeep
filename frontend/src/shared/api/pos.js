import { request } from './client.js';

/**
 * PLAN.md Phase 4's POS core module. Same shape as `cashiering.js`/
 * `reservations.js`: plain exported functions, each a thin wrapper over
 * `request()`, matching the real backend response shapes in
 * `backend/src/modules/pos`.
 *
 * `settleOrder`/`closeShift` carry a fresh `Idempotency-Key` header
 * (ARCHITECTURE.md §7) — both are financial mutations on the backend
 * (settlement posts real money; a retried shift-close must not ask an
 * operator to re-enter a cash count and get a different variance).
 */

function idempotencyKey() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------
// Outlets / terminals / menu items
// ---------------------------------------------------------------------

export function listOutlets() {
  return request('/pos/outlets');
}

export function createOutlet({ code, name, type }) {
  return request('/pos/outlets', { method: 'POST', body: { code, name, type } });
}

export function updateOutlet(id, changes) {
  return request(`/pos/outlets/${id}`, { method: 'PATCH', body: changes });
}

export function archiveOutlet(id) {
  return request(`/pos/outlets/${id}/archive`, { method: 'POST', body: {} });
}

export function listTerminals(outletId) {
  const params = outletId ? `?${new URLSearchParams({ outlet_id: outletId })}` : '';
  return request(`/pos/terminals${params}`);
}

export function createTerminal({ outletId, deviceRef, supportsContactless }) {
  return request('/pos/terminals', { method: 'POST', body: { outlet_id: outletId, device_ref: deviceRef, supports_contactless: supportsContactless } });
}

export function archiveTerminal(id) {
  return request(`/pos/terminals/${id}/archive`, { method: 'POST', body: {} });
}

export function listMenuItems(outletId) {
  const params = outletId ? `?${new URLSearchParams({ outlet_id: outletId })}` : '';
  return request(`/pos/menu-items${params}`);
}

export function createMenuItem({ outletId, name, category, price, modifiers }) {
  return request('/pos/menu-items', { method: 'POST', body: { outlet_id: outletId, name, category, price, modifiers } });
}

export function setMenuItemAvailability(id, isAvailable) {
  return request(`/pos/menu-items/${id}/set-availability`, { method: 'POST', body: { is_available: isAvailable } });
}

export function archiveMenuItem(id) {
  return request(`/pos/menu-items/${id}/archive`, { method: 'POST', body: {} });
}

// ---------------------------------------------------------------------
// Charge-to-room guest lookup
// ---------------------------------------------------------------------

export function findInHouseForCharge(query) {
  return request(`/pos/guests/in-house?${new URLSearchParams({ query })}`);
}

// ---------------------------------------------------------------------
// Orders (tabs)
// ---------------------------------------------------------------------

export function listOrders({ outletId, status } = {}) {
  const params = new URLSearchParams();
  if (outletId) params.set('outlet_id', outletId);
  if (status) params.set('status', status);
  const query = params.toString();
  return request(`/pos/orders${query ? `?${query}` : ''}`);
}

export function getOrder(id) {
  return request(`/pos/orders/${id}`);
}

export function openOrder({ outletId, terminalId, tableLabel }) {
  return request('/pos/orders', { method: 'POST', body: { outlet_id: outletId, terminal_id: terminalId, table_label: tableLabel } });
}

export function addItem(orderId, { menuItemId, quantity, modifiers }) {
  return request(`/pos/orders/${orderId}/items`, { method: 'POST', body: { menu_item_id: menuItemId, quantity, modifiers } });
}

export function voidOrderItem(orderId, itemId, reason) {
  return request(`/pos/orders/${orderId}/items/${itemId}/void`, { method: 'POST', body: { reason } });
}

export function assignItemSplitGroup(orderId, itemId, splitGroup) {
  return request(`/pos/orders/${orderId}/items/${itemId}/split-group`, { method: 'POST', body: { split_group: splitGroup } });
}

export function voidOrder(orderId, reason) {
  return request(`/pos/orders/${orderId}/void`, { method: 'POST', body: { reason } });
}

/** @param {Array<{splitGroup?: number|null, method: 'cash'|'card'|'room_charge', tipAmount?: string, serviceCharge?: string, roomCharge?: {reservationId: string, authMethod: string, authReference: string}}>} settlements */
export function settleOrder(orderId, settlements) {
  return request(`/pos/orders/${orderId}/settle`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: {
      settlements: settlements.map((s) => ({
        split_group: s.splitGroup ?? null,
        method: s.method,
        tip_amount: s.tipAmount,
        service_charge: s.serviceCharge,
        room_charge: s.roomCharge
          ? { reservation_id: s.roomCharge.reservationId, auth_method: s.roomCharge.authMethod, auth_reference: s.roomCharge.authReference }
          : undefined,
      })),
    },
  });
}

export function voidSettlement(orderId, settlementId, reason) {
  return request(`/pos/orders/${orderId}/settlements/${settlementId}/void`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { reason },
  });
}

// ---------------------------------------------------------------------
// Shifts — blind cash-up
// ---------------------------------------------------------------------

export function listShifts(terminalId) {
  const params = terminalId ? `?${new URLSearchParams({ terminal_id: terminalId })}` : '';
  return request(`/pos/shifts${params}`);
}

export function openShift({ terminalId, openingFloat }) {
  return request('/pos/shifts', { method: 'POST', body: { terminal_id: terminalId, opening_float: openingFloat } });
}

/** `countedCash` is the operator's own blind count — the response carries the computed `expected_cash`/`variance`, never exposed before this call. */
export function closeShift(shiftId, countedCash) {
  return request(`/pos/shifts/${shiftId}/close`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { counted_cash: countedCash },
  });
}
