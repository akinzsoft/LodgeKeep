import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { PlatformAuthProvider, usePlatformAuth } from '../PlatformAuthContext.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  enrollConfirm: vi.fn(),
  verifyMfa: vi.fn(),
  startImpersonation: vi.fn(),
  endImpersonation: vi.fn(),
  configureApiClient: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    platformApi: { ...actual.platformApi, ...mocks },
    configureApiClient: mocks.configureApiClient,
  };
});

function wrapper({ children }) {
  return <PlatformAuthProvider>{children}</PlatformAuthProvider>;
}

describe('PlatformAuthProvider / usePlatformAuth', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('returns to login when an authenticated request is rejected', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge' });
    mocks.verifyMfa.mockResolvedValue({ accessToken: 'access-token' });
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@test', 'password'));
    await act(() => result.current.verifyMfa('123456'));
    const config = mocks.configureApiClient.mock.calls.at(-1)[0];
    expect(config.authenticationFailedHandler).toEqual(expect.any(Function));
    act(() => config.authenticationFailedHandler(new ApiError({ code: 'AUTH_TOKEN_EXPIRED', status: 401 })));
    expect(result.current.status).toBe('idle');
    expect(config.accessTokenGetter()).toBeNull();
  });

  it('starts idle', () => {
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    expect(result.current.status).toBe('idle');
  });

  it('login resolves to mfa_enrollment_required for a first-ever login', async () => {
    mocks.login.mockResolvedValue({
      status: 'mfa_enrollment_required',
      enrollmentToken: 'enroll-token',
      otpAuthUrl: 'otpauth://totp/x',
      qrCodeDataUrl: 'data:image/png;base64,abc',
      manualEntryKey: 'ABCDEF',
    });
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });

    await act(() => result.current.login('ops@lodgekeep.test', 'password'));

    expect(result.current.status).toBe('mfa_enrollment_required');
    expect(result.current.enrollment.manualEntryKey).toBe('ABCDEF');
  });

  it('login resolves to mfa_challenge_required for an already-enrolled account', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });

    await act(() => result.current.login('ops@lodgekeep.test', 'password'));

    expect(result.current.status).toBe('mfa_challenge_required');
  });

  it('a failed login surfaces the real backend error and returns to idle', async () => {
    mocks.login.mockRejectedValue(new ApiError({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Email or password is incorrect.' }));
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });

    await act(() => result.current.login('ops@lodgekeep.test', 'wrong'));

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBe('Email or password is incorrect.');
  });

  it('confirmEnrollment success activates the platform token and reaches authenticated', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_enrollment_required', enrollmentToken: 'enroll-token', manualEntryKey: 'ABCDEF' });
    mocks.enrollConfirm.mockResolvedValue({ status: 'ok', accessToken: 'platform-access-token' });
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@lodgekeep.test', 'password'));

    await act(() => result.current.confirmEnrollment('123456'));

    expect(mocks.enrollConfirm).toHaveBeenCalledWith('enroll-token', '123456');
    expect(result.current.status).toBe('authenticated');
    expect(mocks.configureApiClient).toHaveBeenCalledWith(expect.objectContaining({ accessTokenGetter: expect.any(Function) }));
    const lastCall = mocks.configureApiClient.mock.calls.at(-1)[0];
    expect(lastCall.accessTokenGetter()).toBe('platform-access-token');
  });

  it('confirmEnrollment failure keeps the enrollment state and surfaces the error', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_enrollment_required', enrollmentToken: 'enroll-token', manualEntryKey: 'ABCDEF' });
    mocks.enrollConfirm.mockRejectedValue(new ApiError({ code: 'AUTH_MFA_CODE_INVALID', message: 'That verification code is incorrect or has expired.' }));
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@lodgekeep.test', 'password'));

    await act(() => result.current.confirmEnrollment('000000'));

    expect(result.current.status).toBe('mfa_enrollment_required');
    expect(result.current.error).toBe('That verification code is incorrect or has expired.');
  });

  it('verifyMfa success activates the platform token and reaches authenticated', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
    mocks.verifyMfa.mockResolvedValue({ status: 'ok', accessToken: 'platform-access-token' });
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@lodgekeep.test', 'password'));

    await act(() => result.current.verifyMfa('654321'));

    expect(mocks.verifyMfa).toHaveBeenCalledWith('challenge-token', '654321');
    expect(result.current.status).toBe('authenticated');
  });

  it('cancelChallenge returns to idle from either MFA state', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@lodgekeep.test', 'password'));

    act(() => result.current.cancelChallenge());

    expect(result.current.status).toBe('idle');
  });

  it('startImpersonation success swaps to the impersonation token and reaches impersonating', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
    mocks.verifyMfa.mockResolvedValue({ status: 'ok', accessToken: 'platform-access-token' });
    mocks.startImpersonation.mockResolvedValue({
      accessToken: 'impersonation-access-token',
      tenantId: '10',
      tenantName: 'Acme Hotels',
      propertyId: '20',
      impersonationSessionId: '30',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@lodgekeep.test', 'password'));
    await act(() => result.current.verifyMfa('654321'));

    await act(() => result.current.startImpersonation('10', { propertyId: '20', reason: 'Support ticket' }));

    expect(result.current.status).toBe('impersonating');
    expect(result.current.impersonation.tenantName).toBe('Acme Hotels');
    const lastCall = mocks.configureApiClient.mock.calls.at(-1)[0];
    expect(lastCall.accessTokenGetter()).toBe('impersonation-access-token');
  });

  it('startImpersonation failure stays authenticated and surfaces the error', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
    mocks.verifyMfa.mockResolvedValue({ status: 'ok', accessToken: 'platform-access-token' });
    mocks.startImpersonation.mockRejectedValue(new ApiError({ code: 'VALIDATION_MISSING_FIELD', message: '"reason" is required to start an impersonation session.' }));
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@lodgekeep.test', 'password'));
    await act(() => result.current.verifyMfa('654321'));

    await act(() => result.current.startImpersonation('10', { propertyId: '20', reason: '' }));

    expect(result.current.status).toBe('authenticated');
    expect(result.current.error).toBe('"reason" is required to start an impersonation session.');
  });

  it('exitImpersonation ends the grant and swaps back to the platform token', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
    mocks.verifyMfa.mockResolvedValue({ status: 'ok', accessToken: 'platform-access-token' });
    mocks.startImpersonation.mockResolvedValue({
      accessToken: 'impersonation-access-token',
      tenantId: '10',
      tenantName: 'Acme Hotels',
      propertyId: '20',
      impersonationSessionId: '30',
    });
    mocks.endImpersonation.mockResolvedValue({ ended: true });
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@lodgekeep.test', 'password'));
    await act(() => result.current.verifyMfa('654321'));
    await act(() => result.current.startImpersonation('10', { propertyId: '20', reason: 'Support ticket' }));

    await act(() => result.current.exitImpersonation());

    expect(mocks.endImpersonation).toHaveBeenCalled();
    expect(result.current.status).toBe('authenticated');
    expect(result.current.impersonation).toBeNull();
    const lastCall = mocks.configureApiClient.mock.calls.at(-1)[0];
    expect(lastCall.accessTokenGetter()).toBe('platform-access-token');
  });

  it('exitImpersonation still returns to the console even if the end call fails — never traps the admin inside the view', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
    mocks.verifyMfa.mockResolvedValue({ status: 'ok', accessToken: 'platform-access-token' });
    mocks.startImpersonation.mockResolvedValue({ accessToken: 'impersonation-access-token', tenantId: '10', tenantName: 'Acme Hotels', propertyId: '20', impersonationSessionId: '30' });
    mocks.endImpersonation.mockRejectedValue(new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server.' }));
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@lodgekeep.test', 'password'));
    await act(() => result.current.verifyMfa('654321'));
    await act(() => result.current.startImpersonation('10', { propertyId: '20', reason: 'Support ticket' }));

    await act(() => result.current.exitImpersonation());

    expect(result.current.status).toBe('authenticated');
  });

  it('logout clears every token and returns to idle', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
    mocks.verifyMfa.mockResolvedValue({ status: 'ok', accessToken: 'platform-access-token' });
    const { result } = renderHook(() => usePlatformAuth(), { wrapper });
    await act(() => result.current.login('ops@lodgekeep.test', 'password'));
    await act(() => result.current.verifyMfa('654321'));

    act(() => result.current.logout());

    await waitFor(() => expect(result.current.status).toBe('idle'));
  });
});
