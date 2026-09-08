import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from '../../AuthContext.jsx';
import { MfaChallengeScreen } from '../MfaChallengeScreen.jsx';
import { ApiError } from '../../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  verifyMfa: vi.fn(),
  logout: vi.fn(),
  switchProperty: vi.fn(),
  refresh: vi.fn(),
  requestPasswordReset: vi.fn(),
  completePasswordReset: vi.fn(),
  configureApiClient: vi.fn(),
}));

vi.mock('../../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../../shared/api/index.js');
  return {
    ...actual,
    authApi: {
      login: mocks.login,
      verifyMfa: mocks.verifyMfa,
      logout: mocks.logout,
      switchProperty: mocks.switchProperty,
      refresh: mocks.refresh,
      requestPasswordReset: mocks.requestPasswordReset,
      completePasswordReset: mocks.completePasswordReset,
    },
    configureApiClient: mocks.configureApiClient,
  };
});

/**
 * `mfaChallenge` (the challenge token `verifyMfa` needs) is private
 * AuthContext state, only ever populated by a real `login()` call that
 * resolves `mfa_challenge_required` — so reaching a realistic "MFA screen
 * with a live challenge" render means driving a real login first, the same
 * way `main.jsx` would, rather than reaching into AuthContext internals.
 */
function Harness() {
  const { status, login } = useAuth();
  return (
    <>
      <button onClick={() => login({ email: 'admin@example.com', password: 'x' })}>trigger-login</button>
      {status === 'mfa_required' && <MfaChallengeScreen />}
    </>
  );
}

describe('<MfaChallengeScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('renders a real code-entry form for the real, emailed code', () => {
    render(
      <AuthProvider>
        <MfaChallengeScreen />
      </AuthProvider>
    );
    expect(screen.getByRole('heading', { name: 'Verification required' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported, live-tested): "the verification code shld
   * be send to the account email to login not a static code."
   */
  it('shows the real dev-only code as a disclosure, never a substitute for the form', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-abc', dev_only_code: '482913' });

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'trigger-login' }));
    await screen.findByRole('heading', { name: 'Verification required' });

    expect(screen.getByText('482913')).toBeInTheDocument();
    // The disclosure never replaces the real form — still a real textbox to type into.
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows no disclosure at all when the backend discloses no code (production)', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-abc', dev_only_code: null });

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'trigger-login' }));
    await screen.findByRole('heading', { name: 'Verification required' });

    expect(screen.queryByText(/Dev-only/)).not.toBeInTheDocument();
  });

  it('submits the entered code against POST /auth/mfa/verify and reaches authenticated on success', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-abc' });
    mocks.verifyMfa.mockResolvedValue({
      status: 'ok',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tenantId: '1',
      userId: '2',
      activePropertyId: '3',
      role: 'admin',
      properties: [{ propertyId: '3', role: 'admin' }],
    });

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'trigger-login' }));
    await screen.findByRole('heading', { name: 'Verification required' });

    await userEvent.type(screen.getByRole('textbox'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(mocks.verifyMfa).toHaveBeenCalledWith({ challengeToken: 'challenge-abc', code: '000000' }));
    // Authenticated now — the MFA screen (rendered only while mfa_required) is gone.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Verification required' })).not.toBeInTheDocument());
  });

  it('shows the backend\'s real rejection as a plain error message on a wrong code, and stays on the challenge screen', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-abc' });
    mocks.verifyMfa.mockRejectedValue(
      new ApiError({ code: 'AUTH_MFA_CODE_INVALID', message: 'That verification code is incorrect or has expired.' })
    );

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'trigger-login' }));
    await screen.findByRole('heading', { name: 'Verification required' });

    await userEvent.type(screen.getByRole('textbox'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That verification code is incorrect or has expired.');
    expect(screen.getByRole('heading', { name: 'Verification required' })).toBeInTheDocument();
  });

  it('returns to sign-in on "Back to sign in" without requiring a network call (no refresh token exists yet at this stage)', async () => {
    render(
      <AuthProvider>
        <MfaChallengeScreen />
      </AuthProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('shows the "Powered by LodgeKeep" footer', () => {
    render(
      <AuthProvider>
        <MfaChallengeScreen />
      </AuthProvider>
    );
    expect(screen.getByText('Powered by LodgeKeep')).toBeInTheDocument();
  });
});
