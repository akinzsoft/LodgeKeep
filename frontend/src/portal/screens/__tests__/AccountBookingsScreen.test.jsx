import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountBookingsScreen } from '../AccountBookingsScreen.jsx';
import { renderPortalScreen, PROPERTY_SLUG } from './renderPortalScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listMyBookings: vi.fn(),
  getMyBooking: vi.fn(),
  getPropertyBranding: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, portalApi: { listMyBookings: mocks.listMyBookings, getMyBooking: mocks.getMyBooking, getPropertyBranding: mocks.getPropertyBranding } };
});

function renderScreen() {
  return renderPortalScreen({ element: <AccountBookingsScreen />, routePath: 'account/bookings' });
}

describe('<AccountBookingsScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPropertyBranding.mockResolvedValue({ name: PROPERTY_SLUG, logoUrl: null, theme: null, baseCurrency: 'NGN' });
  });

  it('shows an honest empty state with no bookings', async () => {
    mocks.listMyBookings.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText("You don't have any bookings yet.")).toBeInTheDocument();
  });

  it('lists real bookings and shows a selected one’s detail', async () => {
    mocks.listMyBookings.mockResolvedValue([{ id: '9', confirmation_number: '01XYZ', arrival_date: '2027-02-01', departure_date: '2027-02-03', status: 'confirmed' }]);
    mocks.getMyBooking.mockResolvedValue({
      id: '9',
      confirmation_number: '01XYZ',
      arrival_date: '2027-02-01',
      departure_date: '2027-02-03',
      status: 'confirmed',
      adults: 2,
      children: 0,
    });
    renderScreen();

    expect(await screen.findByText('01XYZ')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(await screen.findByText('Booking 01XYZ')).toBeInTheDocument();
    expect(mocks.getMyBooking).toHaveBeenCalledWith('9');
    expect(screen.getByText('2 adults')).toBeInTheDocument();
  });

  it('surfaces a real error rather than an empty list on load failure', async () => {
    mocks.listMyBookings.mockRejectedValue(new ApiError({ code: 'AUTH_UNAUTHENTICATED', message: 'Please sign in to see your bookings.' }));
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent('Please sign in to see your bookings.');
  });
});
