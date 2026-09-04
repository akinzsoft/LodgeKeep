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
 */

let getAccessToken = () => null;
let onAccessTokenExpired = null;

/**
 * @param {() => string|null} accessTokenGetter
 * @param {() => Promise<string>} accessTokenExpiredHandler   Resolves with a new access token, or throws/rejects if the session cannot be refreshed.
 */
export function configureApiClient({ accessTokenGetter, accessTokenExpiredHandler }) {
  getAccessToken = accessTokenGetter;
  onAccessTokenExpired = accessTokenExpiredHandler;
}

/** Test-only reset, so one test file's registration cannot leak into the next. */
export function _resetApiClientForTesting() {
  getAccessToken = () => null;
  onAccessTokenExpired = null;
}

const BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) || '/api/v1';

async function doFetch(path, { method = 'GET', body, token, headers } = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
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

  return envelope.data;
}

/**
 * @param {string} path            e.g. "/auth/login" — joined to BASE_URL, never a full URL.
 * @param {object} [options]
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} [options.method]
 * @param {object} [options.body]
 * @param {boolean} [options.auth]   Attach the current access token. Defaults to true — most endpoints need one; the few that don't (login, refresh, password reset) opt out explicitly, so a missing token is a deliberate choice at the call site, not an oversight.
 * @param {object} [options.headers]  Extra headers — e.g. `Idempotency-Key` (ARCHITECTURE.md §7/§11), required on every reservation/front-desk mutation.
 */
export async function request(path, { method = 'GET', body, auth = true, headers } = {}) {
  const token = auth ? getAccessToken() : undefined;

  try {
    return await doFetch(path, { method, body, token, headers });
  } catch (error) {
    if (auth && error instanceof ApiError && error.code === 'AUTH_TOKEN_EXPIRED' && onAccessTokenExpired) {
      const refreshedToken = await onAccessTokenExpired();
      return doFetch(path, { method, body, token: refreshedToken, headers });
    }
    throw error;
  }
}
