import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
// Inter was always named first in `--font-sans` but never actually loaded,
// so every screen silently rendered in the OS fallback. Self-hosted (no
// runtime CDN call) so it also works on an offline front-desk terminal.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
// Display serif — only the Home greeting and the sidebar wordmark use it.
import '@fontsource/fraunces/600.css';
import './styles/tokens.css';
import styles from './main.module.css';
import { AuthProvider, useAuth } from './app/auth/index.js';
import { StaffLoginScreen } from './app/auth/screens/StaffLoginScreen.jsx';
import { MfaChallengeScreen } from './app/auth/screens/MfaChallengeScreen.jsx';
import { AcceptInvitationScreen } from './app/auth/screens/AcceptInvitationScreen.jsx';
import { SignupScreen } from './app/auth/screens/SignupScreen.jsx';
import { AppShell, isNavItemAllowed } from './app/shell/index.js';
import { NotificationPopups } from './app/shell/NotificationPopups.jsx';
import { MyAccountModal } from './app/account/MyAccountModal.jsx';
import { notificationTarget } from './app/shell/notificationText.js';
import { HomeDashboard } from './app/dashboard/HomeDashboard.jsx';
import { SetupScreen } from './app/setup/SetupScreen.jsx';
import { BookingScreen } from './app/booking/BookingScreen.jsx';
import { HousekeepingScreen } from './app/housekeeping/HousekeepingScreen.jsx';
import { RoomsScreen } from './app/rooms/RoomsScreen.jsx';
import { StaffScreen } from './app/staff/StaffScreen.jsx';
import { NoAccessScreen } from './app/shell/NoAccessScreen.jsx';
import { ReportingScreen } from './app/reporting/ReportingScreen.jsx';
import { CashieringScreen } from './app/cashiering/CashieringScreen.jsx';
import { NightAuditScreen } from './app/night-audit/NightAuditScreen.jsx';
import { ProfilesScreen } from './app/profiles/ProfilesScreen.jsx';
import { POSScreen } from './app/pos/POSScreen.jsx';
import { ARScreen } from './app/ar/ARScreen.jsx';
import { GroupBlocksScreen } from './app/group-blocks/GroupBlocksScreen.jsx';
import { BillingScreen } from './app/billing/BillingScreen.jsx';
import { DataMigrationScreen } from './app/migration/DataMigrationScreen.jsx';
import { DoorAccessScreen } from './app/door-access/DoorAccessScreen.jsx';
import { ExpensesScreen } from './app/expenses/ExpensesScreen.jsx';
import { ChainOverviewScreen } from './app/chain-overview/ChainOverviewScreen.jsx';
import { Toast, Skeleton } from './shared/components/index.js';
import { useOnlineStatus } from './shared/hooks/useOnlineStatus.js';
import { useStaffNotifications } from './shared/hooks/useStaffNotifications.js';
import { authApi, setupApi } from './shared/api/index.js';
import { PortalApp } from './portal/PortalApp.jsx';
import { PlatformApp } from './platform/PlatformApp.jsx';
import { QrOrderApp } from './qr-order/QrOrderApp.jsx';

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
 * The sidebar is role-aware: `GET /auth/me/permissions` returns the real
 * permission keys the user's role holds at the ACTIVE property, re-fetched
 * after every property switch (a user can be a manager at one property and
 * front desk at another). This replaced a hardcoded "every key granted" set
 * that showed every role every menu item. UI filtering is convenience only —
 * each real route still enforces its own permission server-side.
 */
