import { request } from './client.js';

/**
 * User-management endpoint wrappers — PLAN.md Phase 1 gap closure,
 * PRODUCT_REQUIREMENTS.md §3.19's "User & staff setup: create users, assign
 * roles, deactivate leavers." Same shape as `setup.js`.
 */

export function listUsers() {
  return request('/users');
}

export function listPendingInvitations() {
  return request('/users/pending-invitations');
}

export function inviteUser({ email, role }) {
  return request('/users/invite', { method: 'POST', body: { email, role } });
}

/** Issues a new link (the old one stops working), renews the expiry and re-sends. @returns {Promise<{invitation: object, email: {status: 'sent'|'failed'|'queued', reason: string|null}, dev_only_token: string|null}>} */
export function resendInvitation(id) {
  return request(`/users/invitations/${id}/resend`, { method: 'POST' });
}

/** Revokes a pending invitation: the link stops working and it leaves the list. */
export function revokeInvitation(id) {
  return request(`/users/invitations/${id}/revoke`, { method: 'POST' });
}

export function deactivateUser(id) {
  return request(`/users/${id}/deactivate`, { method: 'POST' });
}

export function changeUserRole(id, role) {
  return request(`/users/${id}/role`, { method: 'PATCH', body: { role } });
}

/**
 * The outlets a staff member works at (stock requests and their alerts only).
 * An empty list means every outlet. Replaces whatever was saved before.
 */
export function setUserOutlets(id, outletIds) {
  return request(`/users/${id}/outlets`, { method: 'PUT', body: { outlet_ids: outletIds } });
}
