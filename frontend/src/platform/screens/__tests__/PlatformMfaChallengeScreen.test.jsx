import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformAuthProvider, usePlatformAuth } from '../../auth/PlatformAuthContext.jsx';
import { PlatformMfaChallengeScreen } from '../PlatformMfaChallengeScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ login: vi.fn(), verifyMfa: vi.fn(), configureApiClient: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, login: mocks.login, verifyMfa: mocks.verifyMfa }, configureApiClient: mocks.configureApiClient };
});

function Harness() {
  const { status, login } = usePlatformAuth();
  useEffect(() => {
    if (status === 'idle') login('ops@lodgekeep.test', 'a real password');
  }, [status, login]);
  if (status !== 'mfa_challenge_required') return null;
  return <PlatformMfaChallengeScreen />;
}

function renderScreen() {
  return render(
    <PlatformAuthProvider>
      <Harness />
    </PlatformAuthProvider>
  );
}

describe('<PlatformMfaChallengeScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
  });

  it('submits the entered code', async () => {
    mocks.verifyMfa.mockResolvedValue({ status: 'ok', accessToken: 'token' });
    renderScreen();
    await screen.findByLabelText('6-digit code');

    await userEvent.type(screen.getByLabelText('6-digit code'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(mocks.verifyMfa).toHaveBeenCalledWith('challenge-token', '654321');
  });

  it('surfaces a real wrong-code error', async () => {
    mocks.verifyMfa.mockRejectedValue(new ApiError({ code: 'AUTH_MFA_CODE_INVALID', message: 'That verification code is incorrect or has expired.' }));
    renderScreen();
    await screen.findByLabelText('6-digit code');

    await userEvent.type(screen.getByLabelText('6-digit code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That verification code is incorrect or has expired.');
  });
});
