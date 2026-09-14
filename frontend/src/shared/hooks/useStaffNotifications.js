import { useCallback, useEffect, useRef, useState } from 'react';
import { notificationsApi } from '../api/index.js';

/** How often the bell re-checks for new notifications while the tab is visible. */
export const NOTIFICATION_POLL_MS = 20_000;

/**
 * The signed-in staff member's live bell feed (gap closure: the bell used to
 * fetch once at login and never again).
 *
 * - Polls every `NOTIFICATION_POLL_MS` while `enabled` and the browser tab is
 *   visible, and immediately when the tab becomes visible again. No push
 *   transport exists in this stack, so polling is the mechanism.
 * - A slow response from an older poll never overwrites a newer one.
 * - A failed poll keeps the last good data — the bell is a convenience, not
 *   a critical path.
 * - `popups`: rows flagged `popup` (new guest QR orders) that arrived AFTER
 *   the first successful load. The first load only records what is already
 *   there, so signing in never replays a backlog of cards; each row pops up
 *   at most once per page load.
 *
 * @param {{enabled: boolean, sessionKey?: string}} options  `sessionKey`
 *   (e.g. user id) resets the feed when a different user signs in.
 */
export function useStaffNotifications({ enabled, sessionKey }) {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [popups, setPopups] = useState([]);
  const requestIdRef = useRef(0);
  const baselinedRef = useRef(false);
  const seenPopupIdsRef = useRef(new Set());

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const result = await notificationsApi.listBellNotifications();
      if (requestId !== requestIdRef.current) return;
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);

      const popupRows = result.notifications.filter((row) => row.popup && !row.read_at);
      if (!baselinedRef.current) {
        baselinedRef.current = true;
        popupRows.forEach((row) => seenPopupIdsRef.current.add(String(row.id)));
        return;
      }
      const fresh = popupRows.filter((row) => !seenPopupIdsRef.current.has(String(row.id)));
      if (fresh.length > 0) {
        fresh.forEach((row) => seenPopupIdsRef.current.add(String(row.id)));
        // Oldest first, so the newest card lands at the top of the stack.
        setPopups((current) => [...fresh.reverse(), ...current]);
      }
    } catch {
      // Keep the last good data.
    }
  }, []);

  useEffect(() => {
    requestIdRef.current += 1;
    baselinedRef.current = false;
    seenPopupIdsRef.current = new Set();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the feed when the session changes.
    setNotifications([]);
    setUnreadCount(0);
    setPopups([]);
    if (!enabled) return undefined;

    reload();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      reload();
    }, NOTIFICATION_POLL_MS);
    function onVisibilityChange() {
      if (!document.hidden) reload();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, sessionKey, reload]);

  const markRead = useCallback(
    async (id) => {
      setPopups((current) => current.filter((row) => String(row.id) !== String(id)));
      try {
        await notificationsApi.markNotificationRead(id);
      } catch {
        // The next poll shows the true state.
      }
      await reload();
    },
    [reload]
  );

  const markAllRead = useCallback(async () => {
    setPopups([]);
    try {
      await notificationsApi.markAllNotificationsRead();
    } catch {
      // The next poll shows the true state.
    }
    await reload();
  }, [reload]);

  const dismissPopup = useCallback((id) => {
    setPopups((current) => current.filter((row) => String(row.id) !== String(id)));
  }, []);

  return { notifications, unreadCount, popups, reload, markRead, markAllRead, dismissPopup };
}
