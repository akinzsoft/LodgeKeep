import { request } from './client.js';

/**
 * PLAN.md Phase 2's reservations + front desk module. Same shape as
 * `setup.js`: plain exported functions, each a thin wrapper over
 * `request()`, matching the real backend response shapes in
 * `backend/src/modules/reservations`.
 *
 * Every mutation carries a fresh `Idempotency-Key` header
 * (ARCHITECTURE.md §7/§11) — `crypto.randomUUID()` is a native browser API,
 * no library needed. Each wrapper mints its own key per call, matching "one
 * key per logical attempt" — a caller that wants a retry to reuse the same
 * key (so the backend replays rather than double-processes) generates the
 * key itself and is expected to pass it in, which none of these screens
 * need for this pass since there is no client-side retry logic yet.
 */

function idempotencyKey() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------

export function listGuests() {
  return request('/guests');
}

export function createGuest(body) {
  return request('/guests', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey() } });
}

// ---------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------

/** @param {{roomTypeId: string, arrivalDate: string, departureDate: string}} params */
export function checkAvailability({ roomTypeId, arrivalDate, departureDate }) {
  const params = new URLSearchParams({ room_type_id: roomTypeId, arrival_date: arrivalDate, departure_date: departureDate });
  return request(`/availability?${params}`);
}

/**
 * Gap closure (user-reported): rooms of a type genuinely eligible to be
 * offered as a "preferred room" for this date range — excludes a room
 * already committed (by preference or actual check-in) to another
 * overlapping-dates reservation. See the backend's own
 * `listEligiblePreferredRooms` header for the exact exclusion rule.
 * @param {{roomTypeId: string, arrivalDate: string, departureDate: string}} params
 */
export function listEligiblePreferredRooms({ roomTypeId, arrivalDate, departureDate }) {
  const params = new URLSearchParams({ room_type_id: roomTypeId, arrival_date: arrivalDate, departure_date: departureDate });
  return request(`/reservations/eligible-preferred-rooms?${params}`);
}

// ---------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------

export function createReservation(body) {
  return request('/reservations', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey() } });
}

/**
 * Gap closure (user-reported): "pay at the point of booking" — opens the
 * reservation's folio and posts its room charges before check-in, so
 * `cashieringApi`'s real cash/card capture endpoints have a real folio to
 * post against. See the backend's own `openBookingFolio` header for why
 * this stays a request, never a hold — the reservation is already
 * confirmed by the time this is called.
 * @returns {Promise<{id: string, balance: string, currency: string, status: string}>}
 */
export function openBookingFolio(id) {
  return request(`/reservations/${id}/open-folio`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': idempotencyKey() } });
}

export function getReservation(id) {
  return request(`/reservations/${id}`);
}

/** @param {{status?: string, arrivalDateFrom?: string, arrivalDateTo?: string, roomTypeId?: string}} [filters] */
export function listReservations(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.arrivalDateFrom) params.set('arrival_date_from', filters.arrivalDateFrom);
  if (filters.arrivalDateTo) params.set('arrival_date_to', filters.arrivalDateTo);
  if (filters.roomTypeId) params.set('room_type_id', filters.roomTypeId);
  const query = params.toString();
  return request(`/reservations${query ? `?${query}` : ''}`);
}

export function listWaitlist() {
  return request('/reservations/waitlist');
}

export function confirmReservation(id) {
  return request(`/reservations/${id}/confirm`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': idempotencyKey() } });
}

export function promoteWaitlist(id) {
  return request(`/reservations/${id}/promote-waitlist`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': idempotencyKey() } });
}

export function cancelReservation(id, reason) {
  return request(`/reservations/${id}/cancel`, { method: 'POST', body: { reason }, headers: { 'Idempotency-Key': idempotencyKey() } });
}

export function markNoShow(id) {
  return request(`/reservations/${id}/mark-no-show`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': idempotencyKey() } });
}

export function listNotes(id) {
  return request(`/reservations/${id}/notes`);
}

export function addNote(id, note) {
  return request(`/reservations/${id}/notes`, { method: 'POST', body: { note }, headers: { 'Idempotency-Key': idempotencyKey() } });
}

// ---------------------------------------------------------------------
// Front desk
// ---------------------------------------------------------------------

export function listArrivals() {
  return request('/front-desk/arrivals');
}

export function listDepartures() {
  return request('/front-desk/departures');
}

export function listInHouse() {
  return request('/front-desk/in-house');
}

/**
 * Gap closure: actual room numbers free as of the property's current
 * business date — see `backend/src/modules/reservations/service.js`'s
 * `listFreeRoomsNow` for why this is a distinct read from
 * `checkAvailability`'s aggregate sellable count. `roomTypeId` is optional —
 * omitted for check-in/room-move, which deliberately allow any room type
 * (an upgrade); supplied by the availability search, scoped to one type.
 * @param {string} [roomTypeId]
 */
export function listFreeRooms(roomTypeId) {
  const query = roomTypeId ? `?${new URLSearchParams({ room_type_id: roomTypeId })}` : '';
  return request(`/front-desk/free-rooms${query}`);
}

/** @param {string} id @param {{roomId: string, overrideDirty?: boolean}} params */
export function checkIn(id, { roomId, overrideDirty }) {
  return request(`/reservations/${id}/check-in`, {
    method: 'POST',
    body: { room_id: roomId, override_dirty: overrideDirty ?? false },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

/** @param {string} id @param {{scheduledCheckoutTime?: string, actualCheckoutTime?: string, earlyCutoffTime?: string, earlyDepartureFee?: string, lateCheckoutFee?: string}} [params] */
export function checkOut(id, params = {}) {
  return request(`/reservations/${id}/check-out`, {
    method: 'POST',
    body: {
      scheduled_checkout_time: params.scheduledCheckoutTime,
      actual_checkout_time: params.actualCheckoutTime,
      early_cutoff_time: params.earlyCutoffTime,
      early_departure_fee: params.earlyDepartureFee,
      late_checkout_fee: params.lateCheckoutFee,
    },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

/** @param {string} id @param {{newRoomId: string, reason: string}} params */
export function roomMove(id, { newRoomId, reason }) {
  return request(`/reservations/${id}/room-move`, {
    method: 'POST',
    body: { new_room_id: newRoomId, reason },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}
