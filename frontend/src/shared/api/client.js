import { ApiError } from './ApiError.js';

/**
 * The API client — CLAUDE.md: "All network calls go through
 * /frontend/src/shared/api (the single place tenant context, auth headers,
 * and error handling are applied)." This file is that place. Every module
 * that talks to the backend (auth today; reservations, cashiering, ... once
 * they exist) calls `request()`, never `fetch` directly.
 *
 * ── TENANT CONTEXT ──────────────────────────────────────────────────────
 *
 * There is no tenant header to add here, deliberately: the backend resolves
 * `tenant_id` from the request's Host header
 * (`src/auth/tenant-resolution.js`), the same way a real browser visiting
 * `alpha-hotels.lodgekeep.app` naturally would (PRODUCT_REQUIREMENTS.md
 * §3.16). Sending a tenant identifier in a header from here would be exactly
 * the client-supplied-scope attack SECURITY.md §2 rules out, just moved from
 * a URL into a fetch header instead. The one exception is the backend's own
 * `X-Tenant-Slug` dev/test override, which is a developer visiting the app
 * from a plain `localhost` origin without the subdomain set up — that header
 * is set by whoever configures the dev environment (see `vite.config.js`'s
 * proxy comment), never by this file.
 *
 * ── AUTH HEADERS AND THE REFRESH-ON-EXPIRY HANDSHAKE ───────────────────────
 *
 * This module holds no token state itself — `configureApiClient()` registers
 * two callbacks the auth layer (`src/app/auth/AuthContext.jsx`) owns:
 * `getAccessToken` (read the current one) and `onAccessTokenExpired` (attempt
 * a refresh, return the new token or throw). That keeps this file usable by
 * any future module without importing React or knowing what "auth context"
 * means, and keeps AuthContext as the only place a token is ever stored.
 *
 * A request that comes back `401 AUTH_TOKEN_EXPIRED` is retried exactly
 * once, after a successful refresh — never for any other 401 (`AUTH_INVALID_CREDENTIALS`,
 * `AUTH_WRONG_AUDIENCE`, `AUTH_SESSION_INVALID`, `AUTH_UNAUTHENTICATED`), each
 * of which means something a silent retry cannot fix.
 *
 * ── AN UNRECOVERABLE AUTH FAILURE, FOR A CALLER WITH NO REFRESH PATH ─────
 *
 * `accessTokenExpiredHandler` presupposes a way to get a new token (the
 * staff app's HttpOnly refresh cookie). A population with no refresh path
 * at all (the platform console / an impersonation grant — access-token-only
 * by design, `PlatformAuthContext.jsx`'s own header) has nothing to retry
 * with, so any `AUTH_*` rejection there means the session is simply over.
 * `authenticationFailedHandler`, when registered, is called (best-effort,
 * never awaited, never allowed to mask the original error) on any `AUTH_*`
 * failure that a retry cannot or did not resolve — the caller still receives
 * the thrown `ApiError` to show its own message; this is purely the
 * "the session itself is gone, tear it down" side effect, decoupled from
 * any one call site's own error handling.
 */

let getAccessToken = () => null;
let onAccessTokenExpired = null;
let onAuthenticationFailed = null;

/**
 * @param {() => string|null} accessTokenGetter
 * @param {() => Promise<string>} accessTokenExpiredHandler   Resolves with a new access token, or throws/rejects if the session cannot be refreshed.
 * @param {(error: import('./ApiError.js').ApiError) => void} [authenticationFailedHandler]   Best-effort session teardown for an AUTH_* failure a retry cannot fix (no refresh path, or the refresh itself failed).
 */
export function configureApiClient({ accessTokenGetter, accessTokenExpiredHandler, authenticationFailedHandler }) {
  getAccessToken = accessTokenGetter;
  onAccessTokenExpired = accessTokenExpiredHandler;
  onAuthenticationFailed = authenticationFailedHandler ?? null;
}

/** Test-only reset, so one test file's registration cannot leak into the next. */
export function _resetApiClientForTesting() {
  getAccessToken = () => null;
  onAccessTokenExpired = null;
  onAuthenticationFailed = null;
}

const BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) || '/api/v1';

async function doFetch(path, { method = 'GET', body, token, headers } = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      // Gap closure: the staff refresh token now travels as an HttpOnly
      // cookie (`src/auth/refresh-cookie.js`), not a body field — `fetch`
      // must be told to send/accept cookies for that to work. Explicit
      // rather than relying on the platform default (`'same-origin'` as of
      // the current fetch spec, but this file's own precedent — see
      // `vite.config.js`'s proxy comment — is to never leave a
      // security-relevant default unstated).
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch throws (TypeError) on a genuine network failure — no response of
    // any shape exists to parse. This is the one ApiError this file invents
    // rather than relays.
    throw new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server. Check your connection.' });
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: 'The server returned an unreadable response.',
      status: response.status,
    });
  }

  if (envelope.error) {
    throw new ApiError({ ...envelope.error, status: response.status });
  }

  return envelope;
}

