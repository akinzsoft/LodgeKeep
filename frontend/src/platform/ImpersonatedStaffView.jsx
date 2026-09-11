import { useEffect, useState } from 'react';
import { AppShell } from '../app/shell/index.js';
import { HomeDashboard } from '../app/dashboard/HomeDashboard.jsx';
import { SetupScreen } from '../app/setup/SetupScreen.jsx';
import { BookingScreen } from '../app/booking/BookingScreen.jsx';
import { HousekeepingScreen } from '../app/housekeeping/HousekeepingScreen.jsx';
import { RoomsScreen } from '../app/rooms/RoomsScreen.jsx';
import { ReportingScreen } from '../app/reporting/ReportingScreen.jsx';
import { CashieringScreen } from '../app/cashiering/CashieringScreen.jsx';
import { NightAuditScreen } from '../app/night-audit/NightAuditScreen.jsx';
import { ProfilesScreen } from '../app/profiles/ProfilesScreen.jsx';
import { POSScreen } from '../app/pos/POSScreen.jsx';
import { ARScreen } from '../app/ar/ARScreen.jsx';
import { GroupBlocksScreen } from '../app/group-blocks/GroupBlocksScreen.jsx';
import { usePlatformAuth } from './auth/PlatformAuthContext.jsx';
import { useOnlineStatus } from '../shared/hooks/useOnlineStatus.js';
import { listProperties } from '../shared/api/setup.js';

/**
 * ImpersonatedStaffView — PLAN.md Phase 5 (Platform Foundation). The whole
 * point of this pass's chosen architecture: reuse every existing staff
 * screen and business module UNCHANGED, read-only, rather than building a
 * second, parallel "platform view" of the same data. This is nearly the
 * exact render body `main.jsx`'s own `Demo` component already has — the
 * real difference is where the session comes from (an impersonation grant,
 * not a staff login) and that read-only is enforced entirely server-side
 * (`src/auth/impersonation-guard.js`), so nothing here needs to hide or
 * disable any control — a mutating action a screen offers simply gets a
 * real `403 FORBIDDEN_IMPERSONATION_READ_ONLY` if clicked, surfaced
 * through each screen's own existing error-banner pattern, same as any
 * other backend rejection.
 *
 * `permissions` below is the same unconditional-optimistic set `main.jsx`
 * already uses for a real staff session — this app has no
 * `GET /me/permissions`-shaped endpoint for either population yet, and an
 * impersonation context is granted every GET regardless
 * (`src/auth/rbac.js`'s own impersonation bypass), so this set is, if
 * anything, MORE accurate here than for an ordinary staff account.
 */
const PERMISSIONS = new Set([
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
  'ar.view',
  'ar.manage',
  'group_blocks.view',
  'group_blocks.manage',
]);

export function ImpersonatedStaffView() {
  const { impersonation, exitImpersonation } = usePlatformAuth();
  const [activeItemKey, setActiveItemKey] = useState('home');
  const isOnline = useOnlineStatus();
  const isOffline = !isOnline;
  const [property, setProperty] = useState(null);

  // Defect fix: the property's real name/business date, resolved the same
  // way `main.jsx`'s own `reloadProperties`/`realPropertyById` already does
  // for a real staff session — `GET /properties` is reachable under an
  // impersonation token too (`setup/service.js`'s own `context.isImpersonation`
  // branch). Previously this view showed the TENANT's name in the property
  // slot and a permanently-null business date.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listProperties();
        if (cancelled) return;
        setProperty(rows.find((row) => String(row.id) === String(impersonation.propertyId)) ?? null);
      } catch {
        // Same graceful-degradation reasoning as main.jsx's own reloadProperties:
        // a failed fetch just leaves the tenant-name placeholder in place
        // rather than breaking the impersonated view.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [impersonation.propertyId]);

  const propertyName = property?.name ?? impersonation.tenantName;
  const businessDate = property?.current_business_date ?? null;

  return (
    <AppShell
      user={{ name: 'Platform staff (viewing read-only)', role: 'platform_impersonation' }}
      permissions={PERMISSIONS}
      activeItemKey={activeItemKey}
      onNavigate={setActiveItemKey}
      activeProperty={{ id: impersonation.propertyId, name: propertyName }}
      properties={[{ id: impersonation.propertyId, name: propertyName }]}
      // No property switcher this pass — a grant is pinned to one property,
      // chosen at start (this session's confirmed simplification). Viewing
      // a different property means ending this grant and starting a fresh,
      // separately-reasoned, separately-audited one.
      onSwitchProperty={() => {}}
      businessDate={businessDate}
      isOffline={isOffline}
      impersonation={{ tenantName: impersonation.tenantName, onExit: exitImpersonation }}
    >
      {activeItemKey === 'setup' ? (
        <SetupScreen activePropertyId={impersonation.propertyId} isOffline={isOffline} />
      ) : activeItemKey === 'booking' ? (
        <BookingScreen activePropertyId={impersonation.propertyId} isOffline={isOffline} />
      ) : activeItemKey === 'housekeeping' ? (
        <HousekeepingScreen isOffline={isOffline} />
      ) : activeItemKey === 'rooms' ? (
        <RoomsScreen activeProperty={{ id: impersonation.propertyId }} />
      ) : activeItemKey === 'reports' ? (
        <ReportingScreen activePropertyId={impersonation.propertyId} />
      ) : activeItemKey === 'cashiering' ? (
        <CashieringScreen isOffline={isOffline} />
      ) : activeItemKey === 'night_audit' ? (
        <NightAuditScreen isOffline={isOffline} />
      ) : activeItemKey === 'profiles' ? (
        <ProfilesScreen isOffline={isOffline} />
      ) : activeItemKey === 'pos' ? (
        <POSScreen isOffline={isOffline} />
      ) : activeItemKey === 'ar' ? (
        <ARScreen isOffline={isOffline} />
      ) : activeItemKey === 'group_blocks' ? (
        <GroupBlocksScreen isOffline={isOffline} />
      ) : (
        <HomeDashboard
          greetingName="Platform staff"
          businessDate={businessDate}
          activePropertyId={impersonation.propertyId}
          onNavigateToSetup={() => setActiveItemKey('setup')}
        />
      )}
    </AppShell>
  );
}
