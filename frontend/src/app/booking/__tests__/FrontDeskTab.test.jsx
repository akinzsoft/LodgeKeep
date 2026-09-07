import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FrontDeskTab } from '../FrontDeskTab.jsx';

const mocks = vi.hoisted(() => ({
  listArrivals: vi.fn(),
  listDepartures: vi.fn(),
  listInHouse: vi.fn(),
  listFreeRooms: vi.fn(),
  checkIn: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    reservationsApi: {
      listArrivals: mocks.listArrivals,
      listDepartures: mocks.listDepartures,
      listInHouse: mocks.listInHouse,
      listFreeRooms: mocks.listFreeRooms,
      checkIn: mocks.checkIn,
    },
  };
});

const RESERVATION = {
  id: '1',
  confirmation_number: 'ABC123',
  arrival_date: '2027-01-01',
  status: 'confirmed',
  guest_first_name: 'Jordan',
  guest_last_name: 'Fixture',
  guest_phone: '+10000000000',
};
const FREE_ROOM = { id: '9', room_number: '101', floor: '1', housekeeping_reported_status: 'clean' };

describe('<FrontDeskTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listArrivals.mockResolvedValue([RESERVATION]);
    mocks.listDepartures.mockResolvedValue([]);
    mocks.listInHouse.mockResolvedValue([]);
    mocks.listFreeRooms.mockResolvedValue([FREE_ROOM]);
  });

  /**
   * Gap closure (user-reported): the board used to show only the
   * reservation row itself — confirmation/dates/adults — with no guest
   * name or phone at all, contradicting PRODUCT_REQUIREMENTS.md §3.3's own
   * "guest name, room, rate, folio balance, status pill" spec for these
   * boards. Backend now joins `guests`; this just renders it.
   */
  it("shows the guest's name and phone, not just the reservation row", async () => {
    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    expect(screen.getByText('Jordan Fixture')).toBeInTheDocument();
    expect(screen.getByText('+10000000000')).toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported follow-up): In-House/Departures now carry
   * a real room number once checked in — Arrivals never does, since no
   * room exists to show yet. Arrivals must not even show a "Room" column
   * (a column of dashes would misleadingly imply otherwise).
   */
  it('does not show a Room column on Arrivals', async () => {
    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    expect(screen.queryByRole('columnheader', { name: 'Room' })).not.toBeInTheDocument();
  });

  it('shows the actual room number on In-House', async () => {
    mocks.listInHouse.mockResolvedValue([{ ...RESERVATION, status: 'checked_in', room_number: '204' }]);
    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    await userEvent.click(screen.getByRole('tab', { name: 'In-House' }));
    expect(await screen.findByRole('columnheader', { name: 'Room' })).toBeInTheDocument();
    expect(await screen.findByText('204')).toBeInTheDocument();
  });

  it('shows the actual room number on Departures', async () => {
    mocks.listDepartures.mockResolvedValue([{ ...RESERVATION, status: 'checked_in', room_number: '204' }]);
    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    await userEvent.click(screen.getByRole('tab', { name: 'Departures' }));
    expect(await screen.findByRole('columnheader', { name: 'Room' })).toBeInTheDocument();
    expect(await screen.findByText('204')).toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported follow-up): Arrivals gets a "Preferred
   * room" column instead of "Room" — a request, never an actual
   * assignment, distinctly labelled so it's never mistaken for one.
   */
  it('shows the preferred room (not "Room") on Arrivals', async () => {
    mocks.listArrivals.mockResolvedValue([{ ...RESERVATION, preferred_room_number: '305' }]);
    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    expect(screen.getByRole('columnheader', { name: 'Preferred room' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Room' })).not.toBeInTheDocument();
    expect(screen.getByText('305')).toBeInTheDocument();
  });

  it('shows a dash on Arrivals when there is no preferred room', async () => {
    mocks.listArrivals.mockResolvedValue([{ ...RESERVATION, preferred_room_number: null }]);
    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('shows a plain dash when guest name/phone are missing rather than blank cells', async () => {
    mocks.listArrivals.mockResolvedValue([{ ...RESERVATION, guest_first_name: null, guest_last_name: null, guest_phone: null }]);
    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Gap closure: the check-in room picker used to list every room in the
   * property (`setupApi.listRooms()`), including already-occupied ones,
   * relying on the backend to reject a bad pick. It now sources from
   * `reservationsApi.listFreeRooms()` — no room-type filter, since
   * check-in/room-move deliberately allow any type (an upgrade).
   */
  it('sources the check-in room picker from listFreeRooms, not every room in the property', async () => {
    render(<FrontDeskTab />);
    await screen.findByText('ABC123');

    await userEvent.click(screen.getByRole('button', { name: 'Check In' }));
    expect(screen.getByRole('option', { name: /101/ })).toBeInTheDocument();
    expect(mocks.listFreeRooms).toHaveBeenCalledWith();
  });

  it('re-fetches free rooms when the check-in dialog opens, for freshness', async () => {
    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    const callsBeforeOpen = mocks.listFreeRooms.mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: 'Check In' }));
    expect(mocks.listFreeRooms.mock.calls.length).toBeGreaterThan(callsBeforeOpen);
  });

  it('checks in with the selected room', async () => {
    mocks.checkIn.mockResolvedValue({ ...RESERVATION, status: 'checked_in' });
    mocks.listArrivals.mockResolvedValueOnce([RESERVATION]).mockResolvedValueOnce([]);

    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    await userEvent.click(screen.getByRole('button', { name: 'Check In' }));
    await userEvent.selectOptions(screen.getByLabelText('Room'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm check-in' }));

    expect(mocks.checkIn).toHaveBeenCalledWith('1', { roomId: '9', overrideDirty: false });
  });

  /**
   * Gap closure (user-reported): the check-in dialog used to always start
   * on "Select a room," even for a reservation with a preferred room on
   * file. Pre-fills it now, when that room is still free — but the picker
   * stays fully changeable, per PRODUCT_REQUIREMENTS.md §3.3's "if the
   * customer requests a different room" allowance.
   */
  it("pre-fills the check-in room picker with the reservation's preferred room when it's still free", async () => {
    const reservationWithPreference = { ...RESERVATION, preferred_room_id: '9' };
    mocks.listArrivals.mockResolvedValue([reservationWithPreference]);

    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    await userEvent.click(screen.getByRole('button', { name: 'Check In' }));

    expect(await screen.findByLabelText('Room')).toHaveValue('9');
    expect(screen.getByText(/pre-filled with the guest.s preferred room/i)).toBeInTheDocument();
  });

  it('does not pre-fill a preferred room that is no longer free, leaving "Select a room"', async () => {
    const reservationWithPreference = { ...RESERVATION, preferred_room_id: '999' };
    mocks.listArrivals.mockResolvedValue([reservationWithPreference]);
    mocks.listFreeRooms.mockResolvedValue([FREE_ROOM]); // '999' is not in the free list

    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    await userEvent.click(screen.getByRole('button', { name: 'Check In' }));

    await screen.findByRole('option', { name: /101/ });
    expect(screen.getByLabelText('Room')).toHaveValue('');
    expect(screen.queryByText(/pre-filled with the guest.s preferred room/i)).not.toBeInTheDocument();
  });

  it('still allows changing the pre-filled preferred room to a different one', async () => {
    mocks.checkIn.mockResolvedValue({ ...RESERVATION, status: 'checked_in' });
    const otherRoom = { id: '10', room_number: '102', floor: '1', housekeeping_reported_status: 'clean' };
    const reservationWithPreference = { ...RESERVATION, preferred_room_id: '9' };
    mocks.listArrivals.mockResolvedValueOnce([reservationWithPreference]).mockResolvedValueOnce([]);
    mocks.listFreeRooms.mockResolvedValue([FREE_ROOM, otherRoom]);

    render(<FrontDeskTab />);
    await screen.findByText('ABC123');
    await userEvent.click(screen.getByRole('button', { name: 'Check In' }));
    expect(await screen.findByLabelText('Room')).toHaveValue('9');

    await userEvent.selectOptions(screen.getByLabelText('Room'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm check-in' }));

    expect(mocks.checkIn).toHaveBeenCalledWith('1', { roomId: '10', overrideDirty: false });
  });
});
