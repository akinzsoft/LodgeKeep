import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResetPasswordScreen } from '../ResetPasswordScreen.jsx';
import { renderPortalScreen, PROPERTY_SLUG } from './renderPortalScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  completePasswordReset: vi.fn(),
  getPropertyBranding: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, portalApi: { completePasswordReset: mocks.completePasswordReset, getPropertyBranding: mocks.getPropertyBranding } };
});

function renderScreen({ token } = { token: 'a-real-token' }) {
  return renderPortalScreen({
    element: <ResetPasswordScreen />,
    routePath: 'reset-password',
    initialPath: token ? `/portal/${PROPERTY_SLUG}/reset-password?token=${token}` : `/portal/${PROPERTY_SLUG}/reset-password`,
    otherRoutes: [
      { path: 'login', element: <p>LOGIN_LANDED</p> },
      { path: 'forgot-password', element: <p>FORGOT_PASSWORD_LANDED</p> },
    ],
  });
}

/**
 * Gap closure (flagged in CLAUDE.md's own Phase 4 section, built via
 * feature-dev): guest password-reset.
 */
describe('<ResetPasswordScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPropertyBranding.mockResolvedValue({ name: PROPERTY_SLUG, logoUrl: null, theme: null, baseCurrency: 'NGN' });
  });

  it('renders an invalid-link state with no form when no token is present', async () => {
    renderScreen({ token: null });

    expect(await screen.findByText(/This password reset link is missing or malformed/)).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Request a new reset link' }));
    expect(await screen.findByText('FORGOT_PASSWORD_LANDED')).toBeInTheDocument();
  });

  it('submits the token and new password, and shows a working sign-in link on success', async () => {
    mocks.completePasswordReset.mockResolvedValue({ status: 'ok' });
    renderScreen({ token: 'a-real-token' });

    await userEvent.type(screen.getByLabelText('New password'), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(mocks.completePasswordReset).toHaveBeenCalledWith({ token: 'a-real-token', newPassword: 'a brand new strong passphrase' });
    expect(await screen.findByText(/Your password has been reset/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Sign in' }));
    expect(await screen.findByText('LOGIN_LANDED')).toBeInTheDocument();
  });

  it('shows a real backend error (expired/already-used/unknown token) and stays on the form', async () => {
    mocks.completePasswordReset.mockRejectedValue(new ApiError({ code: 'AUTH_TOKEN_INVALID', message: 'This link or session is no longer valid.' }));
    renderScreen({ token: 'a-stale-token' });

    await userEvent.type(screen.getByLabelText('New password'), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This link or session is no longer valid.');
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
  });
});
