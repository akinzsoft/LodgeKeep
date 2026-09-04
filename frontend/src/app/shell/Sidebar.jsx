import lodgekeepIcon from '../../assets/brand/lodgekeep-icon.png';
import styles from './Sidebar.module.css';

/**
 * Sidebar — PRODUCT_REQUIREMENTS.md's App shell, Left sidebar: "User panel
 * at top: avatar, name, role label ... Quick-access icon row: profile,
 * messages, calendar, security/permissions ... `-- MAIN` nav group ...
 * `-- APPS` nav group ... Active item highlighted with a tinted background
 * pill, not just bold text ... Sidebar contents are role-filtered — a
 * housekeeper never renders a Cashiering nav item at all."
 *
 * ── ROLE FILTERING IS A REAL MECHANISM, NOT A DEFAULT NAV TREE ────────────
 *
 * TESTING.md FE-5 is exactly this: "Housekeeper sees no Cashiering item."
 * An item is filtered out — not just visually hidden — the instant
 * `item.requiredPermission` names a permission `permissions` does not
 * contain; there is no rendered-but-hidden DOM node a curious housekeeper
 * could inspect to see what they don't have access to.
 *
 * `nav-config.js`'s `DEFAULT_NAV_GROUPS` (PRODUCT_REQUIREMENTS.md's literal
 * item labels — Home, Booking, Rooms, ...) carries no `requiredPermission` on
 * any item, because none of those items has a real module or endpoint yet to
 * define one against (see that file's own header) — this component's
 * filtering is proven with representative example data in its own tests
 * instead, the same way `tests/auth/rbac.test.js` proves the backend
 * mechanism without inventing SECURITY.md §5's literal catalogue ahead of
 * its modules.
 *
 * `collapsed` (icon-only, ≥1024px) and the off-canvas mobile drawer
 * (<640px, DESIGN_SYSTEM.md §1's responsive breakpoints) are both driven by
 * `AppShell`, which owns the single piece of "is the sidebar open" state
 * both breakpoints share.
 *
 * @param {{name: string, role: string, avatarUrl?: string}} user
 * @param {Array<import('react').ReactNode>} [quickAccessIcons]   Icon elements for the quick-access row — no icon library is bundled (see IconBadge's own header for the same choice), so the caller supplies whatever it already has.
 * @param {Array<{label: string, items: Array<{key: string, label: string, badge?: string, requiredPermission?: string}>}>} [navGroups]
 * @param {Set<string>} [permissions]
 * @param {string} [activeItemKey]
 * @param {(key: string) => void} [onNavigate]
 * @param {boolean} [collapsed]
 * @param {boolean} [mobileOpen]
 */
export function Sidebar({
  user,
  quickAccessIcons = [],
  navGroups,
  permissions = new Set(),
  activeItemKey,
  onNavigate,
  collapsed = false,
  mobileOpen = false,
}) {
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.requiredPermission || permissions.has(item.requiredPermission)),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <nav
      className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''} ${mobileOpen ? styles.mobileOpen : ''}`.trim()}
      aria-label="Main"
    >
      {/* LodgeKeep's own platform mark — never the tenant's own branding.
          A property's logo (properties.logo_url) is a separate, per-tenant
          concept (PRODUCT_REQUIREMENTS.md) that has no read endpoint yet;
          this is the product's own identity, shown the same way to every
          tenant's staff regardless of theming (DESIGN_SYSTEM.md §1: "the
          admin shell keeps the product's own identity"). */}
      <div className={styles.brand}>
        <img src={lodgekeepIcon} alt="LodgeKeep" className={styles.brandIcon} />
        {!collapsed && <span className={styles.brandWordmark}>LodgeKeep</span>}
      </div>

      <div className={styles.userPanel}>
        {user.avatarUrl ? (
          <img className={styles.avatar} src={user.avatarUrl} alt="" />
        ) : (
          <span className={styles.avatarFallback} aria-hidden="true">
            {user.name.charAt(0)}
          </span>
        )}
        {!collapsed && (
          <div>
            <p className={styles.userName}>{user.name}</p>
            <p className={styles.userRole}>{user.role}</p>
          </div>
        )}
      </div>

      {quickAccessIcons.length > 0 && (
        <div className={styles.quickAccess}>
          {quickAccessIcons.map((icon, index) => (
            <span key={index} className={styles.quickAccessIcon}>
              {icon}
            </span>
          ))}
        </div>
      )}

      {visibleGroups.map((group) => (
        <div key={group.label} className={styles.group}>
          {!collapsed && <p className={styles.groupLabel}>{group.label}</p>}
          <ul className={styles.list}>
            {group.items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className={`${styles.item} ${item.key === activeItemKey ? styles.active : ''}`.trim()}
                  onClick={() => onNavigate?.(item.key)}
                  aria-current={item.key === activeItemKey ? 'page' : undefined}
                >
                  {!collapsed && <span className={styles.itemLabel}>{item.label}</span>}
                  {!collapsed && item.badge && <span className={styles.itemBadge}>{item.badge}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
