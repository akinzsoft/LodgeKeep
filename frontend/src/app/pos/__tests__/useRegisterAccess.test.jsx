import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ getMyOutlets: vi.fn(), listOutlets: vi.fn() }));
vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks };
});

import { useRegisterAccess, navPermissionsFor } from '../useRegisterAccess.js';
import { isNavItemAllowed } from '../../shell/nav-config.js';

const BAR = { id: '1', name: 'Main Bar', type: 'bar' };
const STORE = { id: '2', name: 'Main Store', type: 'store' };
const MART = { id: '3', name: 'Mini Mart', type: 'supermarket' };

describe('useRegisterAccess', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([BAR, STORE, MART]);
    mocks.getMyOutlets.mockResolvedValue({ restricted: false, outletIds: null });
  });

  it('does nothing (and says "unknown") when not enabled', () => {
    const { result } = renderHook(() => useRegisterAccess({ enabled: false, sessionKey: '1:1' }));
    expect(result.current).toEqual({ known: false, canOperateRegister: true });
    expect(mocks.listOutlets).not.toHaveBeenCalled();
  });

  it('says a mart-only user cannot operate the Register, once the answer arrives', async () => {
    mocks.getMyOutlets.mockResolvedValue({ restricted: true, outletIds: ['3'] });
    const { result } = renderHook(() => useRegisterAccess({ enabled: true, sessionKey: '7:1' }));
    expect(result.current.canOperateRegister).toBe(true); // never hidden before it is known
    await waitFor(() => expect(result.current).toEqual({ known: true, canOperateRegister: false }));
  });

  it('says a bar operator can', async () => {
    mocks.getMyOutlets.mockResolvedValue({ restricted: true, outletIds: ['1'] });
    const { result } = renderHook(() => useRegisterAccess({ enabled: true, sessionKey: '8:1' }));
    await waitFor(() => expect(result.current).toEqual({ known: true, canOperateRegister: true }));
  });

  it('never hides POS on a failed lookup (the server still decides)', async () => {
    mocks.listOutlets.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useRegisterAccess({ enabled: true, sessionKey: '9:1' }));
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.canOperateRegister).toBe(true);
  });

  it('asks again for a different user or property and drops the old answer', async () => {
    mocks.getMyOutlets.mockResolvedValueOnce({ restricted: true, outletIds: ['3'] }).mockResolvedValue({ restricted: true, outletIds: ['1'] });
    const { result, rerender } = renderHook(({ key }) => useRegisterAccess({ enabled: true, sessionKey: key }), { initialProps: { key: '7:1' } });
    await waitFor(() => expect(result.current.canOperateRegister).toBe(false));
    rerender({ key: '8:1' });
    expect(result.current.known).toBe(false);
    await waitFor(() => expect(result.current).toEqual({ known: true, canOperateRegister: true }));
  });
});

describe('navPermissionsFor', () => {
  const cashier = new Set(['pos.operate', 'pos.stock_view', 'pos.stock_request', 'supermarket.sales']);

  it('hides POS from a user who can operate no Register outlet, and leaves Supermarket', () => {
    const nav = navPermissionsFor(cashier, { known: true, canOperateRegister: false });
    expect(isNavItemAllowed('pos', nav)).toBe(false);
    expect(isNavItemAllowed('supermarket', nav)).toBe(true);
  });

  it('keeps POS for a bar/restaurant operator, and before the answer is known', () => {
    expect(isNavItemAllowed('pos', navPermissionsFor(cashier, { known: true, canOperateRegister: true }))).toBe(true);
    expect(isNavItemAllowed('pos', navPermissionsFor(cashier, { known: false, canOperateRegister: true }))).toBe(true);
  });

  it('never hides POS from anyone with pos.manage (Setup, Sales, QR codes), and shows both for a manager', () => {
    const manager = new Set([...cashier, 'pos.manage', 'supermarket.manage']);
    const nav = navPermissionsFor(manager, { known: true, canOperateRegister: false });
    expect(isNavItemAllowed('pos', nav)).toBe(true);
    expect(isNavItemAllowed('supermarket', nav)).toBe(true);
  });

  it('does not change the original permission set', () => {
    navPermissionsFor(cashier, { known: true, canOperateRegister: false });
    expect(cashier.has('pos.operate')).toBe(true);
  });
});
