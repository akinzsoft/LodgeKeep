import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WaitlistTab } from '../WaitlistTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listWaitlist: vi.fn(),
  promoteWaitlist: vi.fn(),
  cancelReservation: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    reservationsApi: { listWaitlist: mocks.listWaitlist, promoteWaitlist: mocks.promoteWaitlist, cancelReservation: mocks.cancelReservation },
  };
});

describe('<WaitlistTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  function entry(overrides) {
    return {
      id: '26',
      confirmation_number: 'ABC123',
      arrival_date: '2026-09-20',
      departure_date: '2026-09-21',
      adults: 1,
      guest_first_name: 'Ada',
      guest_last_name: 'Obi',
      guest_phone: '08030000000',
      room_type_code: 'DLX',
      room_type_name: 'Deluxe',
      created_at: '2026-09-10T09:30:00.000Z',
      arrival_passed: false,
      ...overrides,
    };
  }

  it('shows the genuine empty state when there really is no one waitlisted', async () => {
    mocks.listWaitlist.mockResolvedValue([]);
    render(<WaitlistTab />);

    expect(await screen.findByText('No one is currently waitlisted.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('bug fix: a real fetch failure is visible, not masked as "No one is currently waitlisted"', async () => {
    mocks.listWaitlist.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'The waitlist could not be loaded right now.' }));
    render(<WaitlistTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The waitlist could not be loaded right now.');
    expect(screen.queryByText('No one is currently waitlisted.')).not.toBeInTheDocument();
  });

  it('shows who is waiting, their phone, room type and how long they have waited', async () => {
    mocks.listWaitlist.mockResolvedValue([entry()]);
    render(<WaitlistTab />);

    expect(await screen.findByText('Ada Obi')).toBeInTheDocument();
    expect(screen.getByText('08030000000')).toBeInTheDocument();
    expect(screen.getByText('Deluxe')).toBeInTheDocument();
    expect(screen.getByText(/Sep 10, 2026/)).toBeInTheDocument();
    expect(screen.queryByText('Arrival passed')).not.toBeInTheDocument();
  });

  it('flags an entry whose arrival has passed and does not offer Promote for it', async () => {
    mocks.listWaitlist.mockResolvedValue([entry({ arrival_passed: true })]);
    render(<WaitlistTab />);

    expect(await screen.findByText('Arrival passed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Promote' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('cancels a waitlisted guest with a required reason and reloads the queue', async () => {
    mocks.listWaitlist.mockResolvedValueOnce([entry()]).mockResolvedValueOnce([]);
    mocks.cancelReservation.mockResolvedValue({ id: '26', status: 'cancelled' });
    render(<WaitlistTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('button', { name: 'Confirm cancellation' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), 'Guest found another hotel.');
    await userEvent.click(confirm);

    expect(mocks.cancelReservation).toHaveBeenCalledWith('26', 'Guest found another hotel.');
    expect(await screen.findByText('No one is currently waitlisted.')).toBeInTheDocument();
  });

  it('disables Promote and Cancel while offline', async () => {
    mocks.listWaitlist.mockResolvedValue([entry()]);
    render(<WaitlistTab isOffline />);

    expect(await screen.findByText(/You’re offline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Promote' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('lists a real waitlisted reservation and promotes it', async () => {
    mocks.listWaitlist.mockResolvedValue([entry()]);
    mocks.promoteWaitlist.mockResolvedValue({ id: '26', status: 'confirmed' });
    render(<WaitlistTab />);

    expect(await screen.findByText('ABC123')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Promote' }));

    expect(mocks.promoteWaitlist).toHaveBeenCalledWith('26');
  });

  it('bug fix: a real promote failure is visible even once the list is refetched as empty', async () => {
    mocks.listWaitlist.mockResolvedValueOnce([entry()]);
    mocks.promoteWaitlist.mockRejectedValue(
      new ApiError({ code: 'BUSINESS_RULE_OVERBOOKING_THRESHOLD_EXCEEDED', message: 'No sellable inventory left for this room type.' })
    );
    render(<WaitlistTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Promote' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No sellable inventory left');
  });
});
