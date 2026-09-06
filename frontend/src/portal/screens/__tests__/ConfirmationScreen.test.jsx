import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmationScreen } from '../ConfirmationScreen.jsx';
import { renderPortalScreen, PROPERTY_SLUG } from './renderPortalScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  confirmBookingPayment: vi.fn(),
  getPropertyBranding: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, portalApi: { confirmBookingPayment: mocks.confirmBookingPayment, getPropertyBranding: mocks.getPropertyBranding } };
});

function renderScreen() {
  return renderPortalScreen({
    element: <ConfirmationScreen />,
    routePath: 'confirmation/:confirmationNumber',
    initialPath: `/portal/${PROPERTY_SLUG}/confirmation/01ABC`,
  });
}

describe('<ConfirmationScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPropertyBranding.mockResolvedValue({ name: 'Alpha Hotels', logoUrl: null, theme: null, baseCurrency: 'NGN' });
  });

  it('confirms on mount and shows a confirmed booking as success', async () => {
    mocks.confirmBookingPayment.mockResolvedValue({
      reservation: { confirmation_number: '01ABC', status: 'confirmed', arrival_date: '2027-01-01', departure_date: '2027-01-03' },
      payment: { status: 'CAPTURED', amount: '250.00' },
    });
    renderScreen();

    expect(mocks.confirmBookingPayment).toHaveBeenCalledWith({ propertySlug: PROPERTY_SLUG, confirmationNumber: '01ABC' });
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('CAPTURED')).toBeInTheDocument();
    expect(screen.getByText(/all set/)).toBeInTheDocument();
  });

  it('shows a failed-payment booking as released, not confirmed', async () => {
    mocks.confirmBookingPayment.mockResolvedValue({
      reservation: { confirmation_number: '01ABC', status: 'cancelled', arrival_date: '2027-01-01', departure_date: '2027-01-03' },
      payment: { status: 'FAILED', amount: '250.00' },
    });
    renderScreen();

    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText(/was not successful/)).toBeInTheDocument();
  });

  it('surfaces a real error with a working retry', async () => {
    mocks.confirmBookingPayment.mockRejectedValueOnce(new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server.' }));
    mocks.confirmBookingPayment.mockResolvedValueOnce({
      reservation: { confirmation_number: '01ABC', status: 'confirmed', arrival_date: '2027-01-01', departure_date: '2027-01-03' },
      payment: { status: 'CAPTURED', amount: '250.00' },
    });
    renderScreen();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    expect(mocks.confirmBookingPayment).toHaveBeenCalledTimes(2);
  });
});
