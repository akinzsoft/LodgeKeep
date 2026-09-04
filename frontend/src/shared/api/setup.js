import { request } from './client.js';

/**
 * PLAN.md Phase 1's setup module — property, room types, room inventory,
 * rate codes/calendar, taxes. Same shape as `auth.js`: plain exported
 * functions, each a thin wrapper over `request()`, matching the real
 * backend response shapes in `backend/src/modules/setup`.
 */

// ---------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------

export function listProperties() {
  return request('/properties');
}

export function createProperty(body) {
  return request('/properties', { method: 'POST', body });
}

export function updateProperty(id, body) {
  return request(`/properties/${id}`, { method: 'PATCH', body });
}

// ---------------------------------------------------------------------
// Room types
// ---------------------------------------------------------------------

export function listRoomTypes() {
  return request('/room-types');
}

export function createRoomType(body) {
  return request('/room-types', { method: 'POST', body });
}

export function updateRoomType(id, body) {
  return request(`/room-types/${id}`, { method: 'PATCH', body });
}

export function archiveRoomType(id) {
  return request(`/room-types/${id}/archive`, { method: 'POST' });
}

// ---------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------

export function listRooms() {
  return request('/rooms');
}

export function createRoom(body) {
  return request('/rooms', { method: 'POST', body });
}

/** @param {{room_type_id: string, floor?: string, from: string, to: string}} body */
export function bulkCreateRooms(body) {
  return request('/rooms/bulk', { method: 'POST', body });
}

export function updateRoom(id, body) {
  return request(`/rooms/${id}`, { method: 'PATCH', body });
}

// ---------------------------------------------------------------------
// Rate codes
// ---------------------------------------------------------------------

export function listRateCodes() {
  return request('/rate-codes');
}

export function createRateCode(body) {
  return request('/rate-codes', { method: 'POST', body });
}

export function updateRateCode(id, body) {
  return request(`/rate-codes/${id}`, { method: 'PATCH', body });
}

export function archiveRateCode(id) {
  return request(`/rate-codes/${id}/archive`, { method: 'POST' });
}

// ---------------------------------------------------------------------
// Rate calendar
// ---------------------------------------------------------------------

export function listRateCalendar({ rateCodeId, roomTypeId, from, to }) {
  const params = new URLSearchParams({ rate_code_id: rateCodeId, room_type_id: roomTypeId, from, to });
  return request(`/rate-calendar?${params}`);
}

/** @returns {Promise<{rate: string, overridden: boolean}>} TESTING.md SET-6. */
export function resolveRate({ rateCodeId, roomTypeId, stayDate }) {
  const params = new URLSearchParams({ rate_code_id: rateCodeId, room_type_id: roomTypeId, stay_date: stayDate });
  return request(`/rate-calendar/resolve?${params}`);
}

export function setRateOverride(body) {
  return request('/rate-calendar', { method: 'POST', body });
}

export function deleteRateOverride(id) {
  return request(`/rate-calendar/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------
// Taxes
// ---------------------------------------------------------------------

export function listTaxes() {
  return request('/taxes');
}

export function createTaxVersion(body) {
  return request('/taxes', { method: 'POST', body });
}
