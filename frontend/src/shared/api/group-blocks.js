import { request } from './client.js';

/**
 * Group Blocks endpoint wrappers — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md
 * §3.8. Same shape as `ar.js`: plain exported functions, each a thin
 * wrapper over `request()`, matching the real backend response shapes in
 * `backend/src/modules/group-blocks`.
 *
 * Block CRUD and room-allocation writes carry no `Idempotency-Key` —
 * matching the backend's own plain, non-idempotency-wrapped shape for
 * those two (`group-blocks/controller.js`'s own header: a config value set
 * to X is naturally idempotent on retry). Only `billToSponsor` sends one —
 * it mutates several folios at once and is the one action in this module
 * ARCHITECTURE.md §7 actually requires it for.
 */

function idempotencyKey() {
  return crypto.randomUUID();
}

export function listGroupBlocks(status) {
  return request(`/group-blocks${status ? `?status=${status}` : ''}`);
}

export function getGroupBlock(id) {
  return request(`/group-blocks/${id}`);
}

/** @param {{blockName: string, companyProfileId?: string, startDate: string, endDate: string, cutoffDate?: string, notes?: string}} params */
export function createGroupBlock({ blockName, companyProfileId, startDate, endDate, cutoffDate, notes }) {
  return request('/group-blocks', {
    method: 'POST',
    body: { block_name: blockName, company_profile_id: companyProfileId, start_date: startDate, end_date: endDate, cutoff_date: cutoffDate, notes },
  });
}

/** @param {string} id @param {{blockName?: string, companyProfileId?: string, startDate?: string, endDate?: string, cutoffDate?: string, notes?: string, status?: 'active'|'cancelled'}} changes */
export function updateGroupBlock(id, { blockName, companyProfileId, startDate, endDate, cutoffDate, notes, status } = {}) {
  return request(`/group-blocks/${id}`, {
    method: 'PATCH',
    body: {
      block_name: blockName,
      company_profile_id: companyProfileId,
      start_date: startDate,
      end_date: endDate,
      cutoff_date: cutoffDate,
      notes,
      status,
    },
  });
}

export function listRoomAllocations(id) {
  return request(`/group-blocks/${id}/rooms`);
}

/** @param {string} id @param {{roomTypeId: string, stayDate?: string, startDate?: string, endDate?: string, roomsBlocked: number}} params Either `stayDate` alone or both `startDate`/`endDate`. */
export function upsertRoomAllocation(id, { roomTypeId, stayDate, startDate, endDate, roomsBlocked }) {
  return request(`/group-blocks/${id}/rooms`, {
    method: 'POST',
    body: { room_type_id: roomTypeId, stay_date: stayDate, start_date: startDate, end_date: endDate, rooms_blocked: roomsBlocked },
  });
}

export function getPickupSummary(id) {
  return request(`/group-blocks/${id}/pickup`);
}

/** Bills every eligible open, not-yet-billed folio among the block's rooming-list reservations to its sponsoring company — `backend/src/modules/group-blocks/service.js`'s `billBlockReservationsToSponsor`. */
export function billToSponsor(id) {
  return request(`/group-blocks/${id}/bill-to-sponsor`, {
    method: 'POST',
    body: {},
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}
