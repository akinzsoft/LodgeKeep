import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import styles from './main.module.css';
import { AuthProvider, useAuth } from './app/auth/index.js';
import { StaffLoginScreen } from './app/auth/screens/StaffLoginScreen.jsx';
import { MfaChallengeScreen } from './app/auth/screens/MfaChallengeScreen.jsx';
import { AcceptInvitationScreen } from './app/auth/screens/AcceptInvitationScreen.jsx';
import { AppShell } from './app/shell/index.js';
import { HomeDashboard } from './app/dashboard/HomeDashboard.jsx';
import { SetupScreen } from './app/setup/SetupScreen.jsx';
import { BookingScreen } from './app/booking/BookingScreen.jsx';
import { HousekeepingScreen } from './app/housekeeping/HousekeepingScreen.jsx';
import { ReportingScreen } from './app/reporting/ReportingScreen.jsx';
import { CashieringScreen } from './app/cashiering/CashieringScreen.jsx';
import { NightAuditScreen } from './app/night-audit/NightAuditScreen.jsx';
import { ProfilesScreen } from './app/profiles/ProfilesScreen.jsx';
import { Toast } from './shared/components/index.js';
import { useOnlineStatus } from './shared/hooks/useOnlineStatus.js';
import { notificationsApi } from './shared/api/index.js';

/**
 * No backend endpoint returns a property's current business date yet
 * (that's Setup/Property-module territory) — this single constant is what
 * both `AppShell`'s indicator and `HomeDashboard`'s report-driven KPIs/alert
 * strip use, so the two stay consistent with each other rather than two
 * independent hardcoded literals drifting apart.
 */
const BUSINESS_DATE = '2026-09-04';

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
 * still pending the same real permissions-read endpoint. PLAN.md Phase 3
 * adds the same for `housekeeping.*`/`notifications.*`/`reports.*`.
 */
function Demo() {
  const isOnline = useOnlineStatus();
  const { status, user, logout, switchProperty } = useAuth();
  const [toast, setToast] = useState(null);
  const [switchError, setSwitchError] = useState(null);
  const [activeItemKey, setActiveItemKey] = useState('home');
  const [notifications, setNotifications] = useState([]);

  async function reloadNotifications() {
    try {
      setNotifications(await notificationsApi.listBellNotifications());
    } catch {
      // The bell is a convenience, not a critical path — a failed fetch
      // just leaves it at its last-known (or empty) state rather than
      // surfacing a banner over the whole app shell.
    }
  }

  useEffect(() => {
    if (status !== 'authenticated') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-authentication; no data-fetching library exists yet to own this, same pattern every other screen's mount-time fetch already uses.
    reloadNotifications();
  }, [status]);

  async function handleMarkNotificationRead(id) {
    try {
      await notificationsApi.markNotificationRead(id);
      await reloadNotifications();
    } catch {
      // Same convenience-not-critical reasoning as the initial load above.
    }
  }

  // No router exists in this app yet — an invitation link's `?invite_token=`
  // query parameter is this screen's only "route," checked ahead of the
  // normal auth flow so a signed-in browser (a shared front-desk terminal,
  // say) still reaches it rather than the dashboard underneath.
  const inviteToken = new URLSearchParams(window.location.search).get('invite_token');
  if (inviteToken) {
    return <AcceptInvitationScreen token={inviteToken} isOffline={!isOnline} />;
  }

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
        new Set([
          'setup.view',
          'setup.manage',
          'reservations.view',
          'reservations.manage',
          'front_desk.view',
          'front_desk.manage',
          'housekeeping.view',
          'housekeeping.manage',
          'notifications.view',
          'notifications.manage',
          'reports.view',
          'reports.view_financial',
          'cashiering.post_charge',
          'cashiering.void_line',
          'night_audit.view',
          'night_audit.run',
        ])
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
      businessDate={BUSINESS_DATE}
      notificationCount={notifications.filter((n) => !n.read_at).length}
      notifications={notifications}
      onMarkNotificationRead={handleMarkNotificationRead}
      isOffline={!isOnline}
      onLogout={logout}
    >
      {switchError && (
        <p role="alert" className={styles.switchError}>
          {switchError}
        </p>
      )}
      {activeItemKey === 'setup' ? (
        <SetupScreen activePropertyId={user.activePropertyId} isOffline={!isOnline} />
      ) : activeItemKey === 'booking' ? (
        <BookingScreen activePropertyId={user.activePropertyId} isOffline={!isOnline} />
      ) : activeItemKey === 'housekeeping' ? (
        <HousekeepingScreen isOffline={!isOnline} />
      ) : activeItemKey === 'reports' ? (
        <ReportingScreen activePropertyId={user.activePropertyId} />
      ) : activeItemKey === 'cashiering' ? (
        <CashieringScreen isOffline={!isOnline} />
      ) : activeItemKey === 'night_audit' ? (
        <NightAuditScreen isOffline={!isOnline} />
      ) : activeItemKey === 'profiles' ? (
        <ProfilesScreen />
      ) : (
        <HomeDashboard greetingName={user.email} businessDate={BUSINESS_DATE} activePropertyId={user.activePropertyId} />
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
