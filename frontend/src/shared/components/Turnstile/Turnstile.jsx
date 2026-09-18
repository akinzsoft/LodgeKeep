import { useEffect, useRef } from 'react';
import { loadTurnstile } from '../../turnstile.js';
import styles from './Turnstile.module.css';

/**
 * Turnstile — security-review finding: `POST /signup` now requires a
 * verified Cloudflare Turnstile token. This renders the real widget
 * (explicit-render mode, `shared/turnstile.js`) into a ref'd container so
 * React owns mount/unmount/remount — the caller (`SignupScreen.jsx`)
 * forces a full remount via a changed `key` after any failed submission,
 * since a Turnstile response token is single-use and consumed the moment
 * the backend's `siteverify` call succeeds, REGARDLESS of what happens
 * afterward in that same request (e.g. a duplicate-slug rejection). Left
 * unremounted, a retry would silently fail CAPTCHA on an already-spent
 * token with no visible reason why.
 *
 * @param {string} siteKey
 * @param {(token: string) => void} onVerify
 * @param {() => void} [onExpire]
 * @param {() => void} [onError]
 */
export function Turnstile({ siteKey, onVerify, onExpire, onError }) {
  const containerRef = useRef(null);

  useEffect(() => {
    let widgetId;
    let cancelled = false;

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token) => onVerify(token),
          'expired-callback': () => onExpire?.(),
          'error-callback': () => onError?.(),
        });
      })
      .catch(() => onError?.());

    return () => {
      cancelled = true;
      if (widgetId != null) window.turnstile?.remove(widgetId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onVerify/onExpire/onError are event callbacks the caller may recreate every render, not reactive state this effect should re-run for; only siteKey (and a remount via the caller's own `key`) should re-render the widget.
  }, [siteKey]);

  return <div ref={containerRef} className={styles.container} />;
}
