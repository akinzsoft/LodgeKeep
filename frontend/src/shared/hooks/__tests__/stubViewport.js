import { vi } from 'vitest';
import { act } from '@testing-library/react';
import { PHONE_QUERY, TABLET_QUERY } from '../useViewportTier.js';

/**
 * A controllable `matchMedia` for one viewport tier — `'phone'`, `'tablet'` or
 * `'desktop'`. `setTier` changes it and notifies subscribers, like a real
 * viewport change (a rotated device, a resized window).
 */
export function stubViewport(initialTier) {
  let tier = initialTier;
  const listeners = []; // one entry per registration (the same callback is registered once per breakpoint)
  const queries = [];
  const answers = {
    [PHONE_QUERY]: () => tier === 'phone',
    [TABLET_QUERY]: () => tier !== 'desktop',
  };
  window.matchMedia = vi.fn((query) => {
    queries.push(query);
    return {
      media: query,
      get matches() {
        return answers[query]?.() ?? false;
      },
      addEventListener: (_event, listener) => listeners.push(listener),
      removeEventListener: (_event, listener) => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      },
    };
  });
  return {
    queries,
    listenerCount: () => listeners.length,
    setTier(next) {
      tier = next;
      act(() => [...listeners].forEach((listener) => listener({})));
    },
  };
}
