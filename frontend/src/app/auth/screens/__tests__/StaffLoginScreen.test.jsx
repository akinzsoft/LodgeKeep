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

  it('walks the forgot-password flow through to the sent confirmation, including the dev-only token', async () => {
    mocks.requestPasswordReset.mockResolvedValue({ status: 'ok', dev_only_token: 'reset-token-abc' });
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Email'), 'manager@alpha-hotels.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('reset-token-abc')).toBeInTheDocument();
    expect(mocks.requestPasswordReset).toHaveBeenCalledWith({
      email: 'manager@alpha-hotels.example.com',
    });
  });

  it('returns to sign-in from the forgot-password view', async () => {
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows an honest "not available" panel for find-my-company rather than a fake working flow', async () => {
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: /can.t find your company/i }));
    expect(screen.getByText(/company lookup by email isn.t available yet/i)).toBeInTheDocument();
  });
});
