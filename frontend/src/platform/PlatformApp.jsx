import { useState } from 'react';
import { PlatformAuthProvider, usePlatformAuth } from './auth/PlatformAuthContext.jsx';
import { PlatformLoginScreen } from './screens/PlatformLoginScreen.jsx';
import { PlatformMfaEnrollScreen } from './screens/PlatformMfaEnrollScreen.jsx';
import { PlatformMfaChallengeScreen } from './screens/PlatformMfaChallengeScreen.jsx';
import { TenantListScreen } from './screens/TenantListScreen.jsx';
import { TenantDetailScreen } from './screens/TenantDetailScreen.jsx';
import { ImpersonatedStaffView } from './ImpersonatedStaffView.jsx';

/**
 * PlatformApp — PLAN.md Phase 5 (Platform Foundation). The third top-level
 * tree, mounted from `main.jsx` on `/platform`, mirroring how `/portal`
 * already forks off the staff app. No `react-router-dom` here (unlike
 * `PortalApp`) — this app has no deep-linkable URLs worth supporting yet,
 * the same router-free convention the staff app's own `main.jsx` already
 * uses for its `activeItemKey` navigation.
 *
 * Owns one local state machine: browsing the console (tenant list/detail)
 * vs. actively impersonating (`ImpersonatedStaffView`) — the two are never
 * on screen at once, matching `PlatformAuthContext`'s own "one token at a
 * time" design.
 */
function PlatformConsole() {
  const { status, impersonation, logout } = usePlatformAuth();
  const [selectedTenantId, setSelectedTenantId] = useState(null);

  if (status === 'mfa_enrollment_required') return <PlatformMfaEnrollScreen />;
  if (status === 'mfa_challenge_required') return <PlatformMfaChallengeScreen />;
  if (status === 'impersonating' && impersonation) return <ImpersonatedStaffView />;
  // Defect fix: an inverted, catch-all-safe guard, mirroring `main.jsx`'s own
  // `status !== 'authenticated'` pattern — covers 'idle' AND 'authenticating'
  // (and any future/unrecognized status) by staying on the login screen,
  // rather than enumerating every non-console status and defaulting to the
  // console for anything left over. The old `status === 'idle'` branch let
  // 'authenticating' (set synchronously the instant `login()` is called,
  // before the request resolves) fall through to here and mount the tenant
  // list with no token issued yet.
  if (status !== 'authenticated') return <PlatformLoginScreen />;

  return selectedTenantId ? (
    <TenantDetailScreen tenantId={selectedTenantId} onBack={() => setSelectedTenantId(null)} onLogout={logout} />
  ) : (
    <TenantListScreen onSelectTenant={setSelectedTenantId} onLogout={logout} />
  );
}

export function PlatformApp() {
  return (
    <PlatformAuthProvider>
      <PlatformConsole />
    </PlatformAuthProvider>
  );
}
