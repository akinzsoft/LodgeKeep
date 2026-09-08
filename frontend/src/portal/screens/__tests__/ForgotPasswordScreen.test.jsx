import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgotPasswordScreen } from '../ForgotPasswordScreen.jsx';
import { renderPortalScreen, PROPERTY_SLUG } from './renderPortalScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
  getPropertyBranding: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, portalApi: { requestPasswordReset: mocks.requestPasswordReset, getPropertyBranding: mocks.getPropertyBranding } };
});

function renderScreen() {
  return renderPortalScreen({
    element: <ForgotPasswordScreen />,
    routePath: 'forgot-password',
    otherRoutes: [{ path: 'login', element: <p>LOGIN_LANDED</p> }],
  });
}

/**
 * Gap closure (flagged in CLAUDE.md's own Phase 4 section, built via
 * feature-dev): guest password-reset.
 */
describe('<ForgotPasswordScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPropertyBranding.mockResolvedValue({ name: PROPERTY_SLUG, logoUrl: null, theme: null, baseCurrency: 'NGN' });
  });

  it('submits the request and shows the anti-enumeration-safe confirmation', async () => {
    mocks.requestPasswordReset.mockResolvedValue({ status: 'ok', dev_only_token: null });
    renderScreen();

    await userEvent.type(screen.getByLabelText('Email'), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(mocks.requestPasswordReset).toHaveBeenCalledWith({ propertySlug: PROPERTY_SLUG, email: 'guest@example.com' });
    expect(await screen.findByText(/If an account exists for that address/)).toBeInTheDocument();
    expect(screen.queryByText(/Dev-only/)).not.toBeInTheDocument();
  });

  it('shows the dev-only token beneath the same confirmation when one is present', async () => {
    mocks.requestPasswordReset.mockResolvedValue({ status: 'ok', dev_only_token: 'real-dev-token' });
    renderScreen();

    await userEvent.type(screen.getByLabelText('Email'), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText(/If an account exists for that address/)).toBeInTheDocument();
    expect(screen.getByText('real-dev-token')).toBeInTheDocument();
  });

  it('shows a real backend error and stays on the form on failure', async () => {
    mocks.requestPasswordReset.mockRejectedValue(new ApiError({ code: 'VALIDATION_PROPERTY_NOT_FOUND', message: 'The specified property does not exist.' }));
    renderScreen();

    await userEvent.type(screen.getByLabelText('Email'), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The specified property does not exist.');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('links back to sign-in from both the form and the confirmation state', async () => {
    mocks.requestPasswordReset.mockResolvedValue({ status: 'ok', dev_only_token: null });
    renderScreen();

    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Email'), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    const link = await screen.findByRole('link', { name: 'Back to sign in' });
    await userEvent.click(link);
    expect(await screen.findByText('LOGIN_LANDED')).toBeInTheDocument();
  });
});
