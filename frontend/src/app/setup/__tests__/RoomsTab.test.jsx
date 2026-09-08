import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomsTab } from '../RoomsTab.jsx';

const mocks = vi.hoisted(() => ({
  listRooms: vi.fn(),
  listRoomTypes: vi.fn(),
  bulkCreateRooms: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { listRooms: mocks.listRooms, listRoomTypes: mocks.listRoomTypes, bulkCreateRooms: mocks.bulkCreateRooms },
  };
});

const ROOM_TYPE_DLX = { id: '1', code: 'DLX', name: 'Deluxe' };
const ROOM_TYPE_STD = { id: '2', code: 'STD', name: 'Standard' };
const ROOM_DLX_1 = { id: '10', room_number: '101', floor: '1', room_type_id: '1', front_desk_status: 'vacant', housekeeping_reported_status: 'clean' };
const ROOM_DLX_2 = { id: '11', room_number: '102', floor: '1', room_type_id: '1', front_desk_status: 'occupied', housekeeping_reported_status: 'dirty' };
const ROOM_STD_1 = { id: '12', room_number: '201', floor: '2', room_type_id: '2', front_desk_status: 'vacant', housekeeping_reported_status: 'clean' };

describe('<RoomsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE_DLX, ROOM_TYPE_STD]);
  });

  it('shows a real occupancy and housekeeping status pill per room, not a generic active/archived column', async () => {
    mocks.listRooms.mockResolvedValue([ROOM_DLX_1, ROOM_DLX_2]);
    render(<RoomsTab disabled={false} />);
    await screen.findByText('101');

    expect(screen.getByRole('columnheader', { name: 'Occupancy' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Housekeeping' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Clean')).toBeInTheDocument();
    expect(screen.getByText('Occupied')).toBeInTheDocument();
    expect(screen.getByText('Dirty')).toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "click on any roomtype it shld bring all
   * rooms associated to that room type."
   */
  it('filters to only the given room type when filterRoomTypeId is supplied', async () => {
    mocks.listRooms.mockResolvedValue([ROOM_DLX_1, ROOM_DLX_2, ROOM_STD_1]);
    render(<RoomsTab disabled={false} filterRoomTypeId="1" onClearFilter={vi.fn()} />);

    await screen.findByText('101');
    expect(screen.getByText('102')).toBeInTheDocument();
    expect(screen.queryByText('201')).not.toBeInTheDocument();
    expect(screen.getByText(/Showing rooms for/).closest('p')).toHaveTextContent('Deluxe');
  });

  it('clears the filter when "Clear filter" is clicked', async () => {
    const onClearFilter = vi.fn();
    mocks.listRooms.mockResolvedValue([ROOM_DLX_1, ROOM_STD_1]);
    render(<RoomsTab disabled={false} filterRoomTypeId="1" onClearFilter={onClearFilter} />);
    await screen.findByText('101');

    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onClearFilter).toHaveBeenCalled();
  });

  it('shows every room, unfiltered, when no filterRoomTypeId is supplied (e.g. under SetupScreen)', async () => {
    mocks.listRooms.mockResolvedValue([ROOM_DLX_1, ROOM_STD_1]);
    render(<RoomsTab disabled={false} />);
    await screen.findByText('101');
    expect(screen.getByText('201')).toBeInTheDocument();
    expect(screen.queryByText(/Showing rooms for/)).not.toBeInTheDocument();
  });
});
