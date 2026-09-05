import { request } from './client.js';

/**
 * PLAN.md Phase 3's housekeeping module. Same shape as `reservations.js`:
 * plain exported functions, each a thin wrapper over `request()`, matching
 * the real backend response shapes in `backend/src/modules/housekeeping`.
 * No `Idempotency-Key` on these mutations — housekeeping actions are
 * neither financial mutations nor reservation state transitions
 * (ARCHITECTURE.md §7's scope), the same reasoning the backend module's own
 * header gives for not wrapping them in `withIdempotency`.
 */

export function getBoard(businessDate) {
  const params = new URLSearchParams(businessDate ? { business_date: businessDate } : {});
  const query = params.toString();
  return request(`/housekeeping/board${query ? `?${query}` : ''}`);
}

/** @param {{roomId: string, attendantUserId: string, businessDate: string}} params */
export function createAssignment({ roomId, attendantUserId, businessDate }) {
  return request('/housekeeping/assignments', {
    method: 'POST',
    body: { room_id: roomId, attendant_user_id: attendantUserId, business_date: businessDate },
  });
}

/** @param {string} id @param {{attendantUserId?: string, status?: string}} changes */
export function updateAssignment(id, changes) {
  const body = {};
  if (changes.attendantUserId) body.attendant_user_id = changes.attendantUserId;
  if (changes.status) body.status = changes.status;
  return request(`/housekeeping/assignments/${id}`, { method: 'PATCH', body });
}

/** @param {string} roomId @param {{cleanliness: string, occupancyObserved: string}} params */
export function reportRoomStatus(roomId, { cleanliness, occupancyObserved }) {
  return request(`/housekeeping/rooms/${roomId}/status`, {
    method: 'POST',
    body: { cleanliness, occupancy_observed: occupancyObserved },
  });
}

/** @param {{resolved?: boolean}} [filters] */
export function listDiscrepancies(filters = {}) {
  const params = new URLSearchParams();
  if (filters.resolved !== undefined) params.set('resolved', String(filters.resolved));
  const query = params.toString();
  return request(`/housekeeping/discrepancies${query ? `?${query}` : ''}`);
}

export function resolveDiscrepancy(id, resolutionNote) {
  return request(`/housekeeping/discrepancies/${id}/resolve`, { method: 'POST', body: { resolution_note: resolutionNote } });
}

/** @param {{activeDate?: string}} [filters] */
export function listOutOfOrderPeriods(filters = {}) {
  const params = new URLSearchParams();
  if (filters.activeDate) params.set('active_date', filters.activeDate);
  const query = params.toString();
  return request(`/housekeeping/out-of-order${query ? `?${query}` : ''}`);
}

/** @param {{roomId: string, type: string, reason: string, startDate: string, endDate: string}} params */
export function createOutOfOrderPeriod({ roomId, type, reason, startDate, endDate }) {
  return request('/housekeeping/out-of-order', {
    method: 'POST',
    body: { room_id: roomId, type, reason, start_date: startDate, end_date: endDate },
  });
}

export function closeOutOfOrderPeriod(id, endDate) {
  return request(`/housekeeping/out-of-order/${id}`, { method: 'PATCH', body: { end_date: endDate } });
}
