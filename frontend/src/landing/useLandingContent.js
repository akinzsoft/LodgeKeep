import { useEffect, useState } from 'react';
import { landingApi } from '../shared/api/index.js';
import { applyOverrides } from './contentOverrides.js';

/** How long the page waits for the saved content before showing the built-in defaults. */
export const CONTENT_WAIT_MS = 1500;

/**
 * The landing page's content: the saved overrides (platform console) applied
 * over `defaults`. The page holds off rendering its editable sections until this
 * settles, so a visitor never sees the default text flash and then change to the
 * saved one (or an old price flash before the live one). On any failure, or after
 * `CONTENT_WAIT_MS`, it settles on the defaults — the page always works without
 * the API.
 *
 * @returns {{content: object, ready: boolean}}
 */
export function useLandingContent(defaults) {
  const [state, setState] = useState({ content: defaults, ready: false });

  useEffect(() => {
    let settled = false;
    const settle = (content) => {
      if (settled) return;
      settled = true;
      setState({ content, ready: true });
    };
    const timer = setTimeout(() => settle(defaults), CONTENT_WAIT_MS);
    (async () => {
      try {
        settle(applyOverrides(defaults, await landingApi.getPublicLandingContent()));
      } catch {
        settle(defaults);
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [defaults]);

  return state;
}
