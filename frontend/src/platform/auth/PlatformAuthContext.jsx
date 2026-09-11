import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { platformApi, configureApiClient, ApiError } from '../../shared/api/index.js';

/**
 * PlatformAuthContext — PLAN.md Phase 5 (Platform Foundation). Deliberately
 * NOT a reuse of the staff `AuthContext.jsx`: a platform session has no
 * tenantId/properties/refresh-cookie concept at all, and carries a real
 * third status (`mfa_enrollment_required`) staff auth never has. Mirrors
 * the guest portal's own "no shared session context with staff" precedent
 * — a small, standalone context is clearer than threading a dozen
 * staff-only fields through as permanently-unused placeholders.
 *
 * ── ONE TOKEN AT A TIME, EVER ───────────────────────────────────────────
 *
 * `configureApiClient` (`shared/api/client.js`) is a module-level
 * singleton — safe here for the same reason `PortalApp.jsx`'s own header
 * already documents for the staff/portal split: the platform console view
 * and an active impersonation session are never on screen at the same
 * time, so re-pointing the ONE registered token getter at the moment of
 * transition is correct, not a race. Starting an impersonation grant swaps
 * the registered token from the platform one to the impersonation-derived
 * one; exiting swaps it back. Both tokens are held here, in refs, for
 * exactly this swap — never both installed at once.
 *
 * ── NO REFRESH, NO BOOTSTRAP ─────────────────────────────────────────────
 *
 * This session's confirmed Pass-1 simplification: platform sessions are
 * access-token-only (`src/auth/tokens.js`'s own header). A page reload
 * always requires a fresh login — there is no cookie to probe, unlike the
 * staff app's own bootstrap-refresh effect.
 */

const PlatformAuthContext = createContext(null);

export function PlatformAuthProvider({ children }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [enrollment, setEnrollment] = useState(null); // { enrollmentToken, otpAuthUrl, qrCodeDataUrl, manualEntryKey }
  const [challengeToken, setChallengeToken] = useState(null);
  const [impersonation, setImpersonation] = useState(null); // { tenantId, tenantName, propertyId, impersonationSessionId, expiresAt }
  // PLAN.md Phase 5's platform-staff tiering (SECURITY.md §2) — 'support' or
  // 'admin', set once login completes. UI-level convenience only (shows/hides
  // the impersonate/suspend/reactivate actions sensibly); the real check is
  // `requirePlatformRole('admin')` at the route, re-verified from the
  // database on every request.
  const [role, setRole] = useState(null);

  const platformTokenRef = useRef(null);
  const impersonationTokenRef = useRef(null);

  // Declared ahead of the two `activate*Token` callbacks below so they can
  // register it as `authenticationFailedHandler` — the "session is gone,
  // tear it down" side effect `shared/api/client.js` now calls for any
  // AUTH_* rejection it cannot retry (no refresh path exists for either
  // token this app ever holds). Clearing both refs unconditionally is safe
  // regardless of which token was actually live at the time.
  const logout = useCallback(() => {
    platformTokenRef.current = null;
    impersonationTokenRef.current = null;
    setImpersonation(null);
    setEnrollment(null);
    setChallengeToken(null);
    setError(null);
    setRole(null);
    setStatus('idle');
  }, []);

  const activateImpersonationToken = useCallback(() => {
    configureApiClient({
      accessTokenGetter: () => impersonationTokenRef.current,
      accessTokenExpiredHandler: null,
      authenticationFailedHandler: logout,
    });
  }, [logout]);

  const activatePlatformToken = useCallback(() => {
    configureApiClient({
      accessTokenGetter: () => platformTokenRef.current,
      accessTokenExpiredHandler: null,
      authenticationFailedHandler: logout,
    });
  }, [logout]);

  const login = useCallback(async (email, password) => {
    setStatus('authenticating');
    setError(null);
    try {
      const result = await platformApi.login(email, password);
      if (result.status === 'mfa_enrollment_required') {
        setEnrollment({
          enrollmentToken: result.enrollmentToken,
          otpAuthUrl: result.otpAuthUrl,
          qrCodeDataUrl: result.qrCodeDataUrl,
          manualEntryKey: result.manualEntryKey,
        });
        setStatus('mfa_enrollment_required');
      } else {
        setChallengeToken(result.challengeToken);
        setStatus('mfa_challenge_required');
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in. Try again.');
      setStatus('idle');
    }
  }, []);

  const confirmEnrollment = useCallback(
    async (code) => {
      setError(null);
      try {
        const result = await platformApi.enrollConfirm(enrollment.enrollmentToken, code);
        platformTokenRef.current = result.accessToken;
        activatePlatformToken();
        setEnrollment(null);
        setRole(result.role);
        setStatus('authenticated');
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'That code did not work. Try again.');
      }
    },
    [enrollment, activatePlatformToken]
  );

  const verifyMfa = useCallback(
    async (code) => {
      setError(null);
      try {
        const result = await platformApi.verifyMfa(challengeToken, code);
        platformTokenRef.current = result.accessToken;
        activatePlatformToken();
        setChallengeToken(null);
        setRole(result.role);
        setStatus('authenticated');
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'That code did not work. Try again.');
      }
    },
    [challengeToken, activatePlatformToken]
  );

  const cancelChallenge = useCallback(() => {
    setEnrollment(null);
    setChallengeToken(null);
    setError(null);
    setStatus('idle');
  }, []);

  const startImpersonation = useCallback(
    async (tenantId, { propertyId, reason, tenantName }) => {
      setError(null);
      try {
        const result = await platformApi.startImpersonation(tenantId, { propertyId, reason });
        impersonationTokenRef.current = result.accessToken;
        setImpersonation({
          tenantId: result.tenantId,
          tenantName: result.tenantName ?? tenantName,
          propertyId: result.propertyId,
          impersonationSessionId: result.impersonationSessionId,
          expiresAt: result.expiresAt,
        });
        activateImpersonationToken();
        setStatus('impersonating');
        return true;
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Could not start impersonation.');
        return false;
      }
    },
    [activateImpersonationToken]
  );

  const exitImpersonation = useCallback(async () => {
    try {
      await platformApi.endImpersonation();
    } catch {
      // Best-effort — the grant is time-bounded regardless (SECURITY.md §2),
      // and a failed exit call here must never trap someone inside the
      // impersonated view. Falling through to the console is always safe.
    }
    impersonationTokenRef.current = null;
    setImpersonation(null);
    activatePlatformToken();
    setStatus('authenticated');
  }, [activatePlatformToken]);

  return (
    <PlatformAuthContext.Provider
      value={{
        status,
        error,
        enrollment,
        impersonation,
        role,
        login,
        confirmEnrollment,
        verifyMfa,
        cancelChallenge,
        startImpersonation,
        exitImpersonation,
        logout,
      }}
    >
      {children}
    </PlatformAuthContext.Provider>
  );
}

export function usePlatformAuth() {
  const context = useContext(PlatformAuthContext);
  if (!context) throw new Error('usePlatformAuth must be used within a PlatformAuthProvider.');
  return context;
}
