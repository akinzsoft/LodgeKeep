import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const popup = vi.hoisted(() => ({ openPaystackPopup: vi.fn() }));
vi.mock('../../paystack.js', () => popup);

import { usePaystackLauncher } from '../usePaystackLauncher.js';

describe('usePaystackLauncher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    popup.openPaystackPopup.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('ignores a second launch while the first is in flight (double click)', async () => {
    let handlers;
    popup.openPaystackPopup.mockImplementation((args) => {
      handlers = args;
      return Promise.resolve();
    });
    const { result } = renderHook(() => usePaystackLauncher());

    let first;
    let second;
    act(() => {
      first = result.current.launch({ accessCode: 'ac_1' });
      second = result.current.launch({ accessCode: 'ac_1' });
    });
    expect(await second).toBe('ignored');
    expect(popup.openPaystackPopup).toHaveBeenCalledTimes(1);
    expect(result.current.opening).toBe(true);

    act(() => handlers.onClose());
    expect(await first).toBe('closed');
    expect(result.current.opening).toBe(false);

    // Once finished, a later launch works again.
    act(() => {
      result.current.launch({ accessCode: 'ac_1' });
    });
    expect(popup.openPaystackPopup).toHaveBeenCalledTimes(2);
  });

  it('offers the payment-page link if the window has not opened after 5 seconds', () => {
    popup.openPaystackPopup.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => usePaystackLauncher());
    act(() => {
      result.current.launch({ accessCode: 'ac_9', authorizationUrl: 'https://checkout.paystack.com/server-url' });
    });
    act(() => vi.advanceTimersByTime(4900));
    expect(result.current.fallbackUrl).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.fallbackUrl).toBe('https://checkout.paystack.com/server-url');
  });

  it('derives the hosted page from the access code when the server sent no URL', () => {
    popup.openPaystackPopup.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => usePaystackLauncher());
    act(() => {
      result.current.launch({ accessCode: 'ac_9' });
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.fallbackUrl).toBe('https://checkout.paystack.com/ac_9');
  });

  it('shows no link when the window reports it is open in time', () => {
    popup.openPaystackPopup.mockImplementation((args) => {
      args.onOpen();
      return Promise.resolve();
    });
    const { result } = renderHook(() => usePaystackLauncher());
    act(() => {
      result.current.launch({ accessCode: 'ac_1' });
    });
    expect(result.current.opening).toBe(false);
    act(() => vi.advanceTimersByTime(10000));
    expect(result.current.fallbackUrl).toBeNull();
  });

  it('shows the link at once and rejects when the Paystack script cannot load', async () => {
    popup.openPaystackPopup.mockRejectedValue(new Error('no script'));
    const { result } = renderHook(() => usePaystackLauncher());
    let promise;
    await act(async () => {
      promise = result.current.launch({ accessCode: 'ac_2' });
      await promise.catch(() => {});
    });
    await expect(promise).rejects.toThrow('no script');
    expect(result.current.fallbackUrl).toBe('https://checkout.paystack.com/ac_2');
    expect(result.current.opening).toBe(false);
  });
});
