import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import styles from './main.module.css';
import { AuthProvider, useAuth } from './app/auth/index.js';
import { StaffLoginScreen } from './app/auth/screens/StaffLoginScreen.jsx';
import { MfaChallengeScreen } from './app/auth/screens/MfaChallengeScreen.jsx';
import { AppShell } from './app/shell/index.js';
import { HomeDashboard } from './app/dashboard/HomeDashboard.jsx';
import { SetupScreen } from './app/setup/SetupScreen.jsx';
import { BookingScreen } from './app/booking/BookingScreen.jsx';
import { Toast } from './shared/components/index.js';
import { useOnlineStatus } from './shared/hooks/useOnlineStatus.js';

/**
 * Dev entry point — real `AuthProvider` + `shared/api` wiring against a real
 * backend (through the proxy `vite.config.js` sets up), not mock data. Visit
 * `http://alpha-hotels.localhost:5173` (`npm run dev`), not plain
 * `localhost:5173` (`src/auth/tenant-resolution.js` on the backend has
 * nothing to resolve a bare `localhost` request to).
 *
 * `businessDate` stays hardcoded below: no backend endpoint returns a
 * property's current business date yet (that's Setup/Property-module
 * territory, PLAN.md Phase 1+) — same category of gap as `properties`
 * carrying no display name (see `AuthContext.jsx`'s header), surfaced here
 * rather than invented.
 *
 * `permissions` below is NOT the real grant set, and cannot be yet: no
 * endpoint returns "what can this user actually do" (a `GET
 * /api/v1/me/permissions`-shaped read, or the login response carrying it,
 * neither built). Passing `setup.view`/`setup.manage` unconditionally means
 * the Setup nav item is always visible rather than correctly hidden from a
 * front-desk/cashier/housekeeping account — but per CLAUDE.md's own line,
 * "UI-level RBAC ... is convenience only — the API check ... is the real
 * one," and that real check is verified working (`tests/setup/setup.test.js`):
 * a role with no `setup.manage` grant gets a genuine 403 from the backend
 * the moment it tries to write anything, same as always. This is a visible
 * nav item for an account that will hit a real permission error, not a
 * security hole — the fix is a real permissions-read endpoint, not invented
 * here ahead of one.
 *
 * PLAN.md Phase 2 adds the same unconditional-optimistic set for
 * `reservations.*`/`front_desk.*` — identical reasoning, identical gap,
 * still pending the same real permissions-read endpoint.
 */
function Demo() {
  const isOnline = useOnlineStatus();
  const { status, user, logout, switchProperty } = useAuth();
  const [toast, setToast] = useState(null);
  const [switchError, setSwitchError] = useState(null);
  const [activeItemKey, setActiveItemKey] = useState('home');

  if (status === 'mfa_required') {
    return <MfaChallengeScreen />;
  }

  if (status !== 'authenticated') {
    return <StaffLoginScreen isOffline={!isOnline} />;
  }

  const activeProperty = user.properties.find((property) => property.propertyId === user.activePropertyId);

  async function handleSwitchProperty(propertyId) {
    setSwitchError(null);
    try {
      await switchProperty(propertyId);
      setToast('Property switched');
    } catch (caught) {
      // DESIGN_SYSTEM.md §2: errors get a banner, never a toast — and never
      // auto-dismiss, unlike the success case above.
      setSwitchError(caught.message ?? 'Could not switch property. Try again.');
    }
  }

  return (
    <AppShell
      user={{ name: user.email, role: user.role }}
      permissions={
        new Set(['setup.view', 'setup.manage', 'reservations.view', 'reservations.manage', 'front_desk.view', 'front_desk.manage'])
      }
      activeItemKey={activeItemKey}
      onNavigate={setActiveItemKey}
      // No property display name exists yet (AuthContext.jsx's header) —
      // the id is shown as a labelled stand-in rather than invented text.
      activeProperty={{ id: user.activePropertyId, name: `Property ${activeProperty?.propertyId ?? user.activePropertyId}` }}
      properties={user.properties.map((property) => ({
        id: property.propertyId,
        name: `Property ${property.propertyId}`,
      }))}
      onSwitchProperty={handleSwitchProperty}
      businessDate="2026-09-04"
      notificationCount={0}
      isOffline={!isOnline}
      onLogout={logout}
    >
      {switchError && (
        <p role="alert" className={styles.switchError}>
          {switchError}
        </p>
      )}
      {activeItemKey === 'setup' ? (
        <SetupScreen activePropertyId={user.activePropertyId} />
      ) : activeItemKey === 'booking' ? (
        <BookingScreen activePropertyId={user.activePropertyId} />
      ) : (
        <HomeDashboard greetingName={user.email} />
      )}
      {toast && (
        <div className={styles.toastLayer}>
          <Toast message={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </AppShell>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <Demo />
    </AuthProvider>
  </StrictMode>
);
