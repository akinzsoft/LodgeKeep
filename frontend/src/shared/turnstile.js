/**
 * Security-review finding: `POST /signup` now requires a verified
 * Cloudflare Turnstile token — this is the script-loading half, mirroring
 * `shared/paystack.js`'s own lazy-load-on-first-use shape exactly (loaded
 * only when a screen that actually needs it mounts, not from `index.html`
 * — most sessions never open the signup screen at all).
 *
 * `?render=explicit` stops Cloudflare's own script from auto-scanning the
 * DOM for `.cf-turnstile` divs on load — the React wrapper
 * (`shared/components/Turnstile/Turnstile.jsx`) calls `render()` itself,
 * against a ref, so mount/unmount/remount is under React's own control
 * (needed for the "get a fresh widget after a failed submission" flow —
 * see that component's own header).
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loadPromise = null;

export function loadTurnstile() {
  if (typeof window !== 'undefined' && window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('Turnstile script loaded but window.turnstile is unavailable.'));
    };
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Could not load the Cloudflare Turnstile script.'));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}
