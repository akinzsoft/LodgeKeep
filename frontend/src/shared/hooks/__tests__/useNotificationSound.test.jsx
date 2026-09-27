import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNotificationSound, NOTIFICATION_SOUND_KEY } from '../useNotificationSound.js';

describe('useNotificationSound', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('is on by default and remembers being turned off on this device', () => {
    const { result } = renderHook(() => useNotificationSound());
    expect(result.current.enabled).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(false);
    expect(window.localStorage.getItem(NOTIFICATION_SOUND_KEY)).toBe('off');

    const { result: later } = renderHook(() => useNotificationSound());
    expect(later.current.enabled).toBe(false);
  });

  it('still works when browser storage is blocked', () => {
    vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useNotificationSound());
    expect(result.current.enabled).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(false);
  });
});
