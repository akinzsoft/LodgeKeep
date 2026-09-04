import { useEffect, useRef, useState } from 'react';
import { PropertySwitcher } from './PropertySwitcher.jsx';
import { BusinessDateIndicator } from './BusinessDateIndicator.jsx';
import styles from './TopBar.module.css';

/**
 * TopBar — PRODUCT_REQUIREMENTS.md's App shell, Top bar: "Hamburger (sidebar
 * collapse) on the left. Fullscreen toggle, notifications bell (with unread
 * count), user name + avatar on the right. Property switcher on the right
 * for multi-property tenants ... Business-date indicator ... shown
 * persistently."
 *
 * The impersonation banner is NOT rendered here — `AppShell.jsx` places it
 * as its own full-width strip above everything, matching "impossible to
 * miss" better than folding it into this bar's compact icon row.
 *
 * @param {() => void} onToggleSidebar
 * @param {() => void} [onToggleFullscreen]
 * @param {number} [notificationCount]
 * @param {{name: string, avatarUrl?: string}} user
 * @param {{id: string, name: string}} activeProperty
 * @param {Array<{id: string, name: string}>} properties
 * @param {(propertyId: string) => void} onSwitchProperty
 * @param {string} businessDate   'YYYY-MM-DD' — see BusinessDateIndicator's own header for why this stays a string.
 * @param {() => void} [onLogout]   Renders the user chip as a menu button with a "Log out" item when supplied; a plain non-interactive chip otherwise.
 */
export function TopBar({
  onToggleSidebar,
  onToggleFullscreen,
  notificationCount = 0,
  user,
  activeProperty,
  properties,
  onSwitchProperty,
  businessDate,
  onLogout,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onPointerDown(event) {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const avatar = user.avatarUrl ? (
    <img className={styles.avatar} src={user.avatarUrl} alt="" />
  ) : (
    <span className={styles.avatarFallback} aria-hidden="true">
      {user.name.charAt(0)}
    </span>
  );

  return (
    <header className={styles.topbar}>
      <button
        type="button"
        className={styles.iconButton}
        onClick={onToggleSidebar}
        aria-label="Toggle sidebar"
      >
        ☰
      </button>

      <div className={styles.spacer} />

      <BusinessDateIndicator businessDate={businessDate} />

      <PropertySwitcher activeProperty={activeProperty} properties={properties} onSwitchProperty={onSwitchProperty} />

      {onToggleFullscreen && (
        <button
          type="button"
          className={styles.iconButton}
          onClick={onToggleFullscreen}
          aria-label="Toggle fullscreen"
        >
          ⛶
        </button>
      )}

      <button type="button" className={styles.iconButton} aria-label={`Notifications${notificationCount ? `, ${notificationCount} unread` : ''}`}>
        🔔
        {notificationCount > 0 && (
          <span className={styles.badge} aria-hidden="true">
            {notificationCount > 99 ? '99+' : notificationCount}
          </span>
        )}
      </button>

      <div className={styles.user} ref={menuRef}>
        {onLogout ? (
          <>
            <button
              type="button"
              className={styles.userButton}
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {avatar}
              <span className={styles.userName}>{user.name}</span>
              <span className={styles.chevron} aria-hidden="true">
                ▾
              </span>
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu">
                <div className={styles.menuUser}>
                  <p className={styles.menuName}>{user.name}</p>
                  {user.role && <p className={styles.menuRole}>{user.role}</p>}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.menuItem} ${styles.menuItemDanger}`}
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                >
                  Log out
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            {avatar}
            <span className={styles.userName}>{user.name}</span>
          </>
        )}
      </div>
    </header>
  );
}
