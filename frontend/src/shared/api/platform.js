import { request } from './client.js';

/**
 * Platform console endpoint wrappers — PLAN.md Phase 5 (Platform
 * Foundation). Same shape as every other `shared/api/*.js` file: plain
 * exported functions, each a thin wrapper over `request()`, matching the
 * real backend response shapes in `backend/src/modules/platform` and
 * `backend/src/auth`.
 *
 * `login`/`enrollConfirm`/`verifyMfa` all pass `auth: false` — no platform
 * session exists yet at any of these three steps.
 */

export function login(email, password) {
  return request('/platform/auth/login', { method: 'POST', body: { email, password }, auth: false });
}

export function enrollConfirm(enrollmentToken, code) {
  return request('/platform/auth/mfa/enroll/confirm', {
    method: 'POST',
    body: { enrollment_token: enrollmentToken, code },
    auth: false,
  });
}

export function verifyMfa(challengeToken, code) {
  return request('/platform/auth/mfa/verify', { method: 'POST', body: { challenge_token: challengeToken, code }, auth: false });
}

// ---------------------------------------------------------------------
// Tenant roster
// ---------------------------------------------------------------------

export function listTenants() {
  return request('/platform/tenants');
}

export function getTenant(id) {
  return request(`/platform/tenants/${id}`);
}

// ---------------------------------------------------------------------
// Impersonation
// ---------------------------------------------------------------------

/** @param {string} tenantId @param {{propertyId: string, reason: string}} params */
export function startImpersonation(tenantId, { propertyId, reason }) {
  return request(`/platform/tenants/${tenantId}/impersonate`, {
    method: 'POST',
    body: { property_id: propertyId, reason },
  });
}

export function listImpersonationSessionsForTenant(tenantId) {
  return request(`/platform/tenants/${tenantId}/impersonation-sessions`);
}

/**
 * Called with the IMPERSONATION-derived token itself (the caller must
 * `configureApiClient` to it first) — ending a grant is authorized by the
 * token's own identity, not a separate platform-side call.
 */
export function endImpersonation() {
  return request('/impersonation/end', { method: 'POST', body: {} });
}

/**
 * Tenant-side "who saw my account" visibility (SECURITY.md §2's "visible to
 * the tenant") — called with an ordinary STAFF token against the staff
 * route tree (`GET /impersonation-sessions`, `setup.view`-gated, backend
 * `platform/routes.js`'s `staffImpersonationRouter`), not the platform
 * console path above — a tenant's own admin has no platform-console access
 * at all. `tenantId`/property scope are both derived server-side from the
 * caller's own session, never a parameter here.
 */
export function listOwnImpersonationSessions() {
  return request('/impersonation-sessions');
}

// ---------------------------------------------------------------------
// Tenant lifecycle — PLAN.md Phase 5. Both `admin`-tier only server-side
// (`requirePlatformRole('admin')`) — a `support`-tier account gets a real
// 403 calling either, surfaced through TenantDetailScreen's own existing
// error-banner pattern, same as any other backend rejection.
// ---------------------------------------------------------------------

export function suspendTenant(tenantId, reason) {
  return request(`/platform/tenants/${tenantId}/suspend`, { method: 'POST', body: { reason } });
}

export function reactivateTenant(tenantId, reason) {
  return request(`/platform/tenants/${tenantId}/reactivate`, { method: 'POST', body: { reason: reason || undefined } });
}
