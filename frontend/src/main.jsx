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
import { RoomsScreen } from './app/rooms/RoomsScreen.jsx';
import { ReportingScreen } from './app/reporting/ReportingScreen.jsx';
import { CashieringScreen } from './app/cashiering/CashieringScreen.jsx';
import { NightAuditScreen } from './app/night-audit/NightAuditScreen.jsx';
import { ProfilesScreen } from './app/profiles/ProfilesScreen.jsx';
import { POSScreen } from './app/pos/POSScreen.jsx';
import { Toast, Skeleton } from './shared/components/index.js';
import { useOnlineStatus } from './shared/hooks/useOnlineStatus.js';
import { notificationsApi, setupApi } from './shared/api/index.js';
import { PortalApp } from './portal/PortalApp.jsx';

/**
 * Gap closure: shown only while `AuthContext.jsx` is probing the HttpOnly
 * refresh cookie on first load — DESIGN_SYSTEM.md §2's "skeleton
 * placeholders ... never a spinner over stale numbers," applied to the one
 * screen that isn't really "loading data" so much as "not sure yet which
 * screen to show." Brief by construction (one network round trip), so this
 * stays a plain shape rather than a full second app-shell skeleton.
 */
function BootstrappingScreen() {
  return (
    <div className={styles.bootstrapping}>
      <Skeleton variant="circle" height="3rem" />
      <Skeleton variant="text" width="10rem" />
    </div>
  );
}

