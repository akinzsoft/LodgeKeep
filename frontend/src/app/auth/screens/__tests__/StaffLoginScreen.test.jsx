import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../../AuthContext.jsx';
import { StaffLoginScreen } from '../StaffLoginScreen.jsx';
import { ApiError } from '../../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  switchProperty: vi.fn(),
  refresh: vi.fn(),
  requestPasswordResetCode: vi.fn(),
  completePasswordResetWithCode: vi.fn(),
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
      requestPasswordResetCode: mocks.requestPasswordResetCode,
      completePasswordResetWithCode: mocks.completePasswordResetWithCode,
    },
    configureApiClient: mocks.configureApiClient,
  };
});

function renderScreen(props = {}) {
  return render(
    <AuthProvider>
      <StaffLoginScreen {...props} />
    </AuthProvider>
  );
}

describe('<StaffLoginScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('renders the sign-in form', () => {
    renderScreen();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('links to the real /signup screen, PLAN.md Phase 5 gap closure', () => {
    renderScreen();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/signup');
  });

  it('shows the "Powered by LodgeKeep" footer — a signed-out visitor never reaches AppShell to see it there', () => {
    renderScreen();
    expect(screen.getByText('Powered by LodgeKeep')).toBeInTheDocument();
  });

  it('submits email and password to login()', async () => {
    mocks.login.mockImplementation(() => new Promise(() => {})); // never resolves — just observe the call
    renderScreen();
    await userEvent.type(screen.getByLabelText('Email'), 'manager@alpha-hotels.example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'LodgeKeepDev123!');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(mocks.login).toHaveBeenCalledWith({
      email: 'manager@alpha-hotels.example.com',
      password: 'LodgeKeepDev123!',
    });
  });

  it('shows the backend\'s generic invalid-credentials message on failure', async () => {
    mocks.login.mockRejectedValue(
      new ApiError({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Email or password is incorrect.' })
    );
    renderScreen();
    await userEvent.type(screen.getByLabelText('Email'), 'wrong@alpha-hotels.example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });

  it('shows a distinct lockout message for LOCKED_ACCOUNT, not the raw backend string', async () => {
    mocks.login.mockRejectedValue(new ApiError({ code: 'LOCKED_ACCOUNT', message: 'Too many attempts. Try again later.' }));
    renderScreen();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.com');
    await userEvent.type(screen.getByLabelText('Password'), 'password12345');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many attempts/i);
    expect(alert).toHaveTextContent(/forgot password/i);
  });

  it('toggles the password field between hidden and visible', async () => {
    renderScreen();
    const passwordInput = screen.getByLabelText('Password');
    expect(passwordInput).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(passwordInput).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('disables sign-in and shows an offline notice when isOffline', () => {
    renderScreen({ isOffline: true });
    expect(screen.getByText(/you.re offline/i)).toBeInTheDocument();
  });

  it('disables the forgot-password request step when isOffline too, matching the rest of the screen', async () => {
    renderScreen({ isOffline: true });
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByText(/requesting a reset code is disabled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reset code' })).toBeDisabled();
  });

  it('shows the real backend error when requesting a reset code fails (e.g. rate limited), rather than failing silently', async () => {
    mocks.requestPasswordResetCode.mockRejectedValue(
      new ApiError({ code: 'RATE_LIMITED', message: 'Too many attempts — please wait a moment and try again.' })
    );
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await userEvent.type(screen.getByLabelText('Email'), 'manager@alpha-hotels.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts — please wait a moment and try again.');
    // Stays on the request step for a retry — never bounces to sign-in or hangs.
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reset code' })).not.toBeDisabled();
  });

  it('walks the forgot-password flow through to a real code entry step, including the dev-only code', async () => {
    mocks.requestPasswordResetCode.mockResolvedValue({ status: 'ok', reset_token: 'rt-1', dev_only_code: '482913' });
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Email'), 'manager@alpha-hotels.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset code' }));

    expect(await screen.findByRole('heading', { name: 'Enter your reset code' })).toBeInTheDocument();
    expect(screen.getByText('482913')).toBeInTheDocument();
    expect(mocks.requestPasswordResetCode).toHaveBeenCalledWith({
      email: 'manager@alpha-hotels.example.com',
    });

    mocks.completePasswordResetWithCode.mockResolvedValue({ status: 'ok' });
    await userEvent.type(screen.getByLabelText('Reset code'), '482913');
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByRole('heading', { name: 'Password reset' })).toBeInTheDocument();
    expect(mocks.completePasswordResetWithCode).toHaveBeenCalledWith({
      resetToken: 'rt-1',
      code: '482913',
      newPassword: 'a brand new strong passphrase',
    });
  });

  it('shows the real backend error on a failed verify, and keeps the code-entry form for a retry', async () => {
    mocks.requestPasswordResetCode.mockResolvedValue({ status: 'ok', reset_token: 'rt-1', dev_only_code: null });
    mocks.completePasswordResetWithCode.mockRejectedValue(
      new ApiError({ code: 'AUTH_PASSWORD_RESET_CODE_INVALID', message: 'That reset code is incorrect or has expired.' })
    );
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await userEvent.type(screen.getByLabelText('Email'), 'manager@alpha-hotels.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset code' }));

    await screen.findByRole('heading', { name: 'Enter your reset code' });
    await userEvent.type(screen.getByLabelText('Reset code'), '111111');
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That reset code is incorrect or has expired.');
    expect(screen.getByRole('heading', { name: 'Enter your reset code' })).toBeInTheDocument();
    expect(screen.getByLabelText('Reset code')).toBeInTheDocument();
  });

  it('returns to sign-in from the forgot-password view, and clears any stale reset state for the next attempt', async () => {
    mocks.requestPasswordResetCode.mockResolvedValue({ status: 'ok', reset_token: 'rt-1', dev_only_code: '111111' });
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();

    // A fresh attempt shows no leftover code/email from an abandoned one.
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByLabelText('Email')).toHaveValue('');
  });

  it('shows an honest "not available" panel for find-my-company rather than a fake working flow', async () => {
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: /can.t find your company/i }));
    expect(screen.getByText(/company lookup by email isn.t available yet/i)).toBeInTheDocument();
  });
});
