import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomAllocationsTab } from '../RoomAllocationsTab.jsx';

const mocks = vi.hoisted(() => ({
  listRoomAllocations: vi.fn(),
  upsertRoomAllocation: vi.fn(),
  listRoomTypes: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    groupBlocksApi: { ...actual.groupBlocksApi, ...mocks },
    setupApi: { ...actual.setupApi, listRoomTypes: mocks.listRoomTypes },
  };
});

const BLOCK = { id: '1', block_name: 'Acme Conference' };
const ROOM_TYPE = { id: '10', name: 'Deluxe' };
const ALLOCATION = { id: '100', room_type_id: '10', room_type_name: 'Deluxe', stay_date: '2027-04-01', rooms_blocked: 5 };

// "Deluxe" appears both as a table cell and as a select <option> —
// always resolve the row via its cell.
async function findRoomTypeCell() {
  return (await screen.findAllByText('Deluxe')).find((el) => el.tagName === 'TD');
}

describe('<RoomAllocationsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomAllocations.mockResolvedValue([ALLOCATION]);
    mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE]);
  });

  it('shows an honest prompt with no block selected', () => {
    render(<RoomAllocationsTab block={null} />);
    expect(screen.getByText(/select a block/i)).toBeInTheDocument();
  });

  it('lists allocations for the selected block', async () => {
    render(<RoomAllocationsTab block={BLOCK} />);
    expect(await findRoomTypeCell()).toBeInTheDocument();
    expect(screen.getByText('2027-04-01')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('submits a single-night allocation', async () => {
    mocks.upsertRoomAllocation.mockResolvedValue([ALLOCATION]);
    render(<RoomAllocationsTab block={BLOCK} />);
    await findRoomTypeCell();

    await userEvent.selectOptions(screen.getByLabelText('Room type'), '10');
    await userEvent.type(screen.getByLabelText('Rooms blocked'), '5');
    const nightInput = screen.getByLabelText('Night');
    await userEvent.type(nightInput, '2027-04-01');
    await userEvent.click(screen.getByRole('button', { name: 'Set allocation' }));

    expect(mocks.upsertRoomAllocation).toHaveBeenCalledWith('1', expect.objectContaining({ roomTypeId: '10', stayDate: '2027-04-01', roomsBlocked: 5 }));
  });

  it('submits a range allocation when "a range of nights" is selected', async () => {
    mocks.upsertRoomAllocation.mockResolvedValue([ALLOCATION]);
    render(<RoomAllocationsTab block={BLOCK} />);
    await findRoomTypeCell();

    await userEvent.selectOptions(screen.getByLabelText('Room type'), '10');
    await userEvent.type(screen.getByLabelText('Rooms blocked'), '8');
    await userEvent.selectOptions(screen.getByLabelText('Applies to'), 'range');
    await userEvent.type(screen.getByLabelText('From'), '2027-04-01');
    await userEvent.type(screen.getByLabelText(/To \(exclusive/), '2027-04-04');
    await userEvent.click(screen.getByRole('button', { name: 'Set allocation' }));

    expect(mocks.upsertRoomAllocation).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ roomTypeId: '10', startDate: '2027-04-01', endDate: '2027-04-04', roomsBlocked: 8 })
    );
  });
});
