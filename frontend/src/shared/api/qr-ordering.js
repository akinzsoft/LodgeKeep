import { request, requestWithMeta } from './client.js';

/**
 * QR self-ordering — guest-facing wrappers (PLAN.md Phase 6,
 * PRODUCT_REQUIREMENTS.md §3.4's QR-ordering section). Every path is under
 * `/qr-order`, fully anonymous (`auth: false` throughout, matching
 * `portal.js`'s own public-endpoint shape) — a guest scanning a physical QR
 * sticker has no account and no session, exactly the same "public, pre-auth"
 * reasoning `portal.js`'s own header documents for that module.
 *
 * `token` is the RAW token value from the scanned URL's own path segment
 * (`:token` in `QrOrderApp.jsx`'s routes) — never confused with the
 * encrypted/hashed forms only the backend ever sees.
 *
 * `createOrder`/`getMenu`/etc. match the real backend routes in
 * `backend/src/modules/qr-ordering/routes.js` exactly — this module was
 * written against that file and its controller, not a design blueprint (see
 * this branch's own PR description for the two real deviations: card
 * checkout is folded into order creation's own response rather than a
 * separate route, and there is no backend-provided `callback_url` needed
 * here at all — this app uses the SAME embedded, same-page Paystack popup
 * `shared/paystack.js` already established for staff/booking-screen card
 * payments, never a full-page redirect, so no callback URL is ever built or
 * sent).
 */

function idempotencyKey() {
  return crypto.randomUUID();
}

export function getMenu(token) {
  return request(`/qr-order/${token}/menu`, { auth: false });
}

/**
 * Mirrors `portalApi.getPropertyBranding` exactly in shape (`{name,
 * logoUrl, theme, baseCurrency}`) — both hit the identical backend query
 * (`portalService.getPropertyBranding`), just reached by a scanned token
 * instead of a property slug. This is what lets the shared
 * `BrandingProvider` (frontend/src/shared/branding/) serve this app and
 * the guest booking portal with the same component, not two.
 */
export function getBranding(token) {
  return request(`/qr-order/${token}/branding`, { auth: false });
}

/**
 * Returns `{...guestOrder, authorizationUrl, accessCode}` on a clean 201 (a
 * card order's Paystack intent was created and reached the gateway
 * successfully) or `{...guestOrder, checkoutError, retry}` on the honest
 * 202 partial-success path (the order is real and already committed, but
 * the gateway call itself failed) — the same `{...data, ...meta}` flattening
 * `portal.js`'s `createAnonymousBooking` already established for the
 * identical split-across-the-envelope shape.
 *
 * `items` is `[{menu_item_id, quantity, modifiers}]`. A fresh
 * `Idempotency-Key` (ARCHITECTURE.md §7) is generated here, not by the
 * caller — a flaky mobile connection retrying this call must not
 * double-order.
 */
export async function createOrder({ token, items, paymentMethod, guestContact, guestName }) {
  const { data, meta } = await requestWithMeta(`/qr-order/${token}/orders`, {
    method: 'POST',
    auth: false,
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { items, payment_method: paymentMethod, guest_contact: guestContact, guest_name: guestName },
  });
  return { ...data, ...meta };
}

export function getOrderStatus({ token, id }) {
  return request(`/qr-order/${token}/orders/${id}`, { auth: false });
}

/**
 * The guest's own retry path when the initial `createOrder` call couldn't
 * reach the gateway at all (the 202 partial-success case above). Same
 * `{...data, ...meta}` flattening — `data` here is the `payment` row, not
 * the guest order, matching the real backend response
 * (`qr-ordering/controller.js`'s `retryCheckout`).
 */
export async function retryCheckout({ token, id }) {
  const { data, meta } = await requestWithMeta(`/qr-order/${token}/orders/${id}/retry-checkout`, {
    method: 'POST',
    auth: false,
    body: {},
  });
  return { ...data, ...meta };
}

/**
 * Re-verifies a card order's payment against the real gateway — safe to
 * call any time the order's own `payment_status` is still `unpaid` (the
 * backend's own `applyGatewayResult`/`finalizePosOrderCardCapture` are both
 * idempotent by construction). Returns `{payment, guestOrder}`.
 */
export function confirmCardPayment({ token, id }) {
  return request(`/qr-order/${token}/orders/${id}/confirm-payment`, { method: 'POST', auth: false, body: {} });
}

/** Charge-to-room, step 1 — a masked name from the room's real in-house reservation ("Is this you?"), never the full name. */
export function confirmRoomChargeName({ token, id }) {
  return request(`/qr-order/${token}/orders/${id}/room-charge/confirm-name`, { auth: false });
}

/** Charge-to-room, step 2 — emails a real one-time code to the room's registered reservation contact. Returns `{devOnlyCode}` (non-null outside production only). */
export function requestRoomChargeOtp({ token, id }) {
  return request(`/qr-order/${token}/orders/${id}/room-charge/request-otp`, { method: 'POST', auth: false, body: {} });
}

/** Charge-to-room, step 3 — verifies the code and settles the order as a real folio charge. Returns `{order, settlements, guestOrder}`. */
export function verifyRoomChargeOtp({ token, id, code }) {
  return request(`/qr-order/${token}/orders/${id}/room-charge/verify`, { method: 'POST', auth: false, body: { code } });
}
