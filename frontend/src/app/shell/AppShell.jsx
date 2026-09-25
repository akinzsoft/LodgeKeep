import { useState } from 'react';
import { useViewportTier } from '../../shared/hooks/useViewportTier.js';
import { Sidebar } from './Sidebar.jsx';
import { TopBar } from './TopBar.jsx';
import { ImpersonationBanner } from './ImpersonationBanner.jsx';
import { OfflineBanner } from './OfflineBanner.jsx';
import { Footer } from './Footer.jsx';
import { DEFAULT_NAV_GROUPS } from './nav-config.js';
import styles from './AppShell.module.css';

/**
 * AppShell — PLAN.md Phase 0's last checklist item: "App shell (sidebar, top
 * bar, property switcher, business-date indicator)." Composes the pieces
 * this directory builds around one piece of shared state neither `Sidebar`
 * nor `TopBar` should own alone: whether the sidebar is open.
 *
 * ── ONE toggle, TWO breakpoint behaviours ──────────────────────────────────
 *
 * DESIGN_SYSTEM.md §1: "Sidebar: full → icon-only at 1024px → off-canvas
 * drawer below 640px." The hamburger in `TopBar` always calls the same
 * `toggleSidebar`; which of the two things it does — collapse to icons, or
 * slide a drawer in/out — is decided by CSS media queries inside
 * `Sidebar.module.css`, not by this component asking "which breakpoint am I
 * at" in JS. What `sidebarOpen` STARTS as depends on the screen, per
 * DESIGN_SYSTEM.md §1 ("full → icon-only at 1024px → off-canvas drawer below
 * 640px"): open (full width) on a desktop; CLOSED — an icon-only rail — on a
 * tablet or POS terminal, where a 240px sidebar leaves a portrait tablet too
 * little room and made the page overflow sideways; and CLOSED on a phone,
 * where "open" means an off-canvas drawer laid over the page behind a dimming
 * scrim, so starting open greeted every phone user with the menu instead of
 * their screen. Tapping a menu item on a phone closes the drawer again (the
 * user chose where to go; the menu has done its job), and crossing a
 * breakpoint — rotating a tablet, resizing a window — resets the sidebar to
 * that screen's default. A real app would likely persist the choice per-viewer
 * in `localStorage`, which is intentionally not built here — that's
 * app-wiring, not shell markup.
 *
 * ── WHAT THIS COMPONENT DOES NOT DO ────────────────────────────────────────
 *
 * No network call, no auth/session state, no routing. Every piece of data —
 * `user`, `activeProperty`, `properties`, `businessDate`, `impersonation`,
 * `navGroups`, `permissions` — arrives as props, and every action —
 * `onSwitchProperty`, `onNavigate`, `onExitImpersonation` — is a callback the
 * caller wires to whatever it actually has (today, nothing real: no
 * `shared/api` client or auth context exists yet). This mirrors every other
 * component this session built (`DataTable`, `ConfirmDialog`, ...): "this
 * file governs presentation, not behaviour" (DESIGN_SYSTEM.md's own opening
 * line) is a constraint on the whole shared component tree, not a
 * per-component judgment call.
 *
 * @param {{name: string, role: string, avatarUrl?: string}} user
 * @param {Array<import('react').ReactNode>} [quickAccessIcons]
 * @param {Array<{label: string, items: object[]}>} [navGroups]         Defaults to PRODUCT_REQUIREMENTS.md's literal taxonomy (nav-config.js).
 * @param {Set<string>} [permissions]
 * @param {string} [activeItemKey]
 * @param {(key: string) => void} [onNavigate]
 * @param {{id: string, name: string}} activeProperty
 * @param {Array<{id: string, name: string}>} properties
 * @param {(propertyId: string) => void} onSwitchProperty
 * @param {string} businessDate
 * @param {number} [notificationCount]
 * @param {Array<object>} [notifications]                                PLAN.md Phase 3's in-app bell — see TopBar's own header.
 * @param {(id: string) => void} [onMarkNotificationRead]
 * @param {() => void} [onMarkAllNotificationsRead]
 * @param {(notification: object) => void} [onOpenNotification]
 * @param {{tenantName: string, onExit: () => void}} [impersonation]     Present only while a platform-staff impersonation grant is active (SECURITY.md §2).
 * @param {boolean} [isOffline]                                          DESIGN_SYSTEM.md §2's sixth state — typically fed by `src/shared/hooks/useOnlineStatus.js`.
 * @param {() => void} [onLogout]                                       Renders the top bar's user chip as a menu with a "Log out" item — see TopBar's own header.
 * @param {() => void} [onOpenProfile]                                  Self-service "My Profile" screen (user-requested) — see TopBar's own header.
 * @param {import('react').ReactNode} children
 */
export function AppShell({
  user,
  quickAccessIcons,
  navGroups = DEFAULT_NAV_GROUPS,
  permissions,
  activeItemKey,
  onNavigate,
  activeProperty,
  properties,
  onSwitchProperty,
  businessDate,
  notificationCount,
  notifications,
  onMarkNotificationRead,
  onMarkAllNotificationsRead,
  onOpenNotification,
  impersonation,
  isOffline = false,
  onLogout,
  onOpenProfile,
  children,
}) {
  const tier = useViewportTier();
  const isPhone = tier === 'phone';
  const [sidebarOpen, setSidebarOpen] = useState(tier === 'desktop');

  // Crossing a breakpoint resets the sidebar to that screen's default (state
  // derived during render, the React-documented alternative to an effect that
  // sets state).
  const [seenTier, setSeenTier] = useState(tier);
  if (seenTier !== tier) {
    setSeenTier(tier);
    setSidebarOpen(tier === 'desktop');
  }

  const handleNavigate = (key) => {
    onNavigate?.(key);
    if (isPhone) setSidebarOpen(false);
  };

  return (
    <div className={styles.shell}>
      {isOffline && <OfflineBanner />}
      {impersonation && (
        <ImpersonationBanner tenantName={impersonation.tenantName} onExit={impersonation.onExit} />
      )}

      <div className={styles.body}>
        <Sidebar
          user={user}
          quickAccessIcons={quickAccessIcons}
          navGroups={navGroups}
          permissions={permissions}
          activeItemKey={activeItemKey}
          onNavigate={handleNavigate}
          collapsed={!sidebarOpen}
          mobileOpen={sidebarOpen}
        />

        {/* Below 640px, an open drawer needs a way to close by tapping
            outside it — DESIGN_SYSTEM.md's off-canvas pattern implies this
            even though it doesn't spell it out; a drawer with no backdrop
            dismiss is a drawer a thumb can't easily close. */}
        {sidebarOpen && (
          <div className={styles.scrim} onClick={() => setSidebarOpen(false)} role="presentation" />
        )}

        <div className={styles.main}>
          <TopBar
            onToggleSidebar={() => setSidebarOpen((open) => !open)}
            notificationCount={notificationCount}
            notifications={notifications}
            onMarkNotificationRead={onMarkNotificationRead}
            onMarkAllNotificationsRead={onMarkAllNotificationsRead}
            onOpenNotification={onOpenNotification}
            user={user}
            activeProperty={activeProperty}
            properties={properties}
            onSwitchProperty={onSwitchProperty}
            businessDate={businessDate}
            onLogout={onLogout}
            onOpenProfile={onOpenProfile}
          />
          <main className={styles.content}>{children}</main>
        </div>
      </div>

      <Footer />
    </div>
  );
}
