import { createContext, useCallback, useContext, useRef, useState, useEffect } from 'react';
import { portalApi, configureApiClient, ApiError } from '../../shared/api/index.js';

/**
 * GuestAuthContext — the portal's own auth context, modeled on
 * `app/auth/AuthContext.jsx`'s shape (`status`, in-memory-only token,
 * `configureApiClient` registration) but deliberately NOT a copy of its
 * refresh handshake: `POST /api/v1/portal/auth/login` (`src/auth/service.js`'s
 * `guestLogin`) returns `{status, accessToken}` only — no refresh token, no
 * `guest_sessions` table exists in this pass, so there is nothing to call
 * on expiry. `accessTokenExpiredHandler` here just clears the session and
 * reports it, matching PRODUCT_REQUIREMENTS.md §3.16's "a guest simply
 * re-authenticates on expiry" (guests log in rarely, unlike a staff shift).
 *
 * Reuses `shared/api/client.js`'s single `configureApiClient` — the staff
 * app and the portal app are never mounted in the same page load
 * (`main.jsx`'s own pathname fork picks exactly one), so re-registering it
 * with guest-shaped callbacks here is safe, not a conflict.
 *
 * No `mfa_required` state: guest login never issues an MFA challenge
 * (`guestLogin` has no such branch at all, unlike staff's admin/super_admin
 * roles) — this state machine is deliberately smaller than staff's.
 */

const GuestAuthContext = createContext(null);

const IDLE = 'idle';
const AUTHENTICATING = 'authenticating';
const AUTHENTICATED = 'authenticated';
const SESSION_EXPIRED = 'session_expired';

export function GuestAuthProvider({ propertySlug, children }) {
  const [status, setStatus] = useState(IDLE);
  const [guest, setGuest] = useState(null);
  const [error, setError] = useState(null);

  const accessTokenRef = useRef(null);

  const clearSession = useCallback(() => {
    accessTokenRef.current = null;
    setGuest(null);
  }, []);

  const login = useCallback(
    async ({ email, password }) => {
      setStatus(AUTHENTICATING);
      setError(null);
      try {
        const result = await portalApi.login({ propertySlug, email, password });
        accessTokenRef.current = result.accessToken;
        setGuest({ email });
        setStatus(AUTHENTICATED);
        return result;
      } catch (caught) {
        setStatus(IDLE);
        setError(toDisplayError(caught));
        throw caught;
      }
    },
    [propertySlug]
  );

  const register = useCallback(
    async ({ email, password, firstName, lastName, phone }) => {
      setStatus(AUTHENTICATING);
      setError(null);
      try {
        const result = await portalApi.register({ propertySlug, email, password, firstName, lastName, phone });
        accessTokenRef.current = result.accessToken;
        setGuest({ email });
        setStatus(AUTHENTICATED);
        return result;
      } catch (caught) {
        setStatus(IDLE);
        setError(toDisplayError(caught));
        throw caught;
      }
    },
    [propertySlug]
  );

  const logout = useCallback(() => {
    clearSession();
    setStatus(IDLE);
    setError(null);
  }, [clearSession]);

  useEffect(() => {
    configureApiClient({
      accessTokenGetter: () => accessTokenRef.current,
      accessTokenExpiredHandler: async () => {
        const sessionError = new ApiError({ code: 'AUTH_TOKEN_EXPIRED', message: 'Your session has expired — please sign in again.' });
        clearSession();
        setStatus(SESSION_EXPIRED);
        setError(toDisplayError(sessionError));
        throw sessionError;
      },
    });
  }, [clearSession]);

  const value = {
    status,
    isAuthenticated: status === AUTHENTICATED,
    guest,
    error,
    login,
    register,
    logout,
  };

  return <GuestAuthContext.Provider value={value}>{children}</GuestAuthContext.Provider>;
}

function toDisplayError(caught) {
  if (caught instanceof ApiError) return { code: caught.code, message: caught.message };
  return { code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' };
}

export function useGuestAuth() {
  const context = useContext(GuestAuthContext);
  if (!context) throw new Error('useGuestAuth() must be called within a <GuestAuthProvider>.');
  return context;
}