function Demo() {
  const isOnline = useOnlineStatus();
  const { status, user, logout, switchProperty } = useAuth();
  const [toast, setToast] = useState(null);
  const [switchError, setSwitchError] = useState(null);
  const [activeItemKey, setActiveItemKey] = useState('home');
  // Self-service "My Profile" screen (user-requested) — deliberately NOT
  // driven through `activeItemKey`/`screenKey`: it's reachable from the
  // TopBar user menu regardless of role/permissions, and registering it in
  // `nav-config.js` would both surface it in the sidebar (wrong) and get
  // it bounced back to `'home'` by `isNavItemAllowed`'s unknown-key
  // fallback below. Rendered as a modal overlay, a direct child of
  // `<AppShell>`, so the sidebar/business-date/property-switcher context
  // stays intact underneath it.
  const [profileOpen, setProfileOpen] = useState(false);
  // Gap closure: real property records (name, current_business_date) —
  // see this file's own header for why `GET /properties` is safe to call
  // here but must never widen WHICH ids are offered.
  const [properties, setProperties] = useState(null);
  // `{ userId, permissions }` — tagged with whose grants these are, so a
  // sign-out/sign-in as someone else never briefly shows the previous
  // user's menu while the new fetch is in flight.
  const [grants, setGrants] = useState(null);
  const [grantsError, setGrantsError] = useState(null);

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
    reloadProperties();
  }, [status]);

  // Re-fetched whenever the active property changes: the role — and so the
  // menu — is per property. The previous property's grants stay on screen
  // until the new ones land, rather than flashing the bootstrap screen.
  const userId = user?.userId;
  const activePropertyId = user?.activePropertyId;
  useEffect(() => {
    if (status !== 'authenticated') return undefined;
    let cancelled = false;
    authApi
      .getMyPermissions()
      .then((result) => {
        if (cancelled) return;
        setGrants({ userId, permissions: result.permissions });
        setGrantsError(null);
      })
      .catch(() => {
        if (cancelled) return;
        // Fail closed: hide gated items rather than show ones the API will
        // refuse — but say so, since a manager seeing only Home would
        // otherwise look like a broken account.
        setGrants({ userId, permissions: [] });
        setGrantsError('Could not load your permissions, so some menu items are hidden. Reload the page to try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [status, userId, activePropertyId]);

  // Gap closure (staff notifications): the bell polls for new activity
  // instead of loading once at sign-in, and new guest QR orders also raise
  // an on-screen card (`useStaffNotifications`' own header).
  const staffNotifications = useStaffNotifications({
    enabled: status === 'authenticated',
    sessionKey: status === 'authenticated' ? `${user?.userId}:${user?.activePropertyId}` : null,
  });

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
  const grantedPermissions = grants && grants.userId === user.userId ? new Set(grants.permissions) : null;
  if (properties === null || grantedPermissions === null) {
    return <BootstrappingScreen />;
  }

  // A property switch can take away the screen currently open (e.g. Setup
  // after becoming front desk). Say so instead of silently swapping in
  // Home: the user keeps the item they picked highlighted and sees why
  // nothing opened (DESIGN_SYSTEM.md §2 — a failure is never a silent
  // redirect). Home itself has no permission and is always allowed.
  const accessDenied = !isNavItemAllowed(activeItemKey, grantedPermissions);
  const screenKey = accessDenied ? null : activeItemKey;

  // Gap closure: a session restored via the bootstrap refresh (AuthContext.jsx's
  // own header) never submitted a login form this page load, so it carries
  // no email at all — the same "Property {id}" labelled-placeholder
  // precedent this file already uses for the missing property name.
  // The user's real name (login/refresh carry it) — email only as a
  // fallback for a session somehow missing both name fields.
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
  const displayName = fullName || user.email || `User ${user.userId}`;

  // Real property records, resolved by id — `null` while still loading (the
  // effect above hasn't resolved yet) is treated the same as "no match
  // found," falling back to the same placeholder this file always used.
  const realPropertyById = (id) => (properties ?? []).find((p) => String(p.id) === String(id));
  const activePropertyRecord = realPropertyById(user.activePropertyId);
  const businessDate = activePropertyRecord?.current_business_date ?? null;

  // A bell row or QR card opens the screen it's about, when this user's
  // role can see that screen, and is marked read either way.
  function handleOpenNotification(notification) {
    staffNotifications.markRead(notification.id);
    const target = notificationTarget(notification.type);
    if (target && isNavItemAllowed(target, grantedPermissions)) setActiveItemKey(target);
  }

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
      // Role codes are snake_case (`pos_operator`); the shell capitalizes each word.
      user={{ name: displayName, role: user.role?.replace(/_/g, ' ') }}
      permissions={grantedPermissions}
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
      notificationCount={staffNotifications.unreadCount}
      notifications={staffNotifications.notifications}
      onMarkNotificationRead={staffNotifications.markRead}
      onMarkAllNotificationsRead={staffNotifications.markAllRead}
      onOpenNotification={handleOpenNotification}
      isOffline={!isOnline}
      onLogout={logout}
      onOpenProfile={() => setProfileOpen(true)}
    >
      <NotificationPopups
        popups={staffNotifications.popups}
        onView={isNavItemAllowed('pos', grantedPermissions) ? handleOpenNotification : undefined}
        onDismiss={staffNotifications.dismissPopup}
      />
      {profileOpen && <MyAccountModal isOffline={!isOnline} onClose={() => setProfileOpen(false)} />}
      {switchError && (
        <p role="alert" className={styles.switchError}>
          {switchError}
        </p>
      )}
      {grantsError && (
        <p role="alert" className={styles.switchError}>
          {grantsError}
        </p>
      )}
      {accessDenied ? (
        <NoAccessScreen onGoHome={() => setActiveItemKey('home')} />
      ) : screenKey === 'setup' ? (
        <SetupScreen activePropertyId={user.activePropertyId} isOffline={!isOnline} onPropertiesChanged={reloadProperties} />
      ) : screenKey === 'booking' ? (
        <BookingScreen activePropertyId={user.activePropertyId} isOffline={!isOnline} />
      ) : screenKey === 'housekeeping' ? (
        <HousekeepingScreen
          activeProperty={activePropertyRecord}
          isOffline={!isOnline}
          currentUserId={user.userId}
          canManage={grantedPermissions.has('housekeeping.manage')}
        />
      ) : screenKey === 'rooms' ? (
        <RoomsScreen activeProperty={activePropertyRecord} isOffline={!isOnline} />
      ) : screenKey === 'staff' ? (
        <StaffScreen activeProperty={activePropertyRecord} isOffline={!isOnline} />
      ) : screenKey === 'reports' ? (
        <ReportingScreen activePropertyId={user.activePropertyId} />
      ) : screenKey === 'cashiering' ? (
        <CashieringScreen isOffline={!isOnline} />
      ) : screenKey === 'night_audit' ? (
        <NightAuditScreen isOffline={!isOnline} />
      ) : screenKey === 'profiles' ? (
        <ProfilesScreen isOffline={!isOnline} />
      ) : screenKey === 'pos' ? (
        <POSScreen activeProperty={activePropertyRecord} isOffline={!isOnline} currentUserLabel={displayName} />
      ) : screenKey === 'ar' ? (
        <ARScreen isOffline={!isOnline} />
      ) : screenKey === 'group_blocks' ? (
        <GroupBlocksScreen isOffline={!isOnline} />
      ) : screenKey === 'billing' ? (
        <BillingScreen isOffline={!isOnline} />
      ) : screenKey === 'migration' ? (
        <DataMigrationScreen isOffline={!isOnline} />
      ) : screenKey === 'door_access' ? (
        <DoorAccessScreen isOffline={!isOnline} />
      ) : screenKey === 'expenses' ? (
        <ExpensesScreen activeProperty={activePropertyRecord} isOffline={!isOnline} />
      ) : screenKey === 'chain_overview' ? (
        <ChainOverviewScreen isOffline={!isOnline} />
      ) : (
        <HomeDashboard
          greetingName={user.firstName}
          businessDate={businessDate}
          activeProperty={activePropertyRecord}
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
 * The guest portal, the QR self-ordering app, the platform console, and the
 * staff app are four separate trees, never mounted together in one page
 * load (`PortalApp.jsx`'s own header explains why this matters beyond
 * routing: it's what makes reusing `shared/api/client.js`'s single
 * token/refresh-handler registration safe for all of them). A pathname
 * check here, ahead of `<AuthProvider>`, is this app's only "router" at the
 * top level — `PortalApp`/`QrOrderApp` each own real `react-router-dom`
 * routing underneath their own subtree, `PlatformApp` (PLAN.md Phase 5) is
 * router-free like the staff app itself, but nothing above either needs to
 * know that. `QrOrderApp` needs no auth context of any kind registered at
 * all — every route under `/qr-order` is fully anonymous
 * (`shared/api/qr-ordering.js`'s own header).
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    {window.location.pathname.startsWith('/portal') ? (
      <PortalApp />
    ) : window.location.pathname.startsWith('/platform') ? (
      <PlatformApp />
    ) : window.location.pathname.startsWith('/qr-order') ? (
      <QrOrderApp />
    ) : window.location.pathname.startsWith('/signup') ? (
      // PLAN.md Phase 5 gap closure — public, no session of any kind
      // (POST /api/v1/signup is mounted outside buildStaffRouter()
      // entirely, since no tenant exists yet), so this needs no
      // <AuthProvider> any more than /qr-order's fully anonymous tree does.
      <SignupScreen />
    ) : (
      <AuthProvider>
        <Demo />
      </AuthProvider>
    )}
  </StrictMode>
);
