import { request } from './client.js';

/**
 * PLAN.md Phase 2.5's cashiering module. Same shape as `reservations.js`:
 * plain exported functions, each a thin wrapper over `request()`, matching
 * the real backend response shapes in `backend/src/modules/cashiering`.
 *
 * Every mutation carries a fresh `Idempotency-Key` header (ARCHITECTURE.md
 * §7), the same "one key per logical attempt" pattern `reservations.js`
 * already established.
 */

function idempotencyKey() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------
// Folios
// ---------------------------------------------------------------------

export function listFoliosForReservation(reservationId) {
  return request(`/cashiering/reservations/${reservationId}/folios`);
}

export function getFolio(folioId) {
  return request(`/cashiering/folios/${folioId}`);
}

export function openAdditionalFolio(reservationId, billedTo) {
  return request(`/cashiering/reservations/${reservationId}/folios`, {
    method: 'POST',
    body: { billed_to: billedTo },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

export function moveLineItem(lineItemId, destinationFolioId) {
  return request(`/cashiering/line-items/${lineItemId}/move`, {
    method: 'POST',
    body: { destination_folio_id: destinationFolioId },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

// ---------------------------------------------------------------------
// Charges & adjustments
// ---------------------------------------------------------------------

/** @param {string} folioId @param {{type: 'room_charge'|'pos_charge', description: string, amount: string, businessDate?: string}} params */
export function postCharge(folioId, { type, description, amount, businessDate }) {
  return request(`/cashiering/folios/${folioId}/charges`, {
    method: 'POST',
    body: { type, description, amount, business_date: businessDate },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

/** @param {string} folioId @param {{description: string, amount: string, reason: string, relatedLineItemId?: string, businessDate?: string}} params */
export function postAdjustment(folioId, { description, amount, reason, relatedLineItemId, businessDate }) {
  return request(`/cashiering/folios/${folioId}/adjustments`, {
    method: 'POST',
    body: { description, amount, reason, related_line_item_id: relatedLineItemId, business_date: businessDate },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

export function voidLineItem(lineItemId, reason) {
  return request(`/cashiering/line-items/${lineItemId}/void`, {
    method: 'POST',
    body: { reason },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

// ---------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------

export function captureCashPayment(folioId, { amount, currency }) {
  return request(`/cashiering/folios/${folioId}/payments/cash`, {
    method: 'POST',
    body: { amount, currency },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

/** @param {string} folioId @param {{amount: string, currency: string, guestEmail: string, callbackUrl?: string}} params */
export function capturePaystackPayment(folioId, { amount, currency, guestEmail, callbackUrl }) {
  return request(`/cashiering/folios/${folioId}/payments/paystack`, {
    method: 'POST',
    body: { amount, currency, guest_email: guestEmail, callback_url: callbackUrl },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

export function startPaystackCheckout(paymentId, { guestEmail, callbackUrl }) {
  return request(`/cashiering/payments/${paymentId}/start-checkout`, {
    method: 'POST',
    body: { guest_email: guestEmail, callback_url: callbackUrl },
  });
}

export function verifyPayment(paymentId) {
  return request(`/cashiering/payments/${paymentId}/verify`, { method: 'POST', body: {} });
}

/** @param {string} paymentId @param {{amount?: string, reason: string}} params */
export function refundPayment(paymentId, { amount, reason }) {
  return request(`/cashiering/payments/${paymentId}/refund`, {
    method: 'POST',
    body: { amount, reason },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}