/**
 * Dev entry point — real `AuthProvider` + `shared/api` wiring against a real
 * backend (through the proxy `vite.config.js` sets up), not mock data. Visit
 * `http://alpha-hotels.localhost:5173` (`npm run dev`), not plain
 * `localhost:5173` (`src/auth/tenant-resolution.js` on the backend has
 * nothing to resolve a bare `localhost` request to).
 *
 * Gap closure (user-reported): `businessDate` and every property's display
 * NAME used to be hardcoded/placeholder here (`'2026-09-04'`, `Property
 * {id}`) — real values exist and always have (`GET /properties`, ungated
 * for any authenticated staff member per that route's own header — Phase
 * 1's "creating a tenant's first property happens before any grant exists
 * to check" exception), just never fetched from this file. `user.properties`
 * (from login/refresh, `AuthContext.jsx`'s header) is still the ONLY source
 * of WHICH property ids this user may switch into — that set is per-user
 * (`user_property_access`) and must never widen. `GET /properties` returns
 * every ACTIVE property in the whole tenant regardless of who can access
 * it, so it is used here strictly to resolve a NAME (and the active one's
 * business date) for ids `user.properties` already authorized, never to
 * add or offer an id the user doesn't hold.
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
  // Gap closure: real property records (name, current_business_date) —
  // see this file's own header for why `GET /properties` is safe to call
  // here but must never widen WHICH ids are offered.
  const [properties, setProperties] = useState(null);

  async function reloadNotifications() {
    try {
      setNotifications(await notificationsApi.listBellNotifications());
    } catch {
      // The bell is a convenience, not a critical path — a failed fetch
      // just leaves it at its last-known (or empty) state rather than
      // surfacing a banner over the whole app shell.
    }
  }

  async function reloadProperties() {
    try {
      setProperties(await setupApi.listProperties());
    } catch {
      // Same graceful-degradation reasoning as the bell above — a failed
      // fetch just leaves every property showing its "Property {id}"
      // placeholder name and no real business date, exactly the prior
      // behaviour, rather than breaking the shell.
      setProperties([]);
    }
  }

  useEffect(() => {
    if (status !== 'authenticated') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-authentication; no data-fetching library exists yet to own this, same pattern every other screen's mount-time fetch already uses.
    reloadNotifications();
    reloadProperties();
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

  // Gap closure: a page reload now probes the HttpOnly refresh cookie
  // (`AuthContext.jsx`'s own header) before deciding whether to show the
  // login screen or the app shell — this is that brief window, never the
  // login form itself, so a session that IS about to restore doesn't flash
  // it first.
  if (status === 'bootstrapping') {
    return <BootstrappingScreen />;
  }

  if (status === 'mfa_required') {
    return <MfaChallengeScreen />;
  }

  if (status !== 'authenticated') {
    return <StaffLoginScreen isOffline={!isOnline} />;
  }

  // Gap closure: `properties` (real names/business date) starts `null`
  // right after authenticating and resolves one HTTP round trip later —
  // wait for it rather than mounting `HomeDashboard` (whose own mount-time
  // report fetches read `businessDate` once and do not re-fetch if it
  // changes underneath them) with a transiently-null business date.
  if (properties === null) {
    return <BootstrappingScreen />;
  }

  // Gap closure: a session restored via the bootstrap refresh (AuthContext.jsx's
  // own header) never submitted a login form this page load, so it carries
  // no email at all — the same "Property {id}" labelled-placeholder
  // precedent this file already uses for the missing property name.
  const displayName = user.email ?? `User ${user.userId}`;

  // Real property records, resolved by id — `null` while still loading (the
  // effect above hasn't resolved yet) is treated the same as "no match
  // found," falling back to the same placeholder this file always used.
  const realPropertyById = (id) => (properties ?? []).find((p) => String(p.id) === String(id));
  const activePropertyRecord = realPropertyById(user.activePropertyId);
  const businessDate = activePropertyRecord?.current_business_date ?? null;

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
      user={{ name: displayName, role: user.role }}
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
          'pos.operate',
          'pos.manage',
        ])
      }
      activeItemKey={activeItemKey}
      onNavigate={setActiveItemKey}
      // Real name when `GET /properties` has resolved it; the same
      // "Property {id}" labelled stand-in as before while still loading or
      // on a fetch failure (this file's own header) — never a broken UI.
      activeProperty={{
        id: user.activePropertyId,
        name: activePropertyRecord?.name ?? `Property ${user.activePropertyId}`,
      }}
      properties={user.properties.map((property) => ({
        id: property.propertyId,
        name: realPropertyById(property.propertyId)?.name ?? `Property ${property.propertyId}`,
      }))}
      onSwitchProperty={handleSwitchProperty}
      businessDate={businessDate}
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
      ) : activeItemKey === 'rooms' ? (
        <RoomsScreen activeProperty={activePropertyRecord} />
      ) : activeItemKey === 'reports' ? (
        <ReportingScreen activePropertyId={user.activePropertyId} />
      ) : activeItemKey === 'cashiering' ? (
        <CashieringScreen isOffline={!isOnline} />
      ) : activeItemKey === 'night_audit' ? (
        <NightAuditScreen isOffline={!isOnline} />
      ) : activeItemKey === 'profiles' ? (
        <ProfilesScreen />
      ) : activeItemKey === 'pos' ? (
        <POSScreen isOffline={!isOnline} />
      ) : (
        <HomeDashboard
          greetingName={displayName}
          businessDate={businessDate}
          activePropertyId={user.activePropertyId}
          onNavigateToSetup={() => setActiveItemKey('setup')}
        />
      )}
      {toast && (
        <div className={styles.toastLayer}>
          <Toast message={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </AppShell>
  );
}

/**
 * The guest portal and the staff app are two separate trees, never mounted
 * together in one page load (`PortalApp.jsx`'s own header explains why this
 * matters beyond routing: it's what makes reusing `shared/api/client.js`'s
 * single token/refresh-handler registration safe for both). A pathname
 * check here, ahead of `<AuthProvider>`, is this app's only "router" at the
 * top level — `PortalApp` owns real `react-router-dom` routing underneath
 * its own `/portal/*` subtree, but nothing above it needs to know that.
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    {window.location.pathname.startsWith('/portal') ? (
      <PortalApp />
    ) : (
      <AuthProvider>
        <Demo />
      </AuthProvider>
    )}
  </StrictMode>
);
