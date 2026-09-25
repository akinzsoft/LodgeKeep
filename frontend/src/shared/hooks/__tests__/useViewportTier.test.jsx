import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useViewportTier, PHONE_QUERY, TABLET_QUERY } from '../useViewportTier.js';
import { stubViewport } from './stubViewport.js';

describe('useViewportTier', () => {
  afterEach(() => {
    delete window.matchMedia;
  });

  it.each(['phone', 'tablet', 'desktop'])('reports %s', (tier) => {
    stubViewport(tier);
    expect(renderHook(() => useViewportTier()).result.current).toBe(tier);
  });

  it('asks the browser the same questions the CSS asks: below 640px, and 1024px and below', () => {
    const viewport = stubViewport('desktop');
    renderHook(() => useViewportTier());
    expect(PHONE_QUERY).toBe('(max-width: 639px)');
    expect(TABLET_QUERY).toBe('(max-width: 1024px)');
    expect(viewport.queries).toEqual(expect.arrayContaining([PHONE_QUERY, TABLET_QUERY]));
  });

  it('re-renders when the viewport crosses either breakpoint, in both directions', () => {
    const viewport = stubViewport('desktop');
    const { result } = renderHook(() => useViewportTier());
    for (const next of ['tablet', 'phone', 'tablet', 'desktop']) {
      viewport.setTier(next);
      expect(result.current).toBe(next);
    }
  });

  it('stops listening once unmounted', () => {
    const viewport = stubViewport('desktop');
    const { unmount } = renderHook(() => useViewportTier());
    expect(viewport.listenerCount()).toBe(2); // one per breakpoint
    unmount();
    expect(viewport.listenerCount()).toBe(0);
  });

  it('answers desktop — the behaviour every screen already had — where matchMedia does not exist, instead of throwing', () => {
    delete window.matchMedia;
    expect(renderHook(() => useViewportTier()).result.current).toBe('desktop');
  });
});
