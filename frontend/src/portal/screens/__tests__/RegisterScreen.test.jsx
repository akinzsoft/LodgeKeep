import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegisterScreen } from '../RegisterScreen.jsx';
import { renderPortalScreen, PROPERTY_SLUG } from './renderPortalScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  getPropertyBranding: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, portalApi: { register: mocks.register, getPropertyBranding: mocks.getPropertyBranding } };
});

function renderScreen() {
  return renderPortalScreen({
    element: <RegisterScreen />,
    routePath: 'register',
    otherRoutes: [{ path: 'account/bookings', element: <p>ACCOUNT_BOOKINGS_LANDED</p> }],
  });
}

describe('<RegisterScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPropertyBranding.mockResolvedValue({ name: PROPERTY_SLUG, logoUrl: null, theme: null, baseCurrency: 'NGN' });
  });

  it('creates an account and lands signed in on the account bookings screen', async () => {
    mocks.register.mockResolvedValue({ status: 'ok', accessToken: 'a-token' });
    renderScreen();

    await userEvent.type(screen.getByLabelText('First name'), 'Jordan');
    await userEvent.type(screen.getByLabelText('Last name'), 'Ade');
    await userEvent.type(screen.getByLabelText('Email'), 'jordan@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Sup3rSecret!');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({ propertySlug: PROPERTY_SLUG, email: 'jordan@example.com', firstName: 'Jordan', lastName: 'Ade', password: 'Sup3rSecret!' })
    );
    expect(await screen.findByText('ACCOUNT_BOOKINGS_LANDED')).toBeInTheDocument();
  });

  it('shows a real error when the email is already registered', async () => {
    mocks.register.mockRejectedValue(new ApiError({ code: 'CONFLICT_DUPLICATE_EMAIL', message: 'An account with this email already exists.' }));
    renderScreen();

    await userEvent.type(screen.getByLabelText('First name'), 'Jordan');
    await userEvent.type(screen.getByLabelText('Last name'), 'Ade');
    await userEvent.type(screen.getByLabelText('Email'), 'jordan@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Sup3rSecret!');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('An account with this email already exists.');
  });
});
