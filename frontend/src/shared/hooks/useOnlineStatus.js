import { useEffect, useState } from 'react';

/**
 * useOnlineStatus — DESIGN_SYSTEM.md §2's sixth required state: "Offline /
 * degraded — front-desk terminals lose connectivity mid-shift. Show a
 * persistent banner when the connection drops, disable actions that would
 * post financial transactions, and never silently queue a payment as though
 * it succeeded."
 *
 * The one piece of real browser-API "behaviour" among this session's shared
 * frontend code — everywhere else follows DESIGN_SYSTEM.md's "this file
 * governs presentation, not behaviour" line by taking state as props (see
 * `OfflineBanner.jsx`'s own header). A connectivity listener has nowhere
 * else to live: it is the data source itself, not a presentation of one, and
 * ARCHITECTURE.md §2's tree reserves exactly `/frontend/src/shared/hooks` for
 * this kind of thing. `OfflineBanner` and every future financial-action
 * button stay pure — they take `isOffline` as a prop from whoever calls this
 * hook once, near the top of the app.
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return isOnline;
}
