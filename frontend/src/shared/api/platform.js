import { request, requestWithMeta } from './client.js';

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

/** Extends a trial by `days` (admin tier). Refused server-side for a tenant that has a subscription. */
export function extendTrial(tenantId, days, reason) {
  return request(`/platform/tenants/${tenantId}/extend-trial`, { method: 'POST', body: { days: Number(days), reason } });
}

/** Manual (cash / bank transfer / other) subscription — admin tier. The payment is validated server-side. */
export function markSubscribed(tenantId, payment) {
  return request(`/platform/tenants/${tenantId}/mark-subscribed`, { method: 'POST', body: payment });
}

/** Another manual payment for an already-subscribed manual tenant — extends paid-until (admin tier). */
export function recordPayment(tenantId, payment) {
  return request(`/platform/tenants/${tenantId}/record-payment`, { method: 'POST', body: payment });
}

/** Moves an ACTIVE tenant to the subscribed domain and e-mails every active user the new address (admin tier). Touches no status or billing. */
export function moveToNewDomain(tenantId, reason) {
  return request(`/platform/tenants/${tenantId}/move-domain`, { method: 'POST', body: { reason } });
}

/** Manually-paid subscriptions near or past their paid-until date (both tiers). Nothing is suspended automatically. */
export function listExpiringSubscriptions(withinDays = 14) {
  return request(`/platform/subscriptions/expiring?within_days=${encodeURIComponent(withinDays)}`);
}

/** PLAN.md Phase 5 (tenant offboarding) — the platform-initiated half; `src/modules/offboarding/service.js`'s own `requestOwnOffboarding` is the tenant self-service half. */
export function offboardTenant(tenantId, reason) {
  return request(`/platform/tenants/${tenantId}/offboard`, { method: 'POST', body: { reason: reason || undefined } });
}

/**
 * Whole-database backups (user-requested). `listBackups` → `{backups,
 * emailConfigured, emailProvider}`; `startBackup` answers at once with the
 * new row (`running`) — the history shows how it went.
 */
export async function listBackups() {
  const { data, meta } = await requestWithMeta('/platform/backups');
  return { backups: data, emailConfigured: Boolean(meta?.emailConfigured), emailProvider: meta?.emailProvider ?? null };
}

export function startBackup({ recipientEmail, passphrase }) {
  return request('/platform/backups', { method: 'POST', body: { recipient_email: recipientEmail, passphrase } });
}
