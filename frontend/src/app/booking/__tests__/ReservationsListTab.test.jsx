import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReservationsListTab } from '../ReservationsListTab.jsx';
import { shortReference } from '../ConfirmationRef.jsx';

const mocks = vi.hoisted(() => ({
  searchReservations: vi.fn(),
  cancelReservation: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    reservationsApi: { searchReservations: mocks.searchReservations, cancelReservation: mocks.cancelReservation },
  };
});

const RESERVATION = {
  id: '1',
  confirmation_number: '01M2P2CBX4KF0QK5DH6KCN3H03',
  guest_first_name: 'Ada',
  guest_last_name: 'Obi',
  guest_phone: '08031112222',
  room_type_name: 'Deluxe',
  arrival_date: '2027-01-01',
  departure_date: '2027-01-03',
  adults: 2,
  children: 0,
  status: 'confirmed',
  folio_balance: '15000.00',
  folio_currency: 'NGN',
};

const page = (rows, total = rows.length) => ({ rows, total });

describe('<ReservationsListTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.searchReservations.mockResolvedValue(page([RESERVATION]));
  });

  it('asks for the first page, newest first, with no filter', async () => {
    render(<ReservationsListTab />);
    await screen.findByText('Ada Obi');
    expect(mocks.searchReservations).toHaveBeenCalledWith({ status: '', search: '', limit: 25, offset: 0 });
  });

  it('says whose booking each row is, for what, when, and what is owed', async () => {
    render(<ReservationsListTab />);
    const row = (await screen.findByText('Ada Obi')).closest('tr');
    // The short reference shows; the full number stays in the tooltip.
    const ref = within(row).getByText('K5DH6KCN3H03'.slice(-8));
    expect(ref).toHaveAttribute('title', RESERVATION.confirmation_number);
    expect(within(row).getByText('08031112222')).toBeInTheDocument();
    expect(within(row).getByText('Deluxe')).toBeInTheDocument();
    expect(within(row).getByText('Fri 1 Jan → Sun 3 Jan 2027')).toBeInTheDocument();
    expect(within(row).getByText('2 nights · 2 adults')).toBeInTheDocument();
    expect(within(row).getByText('Confirmed')).toBeInTheDocument();
    expect(within(row).getByText(/15,000\.00/)).toBeInTheDocument();
  });

  it('says "No open folio" rather than a zero when there is none', async () => {
    mocks.searchReservations.mockResolvedValue(page([{ ...RESERVATION, folio_balance: null, folio_currency: null }]));
    render(<ReservationsListTab />);
    expect(await screen.findByText('No open folio')).toBeInTheDocument();
  });

  it('searches by what is typed, once typing pauses', async () => {
    render(<ReservationsListTab />);
    await screen.findByText('Ada Obi');
    await userEvent.type(screen.getByLabelText('Search'), 'obi');
    await waitFor(() => expect(mocks.searchReservations).toHaveBeenLastCalledWith({ status: '', search: 'obi', limit: 25, offset: 0 }));
    // Not one request per keystroke.
    expect(mocks.searchReservations.mock.calls.filter(([args]) => args.search === 'o' || args.search === 'ob')).toHaveLength(0);
  });

  it('filters by status and says so when nothing matches', async () => {
    render(<ReservationsListTab />);
    await screen.findByText('Ada Obi');
    mocks.searchReservations.mockResolvedValue(page([]));
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'no_show');
    expect(await screen.findByText('No reservations match this search.')).toBeInTheDocument();
    expect(mocks.searchReservations).toHaveBeenLastCalledWith({ status: 'no_show', search: '', limit: 25, offset: 0 });
  });

  it('pages through results with Previous and Next', async () => {
    mocks.searchReservations.mockResolvedValue(page([RESERVATION], 60));
    render(<ReservationsListTab />);
    expect(await screen.findByText('Showing 1–25 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(mocks.searchReservations).toHaveBeenLastCalledWith({ status: '', search: '', limit: 25, offset: 25 }));
    expect(await screen.findByText('Showing 26–50 of 60')).toBeInTheDocument();
  });

  it('shows the empty state with no reservations at all', async () => {
    mocks.searchReservations.mockResolvedValue(page([]));
    render(<ReservationsListTab />);
    expect(await screen.findByText('No reservations yet.')).toBeInTheDocument();
  });

  it('cancelling names the guest, requires a reason, then reloads the list', async () => {
    mocks.cancelReservation.mockResolvedValue({ ...RESERVATION, status: 'cancelled' });
    render(<ReservationsListTab />);
    await screen.findByText('Ada Obi');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(new RegExp(`${shortReference(RESERVATION.confirmation_number)} for Ada Obi`))).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: 'Confirm cancellation' });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Guest changed plans');
    await userEvent.click(confirmButton);

    expect(mocks.cancelReservation).toHaveBeenCalledWith('1', 'Guest changed plans');
    await waitFor(() => expect(mocks.searchReservations).toHaveBeenCalledTimes(2));
  });
});
