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

const RESERVATION = { id: '1', confirmation_number: 'ABC123', arrival_date: '2027-01-01', status: 'confirmed' };
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
});
