import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomsScreen } from '../RoomsScreen.jsx';

const mocks = vi.hoisted(() => ({
  listRoomTypes: vi.fn(),
  listRooms: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: {
      listRoomTypes: mocks.listRoomTypes,
      listRooms: mocks.listRooms,
    },
  };
});

const ACTIVE_PROPERTY = { id: '1', name: 'Fixture Hotel', base_currency: 'NGN' };

/**
 * Gap closure (user-reported): "Rooms" was a real nav item never wired to
 * any screen at all — clicking it silently fell through to Home. This
 * confirms it now mounts a real screen with Room Types/Rooms, reusing the
 * exact tabs Setup already uses, not a second copy.
 */
describe('<RoomsScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([]);
    mocks.listRooms.mockResolvedValue([]);
  });

  it('defaults to the Room Types tab and can switch to Rooms', async () => {
    render(<RoomsScreen activeProperty={ACTIVE_PROPERTY} />);
    expect(await screen.findByRole('tab', { name: 'Room Types' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/no room types yet/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Rooms' }));
    expect(await screen.findByText(/no rooms yet/i)).toBeInTheDocument();
  });

  it('shows the real onboarding message when no property exists yet, rather than a broken form', async () => {
    render(<RoomsScreen activeProperty={null} />);
    expect(await screen.findByText(/create a property first/i)).toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "on Rooms page on list of rooms add if i
   * click on any roomtype it shld bring all rooms associated to that room
   * type with status" — clicking "View rooms" switches to the Rooms tab,
   * pre-filtered.
   */
  it('clicking "View rooms" on a room type switches to Rooms, filtered to that type', async () => {
    mocks.listRoomTypes.mockResolvedValue([{ id: '1', code: 'DLX', name: 'Deluxe', default_occupancy: 2, base_rate: '150.00' }]);
    mocks.listRooms.mockResolvedValue([
      { id: '10', room_number: '101', floor: '1', room_type_id: '1', front_desk_status: 'vacant', housekeeping_reported_status: 'clean' },
      { id: '11', room_number: '201', floor: '2', room_type_id: '2', front_desk_status: 'vacant', housekeeping_reported_status: 'clean' },
    ]);
    render(<RoomsScreen activeProperty={ACTIVE_PROPERTY} />);
    await screen.findByText('DLX');

    await userEvent.click(screen.getByRole('button', { name: 'View rooms' }));

    expect(await screen.findByRole('tab', { name: 'Rooms' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('101')).toBeInTheDocument();
    expect(screen.queryByText('201')).not.toBeInTheDocument();
    expect(screen.getByText(/Showing rooms for/)).toBeInTheDocument();
  });
});
