import { useEffect, useRef, useState } from 'react';
import { initialsFor } from './initials.js';
import { PropertySwitcher } from './PropertySwitcher.jsx';
import { BusinessDateIndicator } from './BusinessDateIndicator.jsx';
import { describeNotification, timeAgo } from './notificationText.js';
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
 * @param {Array<{id: string, type: string, payload: object, read_at: string|null, created_at: string}>} [notifications]   PLAN.md Phase 3's in-app bell — omit to keep the badge non-interactive (a screen with no bell data wired up yet).
 * @param {(id: string) => void} [onMarkNotificationRead]
 * @param {() => void} [onMarkAllNotificationsRead]
 * @param {(notification: object) => void} [onOpenNotification]   Clicking a row calls this (e.g. mark read and open the related screen).
 * @param {{name: string, avatarUrl?: string}} user
 * @param {{id: string, name: string}} activeProperty
 * @param {Array<{id: string, name: string}>} properties
 * @param {(propertyId: string) => void} onSwitchProperty
 * @param {string} businessDate   'YYYY-MM-DD' — see BusinessDateIndicator's own header for why this stays a string.
 * @param {() => void} [onLogout]   Renders the user chip as a menu button with a "Log out" item when supplied; a plain non-interactive chip otherwise.
 * @param {() => void} [onOpenProfile]   Self-service "My Profile" screen (user-requested) — renders a "My Profile" item above "Log out" when supplied.
 */
export function TopBar({
  onToggleSidebar,
  onToggleFullscreen,
  notificationCount = 0,
  notifications,
  onMarkNotificationRead,
  onMarkAllNotificationsRead,
  onOpenNotification,
  user,
  activeProperty,
  properties,
  onSwitchProperty,
  businessDate,
  onLogout,
  onOpenProfile,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const menuRef = useRef(null);
  const notifRef = useRef(null);

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

  useEffect(() => {
    if (!notifOpen) return undefined;
    function onPointerDown(event) {
      if (!notifRef.current?.contains(event.target)) setNotifOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setNotifOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [notifOpen]);

  const avatar = user.avatarUrl ? (
    <img className={styles.avatar} src={user.avatarUrl} alt="" />
  ) : (
    <span className={styles.avatarFallback} aria-hidden="true">
      {initialsFor(user.name)}
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

      <div className={styles.notifWrapper} ref={notifRef}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`Notifications${notificationCount ? `, ${notificationCount} unread` : ''}`}
          aria-haspopup="menu"
          aria-expanded={notifOpen}
          onClick={() => setNotifOpen((open) => !open)}
        >
          🔔
          {notificationCount > 0 && (
            <span className={styles.badge} aria-hidden="true">
              {notificationCount > 99 ? '99+' : notificationCount}
            </span>
          )}
        </button>
        {notifOpen && (
          <div className={styles.notifPanel} role="menu" aria-label="Notifications">
            <div className={styles.notifHeader}>
              <span className={styles.notifHeading}>Notifications</span>
              {notificationCount > 0 && onMarkAllNotificationsRead && (
                <button type="button" className={styles.notifMarkRead} onClick={onMarkAllNotificationsRead}>
                  Mark all read
                </button>
              )}
            </div>
            {!notifications || notifications.length === 0 ? (
              <p className={styles.notifEmpty}>No notifications yet.</p>
            ) : (
              notifications.map((notification) => {
                const { title, detail } = describeNotification(notification);
                const unread = !notification.read_at;
                const body = (
                  <>
                    <span className={styles.notifDot} data-unread={unread} aria-hidden="true" />
                    <span className={styles.notifBody}>
                      <span className={styles.notifTitle}>{title}</span>
                      {detail && <span className={styles.notifDetail}>{detail}</span>}
                      <span className={styles.notifTime}>{timeAgo(notification.created_at)}</span>
                    </span>
                  </>
                );
                return (
                  <div key={notification.id} className={`${styles.notifItem} ${unread ? styles.notifItemUnread : ''}`.trim()}>
                    {onOpenNotification ? (
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.notifOpen}
                        onClick={() => {
                          setNotifOpen(false);
                          onOpenNotification(notification);
                        }}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className={styles.notifOpen}>{body}</div>
                    )}
                    {unread && onMarkNotificationRead && (
                      <button type="button" className={styles.notifMarkRead} onClick={() => onMarkNotificationRead(notification.id)}>
                        Mark read
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

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
                {onOpenProfile && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenProfile();
                    }}
                  >
                    My Profile
                  </button>
                )}
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
