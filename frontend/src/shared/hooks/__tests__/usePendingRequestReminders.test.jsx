import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePendingRequestReminders, forgetRequestReminders } from '../usePendingRequestReminders.js';

const mocks = vi.hoisted(() => ({ listRequestsAwaitingMe: vi.fn() }));
vi.mock('../../api/index.js', () => ({ stockApi: mocks }));

function pending(id, extra = {}) {
  return {
    id: String(id),
    status: 'pending',
    requestedAt: '2027-07-01T18:00:00Z',
    fromOutlet: { id: '1', name: 'Main Store' },
    toOutlet: { id: '2', name: 'Main Bar' },
    topUpOfRequestId: null,
    lines: [{ stockItemId: '20' }, { stockItemId: '21' }],
    ...extra,
  };
}

const flush = () => act(async () => {});

describe('usePendingRequestReminders', () => {
  beforeEach(() => {
    mocks.listRequestsAwaitingMe.mockReset();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('at sign-in, shows each pending request as a "Stock requested" card, once, and beeps once', async () => {
    mocks.listRequestsAwaitingMe.mockResolvedValue([pending(5), pending(9, { topUpOfRequestId: '5' })]);
    const onShow = vi.fn();
    const { result } = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1', onShow }));

    await waitFor(() => expect(result.current.reminders).toHaveLength(2));
    expect(result.current.reminders[0]).toMatchObject({
      id: 'reminder:5',
      reminder: true,
      type: 'stock.transfer_requested',
      created_at: '2027-07-01T18:00:00Z',
      payload: { requestId: 5, fromOutletName: 'Main Store', toOutletName: 'Main Bar', lineCount: 2, topUpOfRequestId: null, reminder: true },
    });
    expect(result.current.reminders[1].payload.topUpOfRequestId).toBe(5);
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(mocks.listRequestsAwaitingMe).toHaveBeenCalledTimes(1);
  });

  it('does not show again on a reload of the same sign-in, but does after signing out and in again', async () => {
    mocks.listRequestsAwaitingMe.mockResolvedValue([pending(5)]);
    const first = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1' }));
    await waitFor(() => expect(first.result.current.reminders).toHaveLength(1));
    first.unmount();

    // A reload: same tab, same sign-in.
    const reload = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1' }));
    await flush();
    expect(reload.result.current.reminders).toEqual([]);
    expect(mocks.listRequestsAwaitingMe).toHaveBeenCalledTimes(1);
    reload.unmount();

    // Signed out, then in again: whatever is still pending shows again.
    forgetRequestReminders();
    const again = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1' }));
    await waitFor(() => expect(again.result.current.reminders).toHaveLength(1));
    expect(mocks.listRequestsAwaitingMe).toHaveBeenCalledTimes(2);
  });

  it('a resolved request is not shown at the next sign-in, and nothing beeps when nothing is waiting', async () => {
    mocks.listRequestsAwaitingMe.mockResolvedValueOnce([pending(5)]).mockResolvedValueOnce([]);
    const first = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1' }));
    await waitFor(() => expect(first.result.current.reminders).toHaveLength(1));
    first.unmount();
    forgetRequestReminders();

    const onShow = vi.fn();
    const next = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1', onShow }));
    await waitFor(() => expect(mocks.listRequestsAwaitingMe).toHaveBeenCalledTimes(2));
    await flush();
    expect(next.result.current.reminders).toEqual([]);
    expect(onShow).not.toHaveBeenCalled();
  });

  it('dismissing a card hides it for the rest of this sign-in', async () => {
    mocks.listRequestsAwaitingMe.mockResolvedValue([pending(5), pending(6)]);
    const { result } = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1' }));
    await waitFor(() => expect(result.current.reminders).toHaveLength(2));
    act(() => result.current.dismiss('reminder:5'));
    expect(result.current.reminders.map((card) => card.id)).toEqual(['reminder:6']);
  });

  it('does nothing for someone who cannot issue stock, or before they are signed in', async () => {
    renderHook(() => usePendingRequestReminders({ enabled: false, sessionKey: 'u1:p1' }));
    renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: null }));
    await flush();
    expect(mocks.listRequestsAwaitingMe).not.toHaveBeenCalled();
  });

  it('switching property reminds for that property; the previous property\'s cards are not shown', async () => {
    mocks.listRequestsAwaitingMe.mockResolvedValueOnce([pending(5)]).mockResolvedValueOnce([pending(7)]);
    const { result, rerender } = renderHook(({ sessionKey }) => usePendingRequestReminders({ enabled: true, sessionKey }), { initialProps: { sessionKey: 'u1:p1' } });
    await waitFor(() => expect(result.current.reminders.map((card) => card.id)).toEqual(['reminder:5']));
    rerender({ sessionKey: 'u1:p2' });
    expect(result.current.reminders).toEqual([]);
    await waitFor(() => expect(result.current.reminders.map((card) => card.id)).toEqual(['reminder:7']));
  });

  it('a failed check is tried again on the next reload rather than marked as shown', async () => {
    mocks.listRequestsAwaitingMe.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([pending(5)]);
    const first = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1' }));
    await flush();
    expect(first.result.current.reminders).toEqual([]);
    first.unmount();
    const retry = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1' }));
    await waitFor(() => expect(retry.result.current.reminders).toHaveLength(1));
  });

  it('still reminds when the browser blocks session storage', async () => {
    vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mocks.listRequestsAwaitingMe.mockResolvedValue([pending(5)]);
    const { result } = renderHook(() => usePendingRequestReminders({ enabled: true, sessionKey: 'u1:p1' }));
    await waitFor(() => expect(result.current.reminders).toHaveLength(1));
    expect(() => forgetRequestReminders()).not.toThrow();
  });
});
