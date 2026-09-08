import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { authApi, configureApiClient, ApiError } from '../../shared/api/index.js';

/**
 * AuthContext — the frontend half of PLAN.md Phase 0's "a user can log in,
 * see an empty shell scoped to their tenant" exit line. Owns the only copy
 * of the access token this app holds, and is the one place
 * `configureApiClient` is called, wiring `shared/api/client.js`'s generic
 * refresh-on-expiry hook to this context's own refresh logic.
 *
 * ── THE ACCESS TOKEN LIVES IN MEMORY ONLY; THE REFRESH TOKEN LIVES IN AN
 *    HttpOnly COOKIE, NEVER IN JS AT ALL ─────────────────────────────────
 *
 * PRODUCT_REQUIREMENTS.md §3.16: "tokens are never placed in localStorage
 * where an XSS can read them." This used to mean the refresh token sat in a
 * JS variable for its whole lifetime (compliant — not localStorage — but
 * wiped by every page reload, logging a real front-desk shift out mid-task,
 * and still readable by any script running on the page). Gap closure:
 * `src/auth/service.js` now sets the refresh token as a `Set-Cookie` header
 * (`HttpOnly`, `src/auth/refresh-cookie.js`) instead of returning it in the
 * response body at all — this file never receives it, holds it, or could
 * leak it even under XSS. The browser attaches it automatically to
 * `/auth/refresh` and `/auth/logout`; nothing here manages it directly.
 *
 * ── BOOTSTRAP: RESTORING A SESSION ACROSS A RELOAD ─────────────────────────
 *
 * The access token is still gone the instant the page reloads (by design —
 * it is a short-lived JWT, never meant to persist), but the refresh cookie
 * survives. `AuthProvider` spends its first render in `status ===
 * 'bootstrapping'` while it calls `POST /auth/refresh` with no arguments —
 * "is there still a valid session cookie?" — before showing either the
 * login screen or the app shell. A rejection here (no cookie, expired,
 * revoked) is a normal, silent "not logged in," not a session-expiry error:
 * it lands on `idle`, exactly like a browser that was never logged in at
 * all, never `session_expired` (that status is reserved for a session that
 * broke mid-use — see below). The bootstrap call is guarded by a ref, not a
 * cleanup-cancelled flag, so React 19's StrictMode double-invoking this
 * effect in development can't fire the (non-idempotent — it ROTATES the
 * refresh token) call twice.
 *
 * ── WHAT "USER" DOES NOT INCLUDE ────────────────────────────────────────
 *
 * `POST /api/v1/auth/login`'s response carries `userId`, `tenantId`,
 * `activePropertyId`, `role`, and `properties` (each `{propertyId, role}` —
 * no property NAME either) — verified against a live instance of the
 * backend while building this file, not assumed from reading its source.
 * There is no display name, avatar, or email in that response. `email` here
 * is the value `login()` was CALLED with, kept as the least-wrong stand-in
 * for a name until either the login response carries real profile fields or
 * a `GET /api/v1/me`-shaped endpoint exists (neither is built). A session
 * restored by the bootstrap refresh above has no `email` at all — no login
 * form was ever submitted this page load to supply one — so `user.email` is
 * `undefined` in that case; a consumer (`main.jsx`) falls back to a labelled
 * placeholder, the same "Property {id}" precedent this file already uses
 * for the missing property name. Anything rendering `user.email` as a name
 * should read as a placeholder, not a finished feature.
 *
 * ── SESSION EXPIRY (TESTING.md FE-6) ───────────────────────────────────────
 *
 * "Session-expiry handling: return to login with a message explaining what
 * happened ... Never a blank redirect mid-check-in." `status ===
 * 'session_expired'` plus `error` is that message, in state — there is no
 * router in this codebase yet to literally navigate anywhere, so it's on
 * whatever consumes this context (see `main.jsx`) to render a login prompt
 * instead of its normal screen when it sees this status, rather than this
 * context doing a `window.location` redirect itself.
 */

const AuthContext = createContext(null);

const BOOTSTRAPPING = 'bootstrapping';
const IDLE = 'idle';
const AUTHENTICATING = 'authenticating';
const AUTHENTICATED = 'authenticated';
const MFA_REQUIRED = 'mfa_required';
const SESSION_EXPIRED = 'session_expired';

