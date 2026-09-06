import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginScreen } from '../LoginScreen.jsx';
import { renderPortalScreen, PROPERTY_SLUG } from './renderPortalScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  getPropertyBranding: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, portalApi: { login: mocks.login, getPropertyBranding: mocks.getPropertyBranding } };
});

function renderScreen() {
  return renderPortalScreen({
    element: <LoginScreen />,
    routePath: 'login',
    otherRoutes: [{ path: 'account/bookings', element: <p>ACCOUNT_BOOKINGS_LANDED</p> }],
  });
}

describe('<LoginScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPropertyBranding.mockResolvedValue({ name: PROPERTY_SLUG, logoUrl: null, theme: null, baseCurrency: 'NGN' });
  });

  it('signs in and navigates to the account bookings screen', async () => {
    mocks.login.mockResolvedValue({ status: 'ok', accessToken: 'a-token' });
    renderScreen();

    await userEvent.type(screen.getByLabelText('Email'), 'guest@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Sup3rSecret!');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(mocks.login).toHaveBeenCalledWith(expect.objectContaining({ propertySlug: PROPERTY_SLUG, email: 'guest@example.com', password: 'Sup3rSecret!' }));
    expect(await screen.findByText('ACCOUNT_BOOKINGS_LANDED')).toBeInTheDocument();
  });

  it('shows a real error and stays on the form when the password is wrong', async () => {
    mocks.login.mockRejectedValue(new ApiError({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Incorrect email or password.' }));
    renderScreen();

    await userEvent.type(screen.getByLabelText('Email'), 'guest@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});
