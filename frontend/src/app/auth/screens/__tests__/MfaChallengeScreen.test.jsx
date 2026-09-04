import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../../AuthContext.jsx';
import { MfaChallengeScreen } from '../MfaChallengeScreen.jsx';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
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
      logout: mocks.logout,
      switchProperty: mocks.switchProperty,
      refresh: mocks.refresh,
      requestPasswordReset: mocks.requestPasswordReset,
      completePasswordReset: mocks.completePasswordReset,
    },
    configureApiClient: mocks.configureApiClient,
  };
});

describe('<MfaChallengeScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('tells the truth about verification not being available, rather than drawing a code input that could never work', () => {
    render(
      <AuthProvider>
        <MfaChallengeScreen />
      </AuthProvider>
    );
    expect(screen.getByRole('heading', { name: 'Verification required' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
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
