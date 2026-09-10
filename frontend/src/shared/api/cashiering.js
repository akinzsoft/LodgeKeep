import { request, requestWithMeta, requestBlob } from './client.js';

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

/**
 * Gap closure (user-reported): "see all outstanding balance of guest and
 * there room no" — PRODUCT_REQUIREMENTS.md's own "Open folios list," the
 * Cashier role's landing screen. Routed from `/front-desk/*`, not
 * `/cashiering/*` — it reuses `reservations/service.js`'s existing
 * guest+room join, the same as `listInHouse`/`listDepartures`, just gated
 * on a cashiering permission (see the backend route's own comment).
 */
export function listOutstandingBalances() {
  return request('/front-desk/outstanding-balances');
}

export function getOutstandingBalancesCsv() {
  return requestBlob('/front-desk/outstanding-balances?format=csv');
}

export function openAdditionalFolio(reservationId, billedTo) {
  return request(`/cashiering/reservations/${reservationId}/folios`, {
    method: 'POST',
    body: { billed_to: billedTo },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

/**
 * PLAN.md Phase 4 (Accounts Receivable) — routes (or un-routes, pass `null`)
 * an open folio to a company AR account (`ar.manage`-gated on the backend).
 */
export function billFolioToCompany(folioId, companyProfileId) {
  return request(`/cashiering/folios/${folioId}/bill-to-account`, {
    method: 'POST',
    body: { company_profile_id: companyProfileId },
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

/**
 * PLAN.md Phase 4 (Accounts Receivable): `overrideCreditLimit`/`overrideReason`
 * are optional and only meaningful when the target folio is billed to a
 * company account in `block` enforcement mode — the backend re-checks the
 * caller actually holds `ar.manage` before honoring an override
 * (`cashiering/controller.js`'s `assertCanOverrideCreditLimit`), so passing
 * these from a caller without that permission simply gets a real 403, never
 * a silent bypass.
 *
 * @param {string} folioId @param {{type: 'room_charge'|'pos_charge', description: string, amount: string, businessDate?: string, overrideCreditLimit?: boolean, overrideReason?: string}} params
 */
export function postCharge(folioId, { type, description, amount, businessDate, overrideCreditLimit, overrideReason }) {
  return request(`/cashiering/folios/${folioId}/charges`, {
    method: 'POST',
    body: {
      type,
      description,
      amount,
      business_date: businessDate,
      override_credit_limit: overrideCreditLimit,
      override_reason: overrideReason,
    },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

/** @param {string} folioId @param {{description: string, amount: string, reason: string, relatedLineItemId?: string, businessDate?: string, overrideCreditLimit?: boolean, overrideReason?: string}} params */
export function postAdjustment(folioId, { description, amount, reason, relatedLineItemId, businessDate, overrideCreditLimit, overrideReason }) {
  return request(`/cashiering/folios/${folioId}/adjustments`, {
    method: 'POST',
    body: {
      description,
      amount,
      reason,
      related_line_item_id: relatedLineItemId,
      business_date: businessDate,
      override_credit_limit: overrideCreditLimit,
      override_reason: overrideReason,
    },
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

/**
 * Gap closure (found while wiring "pay at the point of booking," not
 * previously flagged): the backend's `authorizationUrl` — and the
 * honest-202-partial-success path's `checkoutError`/`retry` — travel in
 * the response envelope's `meta`, never `data` (`controller.js`'s
 * `capturePaystackPayment`/`startCheckout`), the identical shape
 * `portal.js`'s own checkout endpoints already needed `requestWithMeta`
 * for. This function used plain `request()` until now, which silently
 * discards `meta` — meaning `authorizationUrl` could never have reached
 * any caller, including `CashieringScreen.jsx`'s own existing card-payment
 * button, which has therefore never actually worked. Flattened the same
 * way `portal.js` already does, so a caller never has to know which half
 * of the envelope a field came from.
 *
 * @param {string} folioId @param {{amount: string, currency: string, guestEmail: string, callbackUrl?: string}} params
 */
export async function capturePaystackPayment(folioId, { amount, currency, guestEmail, callbackUrl }) {
  const { data, meta } = await requestWithMeta(`/cashiering/folios/${folioId}/payments/paystack`, {
    method: 'POST',
    body: { amount, currency, guest_email: guestEmail, callback_url: callbackUrl },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
  return { ...data, ...meta };
}

export async function startPaystackCheckout(paymentId, { guestEmail, callbackUrl }) {
  const { data, meta } = await requestWithMeta(`/cashiering/payments/${paymentId}/start-checkout`, {
    method: 'POST',
    body: { guest_email: guestEmail, callback_url: callbackUrl },
  });
  return { ...data, ...meta };
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
