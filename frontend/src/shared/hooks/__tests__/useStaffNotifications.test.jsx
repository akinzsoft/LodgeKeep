import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStaffNotifications, NOTIFICATION_POLL_MS } from '../useStaffNotifications.js';

const mocks = vi.hoisted(() => ({
  listBellNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

vi.mock('../../api/index.js', () => ({ notificationsApi: mocks }));

function row(id, extra = {}) {
  return { id: String(id), type: 'qr_ordering.guest_order_placed', payload: {}, read_at: null, popup: true, created_at: '2026-09-13T12:00:00Z', ...extra };
}

describe('useStaffNotifications', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.markNotificationRead.mockResolvedValue({});
    mocks.markAllNotificationsRead.mockResolvedValue({ updated: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the feed and unread count, and never pops up the backlog already there at sign-in', async () => {
    mocks.listBellNotifications.mockResolvedValue({ notifications: [row(1)], unreadCount: 4 });
    const { result } = renderHook(() => useStaffNotifications({ enabled: true, sessionKey: 'u1' }));
    await waitFor(() => expect(result.current.unreadCount).toBe(4));
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.popups).toEqual([]);
  });

  it('polls, and pops up a QR order that arrives after the first load exactly once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.listBellNotifications.mockResolvedValueOnce({ notifications: [], unreadCount: 0 });
    const { result } = renderHook(() => useStaffNotifications({ enabled: true, sessionKey: 'u1' }));
    await waitFor(() => expect(mocks.listBellNotifications).toHaveBeenCalledTimes(1));

    mocks.listBellNotifications.mockResolvedValue({ notifications: [row(7), row(8, { popup: false })], unreadCount: 2 });
    await act(async () => {
      vi.advanceTimersByTime(NOTIFICATION_POLL_MS);
    });
    await waitFor(() => expect(result.current.popups.map((p) => p.id)).toEqual(['7']));

    await act(async () => {
      vi.advanceTimersByTime(NOTIFICATION_POLL_MS);
    });
    await waitFor(() => expect(mocks.listBellNotifications).toHaveBeenCalledTimes(3));
    expect(result.current.popups.map((p) => p.id)).toEqual(['7']);
  });

  it('ignores a slow older response that lands after a newer one', async () => {
    let resolveFirst;
    mocks.listBellNotifications
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ notifications: [row(2, { popup: false })], unreadCount: 1 });
    const { result } = renderHook(() => useStaffNotifications({ enabled: true, sessionKey: 'u1' }));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.unreadCount).toBe(1);
    await act(async () => {
      resolveFirst({ notifications: [], unreadCount: 99 });
    });
    expect(result.current.unreadCount).toBe(1);
  });

  it('marking a popup read removes its card and refreshes the feed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.listBellNotifications.mockResolvedValueOnce({ notifications: [], unreadCount: 0 });
    const { result } = renderHook(() => useStaffNotifications({ enabled: true, sessionKey: 'u1' }));
    await waitFor(() => expect(mocks.listBellNotifications).toHaveBeenCalledTimes(1));
    mocks.listBellNotifications.mockResolvedValueOnce({ notifications: [row(5)], unreadCount: 1 });
    await act(async () => {
      vi.advanceTimersByTime(NOTIFICATION_POLL_MS);
    });
    await waitFor(() => expect(result.current.popups).toHaveLength(1));

    mocks.listBellNotifications.mockResolvedValue({ notifications: [row(5, { read_at: '2026-09-13T12:01:00Z' })], unreadCount: 0 });
    await act(async () => {
      await result.current.markRead('5');
    });
    expect(mocks.markNotificationRead).toHaveBeenCalledWith('5');
    expect(result.current.popups).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
  });

  it('does nothing while disabled', () => {
    renderHook(() => useStaffNotifications({ enabled: false }));
    expect(mocks.listBellNotifications).not.toHaveBeenCalled();
  });
});
