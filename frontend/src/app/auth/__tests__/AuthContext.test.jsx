import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthContext.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  switchProperty: vi.fn(),
  refresh: vi.fn(),
  requestPasswordReset: vi.fn(),
  completePasswordReset: vi.fn(),
  configureApiClient: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    authApi: {
      login: mocks.login,
      logout: mocks.logout,
      switchProperty: mocks.switchProperty,
      refresh: mocks.refresh,
      requestPasswordReset: mocks.requestPasswordReset,
      completePasswordReset: mocks.completePasswordReset,
    },
    configureApiClient: mocks.configureApiClient,
  };
});

function wrapper({ children }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('AuthProvider / useAuth', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('starts idle with no user', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.status).toBe('idle');
    expect(result.current.user).toBeNull();
  });

  it('login() stores the session and moves to authenticated', async () => {
    mocks.login.mockResolvedValue({
      status: 'ok',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tenantId: '1',
      userId: '2',
      activePropertyId: '3',
      role: 'manager',
      properties: [{ propertyId: '3', role: 'manager' }],
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login({ email: 'sam@example.com', password: 'x' });
    });

    expect(result.current.status).toBe('authenticated');
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toMatchObject({
      userId: '2',
      tenantId: '1',
      activePropertyId: '3',
      role: 'manager',
      email: 'sam@example.com',
    });
  });

  it('login() with an MFA challenge does not authenticate (TESTING.md AUTH-9)', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required' });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login({ email: 'admin@example.com', password: 'x' });
    });

    expect(result.current.status).toBe('mfa_required');
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it('login() failure surfaces a plain-sentence error, never a raw exception (DESIGN_SYSTEM.md §2)', async () => {
    mocks.login.mockRejectedValue(new ApiError({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Email or password is incorrect.' }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await expect(result.current.login({ email: 'x@example.com', password: 'wrong' })).rejects.toBeDefined();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toEqual({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
  });

  it('logout() clears the session even when the network call fails (best-effort)', async () => {
    mocks.login.mockResolvedValue({
      status: 'ok', accessToken: 'a', refreshToken: 'r', tenantId: '1', userId: '2', activePropertyId: null, role: 'manager', properties: [],
    });
    mocks.logout.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login({ email: 'sam@example.com', password: 'x' });
    });
    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.user).toBeNull();
    expect(mocks.logout).toHaveBeenCalledWith({ refreshToken: 'r' });
  });

  it('switchProperty() updates the active property and role from the response', async () => {
    mocks.login.mockResolvedValue({
      status: 'ok', accessToken: 'a', refreshToken: 'r', tenantId: '1', userId: '2', activePropertyId: '3', role: 'manager',
      properties: [{ propertyId: '3', role: 'manager' }, { propertyId: '4', role: 'front_desk' }],
    });
    mocks.switchProperty.mockResolvedValue({ accessToken: 'a2', activePropertyId: '4', role: 'front_desk' });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login({ email: 'sam@example.com', password: 'x' });
    });
    await act(async () => {
      await result.current.switchProperty('4');
    });

    expect(mocks.switchProperty).toHaveBeenCalledWith({ propertyId: '4' });
    expect(result.current.user.activePropertyId).toBe('4');
    expect(result.current.user.role).toBe('front_desk');
  });

  it('registers a refresh handler with configureApiClient that moves to session_expired on a failed refresh (TESTING.md FE-6)', async () => {
    mocks.login.mockResolvedValue({
      status: 'ok', accessToken: 'a', refreshToken: 'r', tenantId: '1', userId: '2', activePropertyId: null, role: 'manager', properties: [],
    });
    mocks.refresh.mockRejectedValue(new ApiError({ code: 'AUTH_TOKEN_INVALID', message: 'This session has expired. Please log in again.' }));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login({ email: 'sam@example.com', password: 'x' });
    });

    expect(mocks.configureApiClient).toHaveBeenCalled();
    const { accessTokenExpiredHandler } = mocks.configureApiClient.mock.calls.at(-1)[0];

    await act(async () => {
      await expect(accessTokenExpiredHandler()).rejects.toBeDefined();
    });

    expect(result.current.status).toBe('session_expired');
    expect(result.current.user).toBeNull();
    expect(result.current.error.message).toMatch(/session has expired/i);
  });

  it('the refresh handler restores a new access token on success, without changing status', async () => {
    mocks.login.mockResolvedValue({
      status: 'ok', accessToken: 'a', refreshToken: 'r', tenantId: '1', userId: '2', activePropertyId: '3', role: 'manager', properties: [],
    });
    mocks.refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login({ email: 'sam@example.com', password: 'x' });
    });

    const { accessTokenExpiredHandler } = mocks.configureApiClient.mock.calls.at(-1)[0];
    let newToken;
    await act(async () => {
      newToken = await accessTokenExpiredHandler();
    });

    expect(newToken).toBe('a2');
    expect(mocks.refresh).toHaveBeenCalledWith({ refreshToken: 'r', propertyId: '3' });
    expect(result.current.status).toBe('authenticated');
  });

  it('useAuth() throws when called outside an AuthProvider', () => {
    function Consumer() {
      useAuth();
      return null;
    }
    expect(() => render(<Consumer />)).toThrow(/must be called within an <AuthProvider>/);
  });
});
