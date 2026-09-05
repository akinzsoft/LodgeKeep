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

export function deactivateUser(id) {
  return request(`/users/${id}/deactivate`, { method: 'POST' });
}

export function changeUserRole(id, role) {
  return request(`/users/${id}/role`, { method: 'PATCH', body: { role } });
}
