'use strict';

/**
 * HttpOnly delivery for the staff refresh token — closes the gap
 * `tokens.js`'s own header and `AuthContext.jsx`'s header both flagged since
 * Phase 0: the backend returned the refresh token in the JSON response body
 * only, so the frontend's only place to hold it was an in-memory JS
 * variable — compliant with PRODUCT_REQUIREMENTS.md §3.16's "never
 * localStorage" rule, but wiped by every page reload, logging a real
 * front-desk shift out mid-task. An HttpOnly cookie survives a reload (the
 * browser manages it, not JS) AND is never readable by JS at all — strictly
 * stricter than the in-memory-only status quo it replaces, not a
 * relaxation.
 *
 * Scoped to `COOKIE_PATH` (every route under `/api/v1/auth`, where this
 * cookie is set or read) so the browser never attaches it to an unrelated
 * endpoint.
 *
 * `secure` is gated on `NODE_ENV`, the same production/non-production split
 * this codebase already uses for the MFA dev bypass (`mfa.js`) and the
 * password-reset dev-only token (`service.js`'s `requestPasswordReset`) — a
 * plain-HTTP local dev origin (`alpha-hotels.localhost:5173`) cannot receive
 * a `Secure` cookie at all, so hardcoding `secure: true` would silently
 * break every dev/test login. `sameSite: 'lax'`: this cookie is read only by
 * this same site's own `POST /auth/refresh` and `/auth/logout`, never a
 * cross-site request — `lax` is the standard, uncontroversial choice for a
 * same-site SPA's own session cookie, without `strict`'s edge cases around
 * top-level cross-site navigation.
 *
 * No cookie-parsing library is added for this: the value is always this
 * app's own base64url refresh token (`tokens.js`'s `issueRefreshToken`),
 * never arbitrary user input, so a minimal manual parse is enough — a full
 * RFC 6265 implementation (quoted values, duplicate names, etc.) buys
 * nothing here, the same "native platform capability, no library needed"
 * reasoning `crypto.randomUUID()` already gets elsewhere in this codebase.
 */

const COOKIE_NAME = 'lodgekeep_refresh_token';
const COOKIE_PATH = '/api/v1/auth';

function refreshTokenMaxAgeMs(hours) {
  return Math.round(hours * 60 * 60 * 1000);
}

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
    ...(maxAgeMs != null ? { maxAge: maxAgeMs } : {}),
  };
}

function setRefreshTokenCookie(res, token, { maxAgeMs } = {}) {
  res.cookie(COOKIE_NAME, token, cookieOptions(maxAgeMs));
}

/** `clearCookie` must be called with the SAME `path` (and other scoping attributes) the cookie was set with, or the browser treats it as a different cookie and leaves the original in place. */
function clearRefreshTokenCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

function readRefreshTokenCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim();
    if (key !== COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(separatorIndex + 1).trim());
  }
  return null;
}

module.exports = {
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  readRefreshTokenCookie,
  refreshTokenMaxAgeMs,
  COOKIE_NAME,
};
