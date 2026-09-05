import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { authApi, configureApiClient, ApiError } from '../../shared/api/index.js';

/**
 * AuthContext — the frontend half of PLAN.md Phase 0's "a user can log in,
 * see an empty shell scoped to their tenant" exit line. Owns the only copy
 * of the access/refresh tokens this app holds, and is the one place
 * `configureApiClient` is called, wiring `shared/api/client.js`'s generic
 * refresh-on-expiry hook to this context's own refresh logic.
 *
 * ── TOKENS LIVE IN MEMORY ONLY, NEVER localStorage ─────────────────────────
 *
 * PRODUCT_REQUIREMENTS.md §3.16: "tokens are never placed in localStorage
 * where an XSS can read them" — session persistence is meant to come from an
 * HttpOnly cookie instead, which the backend does not set yet (it returns
 * both tokens in the login/refresh response body, not a Set-Cookie header).
 * Given that, an in-memory-only store is the compliant choice available
 * today, not a shortcut: a full page reload always logs the user out. Adding
 * HttpOnly-cookie-based refresh-token delivery is backend work — changing
 * how `src/auth/service.js` issues tokens — outside this pass's scope, and
 * belongs on the list of things to close before Phase 1 ships something a
 * real front-desk shift would rely on staying signed in through.
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
 * a `GET /api/v1/me`-shaped endpoint exists (neither is built). Anything
 * rendering `user.email` as a name should read as a placeholder, not a
 * finished feature.
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

const IDLE = 'idle';
const AUTHENTICATING = 'authenticating';
const AUTHENTICATED = 'authenticated';
const MFA_REQUIRED = 'mfa_required';
const SESSION_EXPIRED = 'session_expired';

export function AuthProvider({ children }) {
  const [status, setStatus] = useState(IDLE);
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  // Set only while status === MFA_REQUIRED — the challenge token
  // `verifyMfa` below resumes login with, plus the email `login()` was
  // called with (the response itself carries neither, same "no display
  // name yet" gap this file's own header already notes for a real login).
  const [mfaChallenge, setMfaChallenge] = useState(null);

  // Refs, not state: `configureApiClient`'s callbacks close over these once,
  // on mount, and must always see the LATEST token — a state closure from
  // the initial render would go stale the moment a token rotates.
  const accessTokenRef = useRef(null);
  const refreshTokenRef = useRef(null);
  // Mirrors user.activePropertyId. Needed alongside the state itself because
  // the refresh handler below is registered once (see the effect's comment)
  // and would otherwise close over whatever `user` was on that first render
  // — always `null` — forever, the same staleness problem the token refs
  // exist to avoid, just missed for this one field originally.
  const activePropertyIdRef = useRef(null);

  const clearSession = useCallback(() => {
    accessTokenRef.current = null;
    refreshTokenRef.current = null;
    activePropertyIdRef.current = null;
    setUser(null);
    setMfaChallenge(null);
  }, []);

  const applySession = useCallback((result) => {
    accessTokenRef.current = result.accessToken;
    refreshTokenRef.current = result.refreshToken ?? refreshTokenRef.current;
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
    const refreshToken = refreshTokenRef.current;
    clearSession();
    setStatus(IDLE);
    setError(null);
    if (refreshToken) {
      // Best-effort: the point of logging out client-side is to stop acting
      // as this user immediately, which clearSession() above already did.
      // A network failure here must not trap someone in a "logged in" state
      // they can visibly see they've left.
      try {
        await authApi.logout({ refreshToken });
      } catch {
        // Deliberately swallowed — see comment above.
      }
    }
  }, [clearSession]);

  const switchProperty = useCallback(async (propertyId) => {
    const result = await authApi.switchProperty({ propertyId });
    accessTokenRef.current = result.accessToken;
    activePropertyIdRef.current = result.activePropertyId;
    setUser((previous) => ({ ...previous, activePropertyId: result.activePropertyId, role: result.role }));
    return result;
  }, []);

  // The refresh-on-expiry handshake `shared/api/client.js` calls into.
  // Registered once; reads the CURRENT tokens via refs, never a stale
  // closure over the render that first set them up.
  useEffect(() => {
    configureApiClient({
      accessTokenGetter: () => accessTokenRef.current,
      accessTokenExpiredHandler: async () => {
        const refreshToken = refreshTokenRef.current;
        if (!refreshToken) {
          const sessionError = new ApiError({ code: 'AUTH_TOKEN_INVALID', message: 'No session to refresh.' });
          clearSession();
          setStatus(SESSION_EXPIRED);
          setError(toDisplayError(sessionError));
          throw sessionError;
        }
        try {
          const result = await authApi.refresh({
            refreshToken,
            propertyId: activePropertyIdRef.current ?? undefined,
          });
          accessTokenRef.current = result.accessToken;
          refreshTokenRef.current = result.refreshToken;
          return result.accessToken;
        } catch (caught) {
          // The refresh token itself is no longer usable (revoked, expired,
          // or the account was deactivated — AUTH-6/AUTH-10's refresh-path
          // cases). This is genuine session expiry, not a retryable blip.
          clearSession();
          setStatus(SESSION_EXPIRED);
          setError(toDisplayError(caught));
          throw caught;
        }
      },
    });
  }, [clearSession]);

  const value = {
    status,
    isAuthenticated: status === AUTHENTICATED,
    user,
    error,
    login,
    verifyMfa,
    logout,
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
