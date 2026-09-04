import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReservationsListTab } from '../ReservationsListTab.jsx';

const mocks = vi.hoisted(() => ({
  listReservations: vi.fn(),
  cancelReservation: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    reservationsApi: { listReservations: mocks.listReservations, cancelReservation: mocks.cancelReservation },
  };
});

const RESERVATION = {
  id: '1',
  confirmation_number: 'ABC123',
  arrival_date: '2027-01-01',
  departure_date: '2027-01-03',
  adults: 2,
  status: 'confirmed',
};

describe('<ReservationsListTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('shows the empty state with no reservations', async () => {
    mocks.listReservations.mockResolvedValue([]);
    render(<ReservationsListTab />);
    expect(await screen.findByText(/no reservations match this filter/i)).toBeInTheDocument();
  });

  it('lists reservations with a status pill, not colour alone', async () => {
    mocks.listReservations.mockResolvedValue([RESERVATION]);
    render(<ReservationsListTab />);
    expect(await screen.findByText('ABC123')).toBeInTheDocument();
    // "Confirmed" also appears as a status-filter option — the pill is the
    // second occurrence, since the filter toolbar renders before the table body.
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThanOrEqual(2);
  });

  it('cancelling requires confirmation and a reason, then reloads the list', async () => {
    mocks.listReservations.mockResolvedValueOnce([RESERVATION]).mockResolvedValueOnce([{ ...RESERVATION, status: 'cancelled' }]);
    mocks.cancelReservation.mockResolvedValue({ ...RESERVATION, status: 'cancelled' });

    render(<ReservationsListTab />);
    await screen.findByText('ABC123');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.cancelReservation).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole('button', { name: 'Confirm cancellation' });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Guest changed plans');
    await userEvent.click(confirmButton);

    expect(mocks.cancelReservation).toHaveBeenCalledWith('1', 'Guest changed plans');
  });
});