export function AuthProvider({ children }) {
  const [status, setStatus] = useState(BOOTSTRAPPING);
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  // Set only while status === MFA_REQUIRED — the challenge token
  // `verifyMfa` below resumes login with, plus the email `login()` was
  // called with (the response itself carries neither, same "no display
  // name yet" gap this file's own header already notes for a real login).
  const [mfaChallenge, setMfaChallenge] = useState(null);

  // A ref, not state: `configureApiClient`'s callback closes over this once,
  // on mount, and must always see the LATEST token — a state closure from
  // the initial render would go stale the moment a token rotates. There is
  // no equivalent ref for the refresh token any more — it never reaches
  // this file at all (see this file's own header).
  const accessTokenRef = useRef(null);
  // Mirrors user.activePropertyId. Needed alongside the state itself because
  // the refresh handler below is registered once (see the effect's comment)
  // and would otherwise close over whatever `user` was on that first render
  // — always `null` — forever, the same staleness problem the token ref
  // exists to avoid, just missed for this one field originally.
  const activePropertyIdRef = useRef(null);
  // Guards the bootstrap effect below against React 19 StrictMode's
  // double-invoke-in-development behaviour — see this file's own header.
  const hasBootstrappedRef = useRef(false);

  const clearSession = useCallback(() => {
    accessTokenRef.current = null;
    activePropertyIdRef.current = null;
    setUser(null);
    setMfaChallenge(null);
  }, []);

  const applySession = useCallback((result) => {
    accessTokenRef.current = result.accessToken;
    activePropertyIdRef.current = result.activePropertyId ?? activePropertyIdRef.current ?? null;
    setUser((previous) => ({
      ...previous,
      userId: result.userId ?? previous?.userId,
      tenantId: result.tenantId ?? previous?.tenantId,
      activePropertyId: activePropertyIdRef.current,
      role: result.role ?? previous?.role,
      properties: result.properties ?? previous?.properties ?? [],
    }));
  }, []);

  const login = useCallback(
    async ({ email, password }) => {
      setStatus(AUTHENTICATING);
      setError(null);
      try {
        const result = await authApi.login({ email, password });

        if (result.status === 'mfa_challenge_required') {
          // TESTING.md AUTH-9's frontend counterpart: a challenge, not full
          // access yet. Real TOTP verification is still a 501 stub
          // (`src/auth/errors.js`'s MfaNotImplementedError) — the one thing
          // `verifyMfa` below can actually complete is `src/auth/mfa.js`'s
          // dev-only bypass code, never valid outside a non-production
          // backend.
          setMfaChallenge({ challengeToken: result.challengeToken, email });
          setStatus(MFA_REQUIRED);
          return result;
        }

        applySession(result);
        setUser((previous) => ({ ...previous, email }));
        setStatus(AUTHENTICATED);
        return result;
      } catch (caught) {
        setStatus(IDLE);
        setError(toDisplayError(caught));
        throw caught;
      }
    },
    [applySession]
  );

  /**
   * Resumes the login `mfa_challenge_required` above paused. On a wrong
   * code — or any submission against a production backend, where
   * `isDevBypassCode` always returns false — the backend's real
   * `AUTH_MFA_NOT_IMPLEMENTED` 501 lands in `error` and status returns to
   * `MFA_REQUIRED` (not `idle`) so the pending challenge, and the screen
   * showing it, both survive a retry rather than bouncing back to the
   * email/password form.
   */
  const verifyMfa = useCallback(
    async (code) => {
      if (!mfaChallenge?.challengeToken) {
        throw new Error('No pending MFA challenge to verify.');
      }
      setStatus(AUTHENTICATING);
      setError(null);
      try {
        const result = await authApi.verifyMfa({ challengeToken: mfaChallenge.challengeToken, code });
        applySession(result);
        setUser((previous) => ({ ...previous, email: mfaChallenge.email }));
        setMfaChallenge(null);
        setStatus(AUTHENTICATED);
        return result;
      } catch (caught) {
        setStatus(MFA_REQUIRED);
        setError(toDisplayError(caught));
        throw caught;
      }
    },
    [applySession, mfaChallenge]
  );

  const logout = useCallback(async () => {
    clearSession();
    setStatus(IDLE);
    setError(null);
    // Best-effort: the point of logging out client-side is to stop acting as
    // this user immediately, which clearSession() above already did. A
    // network failure here must not trap someone in a "logged in" state they
    // can visibly see they've left. No refresh token to pass any more — the
    // browser attaches the cookie itself; the endpoint is a clean no-op if
    // it's already gone (`staffLogout`'s own header).
    try {
      await authApi.logout();
    } catch {
      // Deliberately swallowed — see comment above.
    }
  }, [clearSession]);

  /**
   * Backing out of an MFA challenge (`MfaChallengeScreen`'s "Back to sign
   * in") — deliberately NOT `logout()`. No session was ever established at
   * this stage (a challenge token, not a refresh cookie), so there is
   * nothing server-side to revoke; this used to be enforceable client-side
   * by checking "do we hold a refresh token yet" before calling `logout()`,
   * a check that no longer exists now that the refresh token lives in an
   * HttpOnly cookie this file never sees (see this file's own header) — so
   * it gets its own local-only reset instead of losing that guarantee.
   */
  const cancelMfaChallenge = useCallback(() => {
    setMfaChallenge(null);
    setStatus(IDLE);
    setError(null);
  }, []);

  const switchProperty = useCallback(async (propertyId) => {
    const result = await authApi.switchProperty({ propertyId });
    accessTokenRef.current = result.accessToken;
    activePropertyIdRef.current = result.activePropertyId;
    setUser((previous) => ({ ...previous, activePropertyId: result.activePropertyId, role: result.role }));
    return result;
  }, []);

  // The refresh-on-expiry handshake `shared/api/client.js` calls into.
  // Registered once; reads the CURRENT access token via the ref, never a
  // stale closure over the render that first set it up. No refresh token to
  // read any more — the browser attaches the cookie to this same call
  // automatically.
  useEffect(() => {
    configureApiClient({
      accessTokenGetter: () => accessTokenRef.current,
      accessTokenExpiredHandler: async () => {
        try {
          const result = await authApi.refresh({ propertyId: activePropertyIdRef.current ?? undefined });
          accessTokenRef.current = result.accessToken;
          return result.accessToken;
        } catch (caught) {
          // The refresh cookie itself is no longer usable (missing, revoked,
          // expired, or the account was deactivated — AUTH-6/AUTH-10's
          // refresh-path cases). This is genuine session expiry, not a
          // retryable blip — the user WAS signed in and now isn't.
          clearSession();
          setStatus(SESSION_EXPIRED);
          setError(toDisplayError(caught));
          throw caught;
        }
      },
    });
  }, [clearSession]);

  // Bootstrap: does a valid session cookie already exist (a page reload, or
  // the very first load of a browser that logged in before)? See this
  // file's own header for the full reasoning, including why this is guarded
  // by a ref rather than depending on effect cleanup.
  useEffect(() => {
    if (hasBootstrappedRef.current) return;
    hasBootstrappedRef.current = true;
    (async () => {
      try {
        const result = await authApi.refresh({});
        applySession(result);
        setStatus(AUTHENTICATED);
      } catch {
        // No cookie, or it's expired/revoked — a normal "not logged in,"
        // never an error banner: nothing was actually lost this page load.
        clearSession();
        setStatus(IDLE);
      }
    })();
  }, [applySession, clearSession]);

  const value = {
    status,
    isAuthenticated: status === AUTHENTICATED,
    user,
    error,
    login,
    verifyMfa,
    logout,
    cancelMfaChallenge,
    switchProperty,
    requestPasswordReset: authApi.requestPasswordReset,
    completePasswordReset: authApi.completePasswordReset,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * DESIGN_SYSTEM.md §2: "say what happened and what to do, in one sentence,
 * without a raw exception string." `ApiError.message` already IS that
 * sentence for every code the backend defines (`src/auth/errors.js`'s
 * messages are written for a human to read) — this just narrows what a
 * consumer needs to render to `{ message, code }`, so nothing downstream is
 * tempted to display a stack trace.
 */
function toDisplayError(caught) {
  if (caught instanceof ApiError) return { code: caught.code, message: caught.message };
  return { code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' };
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth() must be called within an <AuthProvider>.');
  return context;
}
