import { request } from './client.js';

/**
 * Auth endpoint wrappers — the exact shapes `src/auth/controller.js` and
 * `src/auth/service.js` return on the backend, verified against a live
 * instance of that server (not guessed from reading the code). Kept
 * separate from `client.js` so that file stays endpoint-agnostic; every
 * future module (reservations, cashiering, ...) gets its own file like this
 * one here in `shared/api`, not a growing pile of `if (path === ...)` in the
 * generic client.
 *
 * None of these functions touch React state — `src/app/auth/AuthContext.jsx`
 * calls them and decides what to do with the result.
 */

/**
 * @returns {Promise<{status: 'ok', accessToken, tenantId, userId, activePropertyId, role, properties} | {status: 'mfa_challenge_required', challengeToken: string}>}
 *
 * Gap closure: the refresh token no longer travels in this response at all
 * — the backend sets it as an HttpOnly cookie instead (`Set-Cookie`,
 * `src/auth/refresh-cookie.js`), never JS-readable even transiently. That
 * cookie is what survives a page reload; nothing here needs to hold it.
 */
export function login({ email, password }) {
  return request('/auth/login', { method: 'POST', body: { email, password }, auth: false });
}

/**
 * Resumes a login `mfa_challenge_required` paused. The only code this can
 * ever succeed with is `src/auth/mfa.js`'s dev-only bypass value, and only
 * outside a production backend — see that file's own header. Any other
 * input returns the same `AUTH_MFA_NOT_IMPLEMENTED` 501 this endpoint has
 * always returned.
 *
 * @returns {Promise<{status: 'ok', accessToken, tenantId, userId, activePropertyId, role, properties}>}
 */
export function verifyMfa({ challengeToken, code }) {
  return request('/auth/mfa/verify', { method: 'POST', body: { challenge_token: challengeToken, code }, auth: false });
}

/**
 * `propertyId` is optional — see `src/auth/service.js`'s own note on why
 * this endpoint accepts it: `sessions` carries no property_id, so the active
 * property is restored (after server-side re-verification, never trusted
 * outright) only if the caller states what it currently has active.
 *
 * The refresh token itself is never passed here — it travels as the
 * HttpOnly cookie the browser attaches automatically (same-origin, via the
 * dev proxy or in production). This is also how a page reload restores a
 * session: nothing survives in memory, but the cookie does, so calling this
 * with no arguments at all is a valid "is there still a session?" probe —
 * see `AuthContext.jsx`'s mount-time bootstrap.
 *
 * @returns {Promise<{accessToken: string, tenantId: string, userId: string, activePropertyId: string|null, role: string|null, properties: Array<{propertyId: string, role: string}>}>}
 */
export function refresh({ propertyId } = {}) {
  return request('/auth/refresh', {
    method: 'POST',
    body: propertyId ? { property_id: propertyId } : {},
    auth: false,
  });
}

/** @returns {Promise<{revoked: boolean}>} */
export function logout() {
  return request('/auth/logout', { method: 'POST', body: {} });
}

/** @returns {Promise<{accessToken: string, activePropertyId: string, role: string}>} */
export function switchProperty({ propertyId }) {
  return request('/auth/switch-property', { method: 'POST', body: { property_id: propertyId } });
}

/** @returns {Promise<{status: 'ok', dev_only_token?: string}>} */
export function requestPasswordReset({ email }) {
  return request('/auth/password/forgot', { method: 'POST', body: { email }, auth: false });
}

/** @returns {Promise<{status: 'ok'}>} */
export function completePasswordReset({ token, newPassword }) {
  return request('/auth/password/reset', {
    method: 'POST',
    body: { token, new_password: newPassword },
    auth: false,
  });
}

/** PLAN.md Phase 1 gap closure — PRODUCT_REQUIREMENTS.md §3.16's staff invitation flow. @returns {Promise<{status: 'ok'}>} */
export function acceptInvitation({ token, firstName, lastName, password }) {
  return request('/auth/invitations/accept', {
    method: 'POST',
    body: { token, first_name: firstName, last_name: lastName, password },
    auth: false,
  });
}
