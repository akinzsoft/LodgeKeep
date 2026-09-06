import { request, requestWithMeta } from './client.js';

/**
 * Guest booking portal endpoint wrappers — PLAN.md Phase 4,
 * PRODUCT_REQUIREMENTS.md §3.14/§3.16. Every path is under `/portal`, which
 * `request()`'s own `BASE_URL` (`/api/v1`) already prefixes correctly —
 * no separate API client instance is needed: the staff app and the portal
 * app are never mounted in the same page load (`main.jsx`'s own pathname
 * fork picks exactly one), so the module-level token/refresh-handler
 * singleton `client.js` already uses is safe to share, just re-registered
 * with guest-shaped callbacks by `GuestAuthContext` instead of staff ones.
 *
 * Every mutation carries a fresh `Idempotency-Key` header (ARCHITECTURE.md
 * §7/§11), generated here rather than by the caller — the same
 * `crypto.randomUUID()` convention `reservations.js` already established,
 * so a screen never has to think about it.
 */

function idempotencyKey() {
  return crypto.randomUUID();
}

export function register({ propertySlug, email, password, firstName, lastName, phone }) {
  return request('/portal/auth/register', {
    method: 'POST',
    body: { property_slug: propertySlug, email, password, first_name: firstName, last_name: lastName, phone },
    auth: false,
  });
}

export function login({ propertySlug, email, password }) {
  return request('/portal/auth/login', {
    method: 'POST',
    body: { property_slug: propertySlug, email, password },
    auth: false,
  });
}

export function getPropertyBranding(propertySlug) {
  const params = new URLSearchParams({ property_slug: propertySlug });
  return request(`/portal/properties/branding?${params}`, { auth: false });
}

export function listRoomTypes(propertySlug) {
  const params = new URLSearchParams({ property_slug: propertySlug });
  return request(`/portal/room-types?${params}`, { auth: false });
}

export function listRateCodes(propertySlug) {
  const params = new URLSearchParams({ property_slug: propertySlug });
  return request(`/portal/rate-codes?${params}`, { auth: false });
}

export function checkAvailability({ propertySlug, roomTypeId, arrivalDate, departureDate }) {
  const params = new URLSearchParams({
    property_slug: propertySlug,
    room_type_id: roomTypeId,
    arrival_date: arrivalDate,
    departure_date: departureDate,
  });
  return request(`/portal/availability?${params}`, { auth: false });
}

/**
 * `callbackBaseUrl` (this app's own origin + confirmation-page route
 * prefix, no confirmation number appended) is all the client CAN supply —
 * the confirmation number doesn't exist until the backend creates the
 * reservation inside this same call, so the server appends it itself
 * before ever calling Paystack (`portal/controller.js`'s own
 * `respondWithCheckout`) rather than trusting a client-supplied full
 * redirect URL verbatim.
 *
 * Returns `{reservation, folio, payment, authorizationUrl, checkoutError,
 * retry}` — a flattened merge of `data` and `meta`, since the backend
 * response splits "the resource created" from "how the checkout attempt
 * went" across the two (`portal/controller.js`'s `respondWithCheckout`):
 * `authorizationUrl` on a clean 201, or `checkoutError`/`retry` on the
 * honest-202-partial-success path where the booking exists but Paystack's
 * own call failed.
 *
 * Anonymous — PRODUCT_REQUIREMENTS.md §3.16's "guest checkout without an account."
 */
export async function createAnonymousBooking({ propertySlug, roomTypeId, rateCodeId, arrivalDate, departureDate, adults, children, firstName, lastName, email, phone, callbackBaseUrl }) {
  const { data, meta } = await requestWithMeta('/portal/bookings', {
    method: 'POST',
    auth: false,
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: {
      property_slug: propertySlug,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: arrivalDate,
      departure_date: departureDate,
      adults,
      children,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      callback_base_url: callbackBaseUrl,
    },
  });
  return { ...data, ...meta };
}

/** Authenticated — the caller's own linked guest identity. Same `callbackBaseUrl`/return-shape reasoning as `createAnonymousBooking` above. */
export async function createAccountBooking({ propertySlug, roomTypeId, rateCodeId, arrivalDate, departureDate, adults, children, callbackBaseUrl }) {
  const { data, meta } = await requestWithMeta('/portal/account/bookings', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: {
      property_slug: propertySlug,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: arrivalDate,
      departure_date: departureDate,
      adults,
      children,
      callback_base_url: callbackBaseUrl,
    },
  });
  return { ...data, ...meta };
}

/** Public, session-independent — reachable from the emailed confirmation link or the Paystack callback with no login at all. */
export function getBookingByConfirmation({ propertySlug, confirmationNumber }) {
  const params = new URLSearchParams({ property_slug: propertySlug });
  return request(`/portal/bookings/${confirmationNumber}?${params}`, { auth: false });
}

export function confirmBookingPayment({ propertySlug, confirmationNumber }) {
  return request(`/portal/bookings/${confirmationNumber}/confirm`, {
    method: 'POST',
    auth: false,
    body: { property_slug: propertySlug },
  });
}

/** Returns `{...payment, authorizationUrl}` — same data/meta merge as `createAnonymousBooking` above. */
export async function retryStartCheckout({ propertySlug, confirmationNumber, email, callbackUrl }) {
  const { data, meta } = await requestWithMeta(`/portal/bookings/${confirmationNumber}/start-checkout`, {
    method: 'POST',
    auth: false,
    body: { property_slug: propertySlug, email, callback_url: callbackUrl },
  });
  return { ...data, ...meta };
}

export function listMyBookings() {
  return request('/portal/account/bookings');
}

export function getMyBooking(id) {
  return request(`/portal/account/bookings/${id}`);
}