/**
 * @param {string} path            e.g. "/auth/login" — joined to BASE_URL, never a full URL.
 * @param {object} [options]
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} [options.method]
 * @param {object} [options.body]
 * @param {boolean} [options.auth]   Attach the current access token. Defaults to true — most endpoints need one; the few that don't (login, refresh, password reset) opt out explicitly, so a missing token is a deliberate choice at the call site, not an oversight.
 * @param {object} [options.headers]  Extra headers — e.g. `Idempotency-Key` (ARCHITECTURE.md §7/§11), required on every reservation/front-desk mutation.
 */
export async function request(path, options) {
  const { data } = await requestEnvelope(path, options);
  return data;
}

/**
 * Same request/retry-on-expiry mechanics as `request()`, but returns the
 * envelope's `meta` alongside `data` instead of discarding it. Most
 * endpoints have no reason to read `meta` — `request()` stays the default —
 * but a few (e.g. `portal.js`'s booking-checkout calls, which carry
 * `authorizationUrl` in `meta` since it isn't a property of the created
 * resource itself) genuinely need it.
 */
export async function requestWithMeta(path, options) {
  const { data, meta } = await requestEnvelope(path, options);
  return { data, meta };
}

async function requestEnvelope(path, { method = 'GET', body, auth = true, headers } = {}) {
  const token = auth ? getAccessToken() : undefined;

  try {
    return await doFetch(path, { method, body, token, headers });
  } catch (error) {
    if (auth && error instanceof ApiError && error.code === 'AUTH_TOKEN_EXPIRED' && onAccessTokenExpired) {
      return await doFetch(path, { method, body, token: await onAccessTokenExpired(), headers });
    }
    // Reached either because there was nothing to retry with (no expired-token
    // handler at all — the platform/impersonation case) or the retry branch
    // above never matched (a non-expiry AUTH_* code, e.g. AUTH_SESSION_INVALID
    // for a deactivated account or an ended impersonation grant). Either way
    // the session itself is unusable; tear it down, then still let the
    // original error reach this call's own catch block.
    if (auth && error instanceof ApiError && typeof error.code === 'string' && error.code.startsWith('AUTH_') && onAuthenticationFailed) {
      onAuthenticationFailed(error);
    }
    throw error;
  }
}

/**
 * A non-JSON GET — PLAN.md Phase 3's report CSV exports (PRODUCT_REQUIREMENTS.md
 * §3.11's "every report exportable to ... Excel/CSV"). `request()` always
 * parses the `{data,meta,error}` envelope, which a CSV body does not have,
 * so this is a second, parallel path through the same auth-header and
 * refresh-on-expiry handling rather than a raw `fetch` at the call site —
 * "the one place ... auth headers ... are applied" (CLAUDE.md) still holds.
 * Returns a `Blob`; the caller is responsible for turning it into a
 * download (an object URL + a synthetic click, since a plain `<a href>` has
 * no way to attach an Authorization header).
 */
async function doFetchBlob(path, token) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server. Check your connection.' });
  }
  if (!response.ok) {
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new ApiError({ code: 'NETWORK_ERROR', message: 'The server returned an unreadable response.', status: response.status });
    }
    throw new ApiError({ ...envelope.error, status: response.status });
  }
  return response.blob();
}

export async function requestBlob(path) {
  const token = getAccessToken();
  try {
    return await doFetchBlob(path, token);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AUTH_TOKEN_EXPIRED' && onAccessTokenExpired) {
      const refreshedToken = await onAccessTokenExpired();
      return doFetchBlob(path, refreshedToken);
    }
    throw error;
  }
}

/**
 * A multipart file upload — Data Migration's `POST /migration/imports`
 * (`backend/src/modules/migration/routes.js`'s first-ever `multer` route in
 * this codebase). Deliberately does NOT set `Content-Type` itself: a
 * `FormData` body needs the browser's own auto-generated
 * `multipart/form-data; boundary=...` header, which `doFetch`'s hardcoded
 * `'Content-Type': 'application/json'` would otherwise stomp — so this is a
 * third, parallel path alongside `request()`/`requestBlob()` rather than a
 * new option threaded through `doFetch`, the same "a genuinely different
 * body shape gets its own function" precedent `requestBlob` already set.
 * Same auth-header injection and auto-refresh-on-`AUTH_TOKEN_EXPIRED` retry
 * as every other authenticated call.
 */
async function doFetchMultipart(path, formData, token) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
  } catch {
    throw new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server. Check your connection.' });
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new ApiError({ code: 'NETWORK_ERROR', message: 'The server returned an unreadable response.', status: response.status });
  }

  if (envelope.error) {
    throw new ApiError({ ...envelope.error, status: response.status });
  }

  return envelope;
}

export async function requestMultipart(path, formData) {
  const token = getAccessToken();
  try {
    const { data } = await doFetchMultipart(path, formData, token);
    return data;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AUTH_TOKEN_EXPIRED' && onAccessTokenExpired) {
      const refreshedToken = await onAccessTokenExpired();
      const { data } = await doFetchMultipart(path, formData, refreshedToken);
      return data;
    }
    if (error instanceof ApiError && typeof error.code === 'string' && error.code.startsWith('AUTH_') && onAuthenticationFailed) {
      onAuthenticationFailed(error);
    }
    throw error;
  }
}
