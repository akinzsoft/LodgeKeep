import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformAuthProvider, usePlatformAuth } from '../../auth/PlatformAuthContext.jsx';
import { PlatformMfaEnrollScreen } from '../PlatformMfaEnrollScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ login: vi.fn(), enrollConfirm: vi.fn(), configureApiClient: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, login: mocks.login, enrollConfirm: mocks.enrollConfirm }, configureApiClient: mocks.configureApiClient };
});

/** `enrollment` is private context state, populated only by a real `login()` resolving `mfa_enrollment_required` — drive it the same way a real user reaches this screen. */
function Harness() {
  const { status, login } = usePlatformAuth();
  useEffect(() => {
    if (status === 'idle') login('ops@lodgekeep.test', 'a real password');
  }, [status, login]);
  if (status !== 'mfa_enrollment_required') return null;
  return <PlatformMfaEnrollScreen />;
}

function renderScreen() {
  return render(
    <PlatformAuthProvider>
      <Harness />
    </PlatformAuthProvider>
  );
}

describe('<PlatformMfaEnrollScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.login.mockResolvedValue({
      status: 'mfa_enrollment_required',
      enrollmentToken: 'enroll-token',
      otpAuthUrl: 'otpauth://totp/x',
      qrCodeDataUrl: 'data:image/png;base64,abc',
      manualEntryKey: 'ABCDEFGHIJ',
    });
  });

  it('shows the real QR code and manual entry key', async () => {
    renderScreen();
    expect(await screen.findByAltText('Scan with your authenticator app')).toHaveAttribute('src', 'data:image/png;base64,abc');
    expect(screen.getByText('ABCDEFGHIJ')).toBeInTheDocument();
  });

  it('confirms with the entered code', async () => {
    mocks.enrollConfirm.mockResolvedValue({ status: 'ok', accessToken: 'token' });
    renderScreen();
    await screen.findByAltText('Scan with your authenticator app');

    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }));

    expect(mocks.enrollConfirm).toHaveBeenCalledWith('enroll-token', '123456');
  });

  it('surfaces a real wrong-code error', async () => {
    mocks.enrollConfirm.mockRejectedValue(new ApiError({ code: 'AUTH_MFA_CODE_INVALID', message: 'That verification code is incorrect or has expired.' }));
    renderScreen();
    await screen.findByAltText('Scan with your authenticator app');

    await userEvent.type(screen.getByLabelText('6-digit code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That verification code is incorrect or has expired.');
  });
});
