import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNewVersionAvailable, VERSION_CHECK_MS } from '../useNewVersionAvailable.js';

const mocks = vi.hoisted(() => ({ fetchDeployedBuildId: vi.fn() }));
vi.mock('../../api/index.js', () => mocks);

describe('useNewVersionAvailable', () => {
  beforeEach(() => {
    mocks.fetchDeployedBuildId.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays false while the server serves the build this page is running', async () => {
    mocks.fetchDeployedBuildId.mockResolvedValue('build-1');
    const { result } = renderHook(() => useNewVersionAvailable({ enabled: true, currentBuildId: 'build-1' }));
    await act(async () => {
      vi.advanceTimersByTime(VERSION_CHECK_MS);
    });
    expect(mocks.fetchDeployedBuildId).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
  });

  it('turns true once a different build is deployed, and stays true', async () => {
    mocks.fetchDeployedBuildId.mockResolvedValue('build-2');
    const { result } = renderHook(() => useNewVersionAvailable({ enabled: true, currentBuildId: 'build-1' }));
    await act(async () => {
      vi.advanceTimersByTime(VERSION_CHECK_MS);
    });
    await waitFor(() => expect(result.current).toBe(true));

    mocks.fetchDeployedBuildId.mockResolvedValue(null); // a later failed check changes nothing
    await act(async () => {
      vi.advanceTimersByTime(VERSION_CHECK_MS);
    });
    expect(result.current).toBe(true);
  });

  it('checks straight away when the tab comes back into view or the window regains focus', async () => {
    mocks.fetchDeployedBuildId.mockResolvedValue('build-2');
    const { result } = renderHook(() => useNewVersionAvailable({ enabled: true, currentBuildId: 'build-1' }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(result.current).toBe(true));
    expect(mocks.fetchDeployedBuildId).toHaveBeenCalledTimes(1);
  });

  it('ignores an unreadable version file (offline, dev server, mid-deploy)', async () => {
    mocks.fetchDeployedBuildId.mockResolvedValue(null);
    const { result } = renderHook(() => useNewVersionAvailable({ enabled: true, currentBuildId: 'build-1' }));
    await act(async () => {
      vi.advanceTimersByTime(VERSION_CHECK_MS);
    });
    expect(result.current).toBe(false);
  });

  it('never checks when disabled (development and tests)', async () => {
    renderHook(() => useNewVersionAvailable({ enabled: false, currentBuildId: 'build-1' }));
    await act(async () => {
      vi.advanceTimersByTime(VERSION_CHECK_MS * 2);
      window.dispatchEvent(new Event('focus'));
    });
    expect(mocks.fetchDeployedBuildId).not.toHaveBeenCalled();
  });
});
