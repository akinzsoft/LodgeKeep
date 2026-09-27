import { useEffect, useRef, useState } from 'react';
import { fetchDeployedBuildId } from '../api/index.js';

/** How often a long-open page asks whether a newer build has been deployed. */
export const VERSION_CHECK_MS = 5 * 60 * 1000;

/**
 * True once the server is serving a different build from the one this page
 * is running (user-requested, after a storekeeper's all-day-open browser kept
 * the pre-deploy app and missed a new feature until a hard reload).
 *
 * Checks on a timer, when the tab becomes visible again, and when the window
 * regains focus. Never reloads by itself — the Register may have a half-rung
 * tab or a form half filled in — it only reports, and the app offers a
 * Reload button. A check that fails (offline, dev server with no
 * `version.json`, a deploy mid-restart) reports nothing and tries again
 * next time. Once true it stays true: the page cannot get newer by itself.
 *
 * @param {{enabled: boolean, currentBuildId: string|undefined}} options
 *   `enabled` is false in development and tests, where no `version.json` is
 *   served.
 */
export function useNewVersionAvailable({ enabled, currentBuildId }) {
  const [available, setAvailable] = useState(false);
  const checking = useRef(false);

  useEffect(() => {
    if (!enabled || !currentBuildId) return undefined;
    let cancelled = false;

    async function check() {
      if (checking.current) return;
      checking.current = true;
      try {
        const deployed = await fetchDeployedBuildId();
        if (!cancelled && deployed && deployed !== currentBuildId) setAvailable(true);
      } finally {
        checking.current = false;
      }
    }

    const timer = setInterval(check, VERSION_CHECK_MS);
    function onVisibilityChange() {
      if (!document.hidden) check();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', check);
    };
  }, [enabled, currentBuildId]);

  return available;
}
