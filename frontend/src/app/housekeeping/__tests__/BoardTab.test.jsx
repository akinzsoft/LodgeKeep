import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardTab } from '../BoardTab.jsx';

const mocks = vi.hoisted(() => ({
  getBoard: vi.fn(),
  listAttendants: vi.fn(),
  createAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  listRooms: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    housekeepingApi: {
      getBoard: mocks.getBoard,
      listAttendants: mocks.listAttendants,
      createAssignment: mocks.createAssignment,
      updateAssignment: mocks.updateAssignment,
    },
    setupApi: { listRooms: mocks.listRooms },
  };
});

const CLEAN_ROOM = { id: '1', room_number: '101', housekeeping_reported_status: 'clean' };
const DIRTY_ROOM = { id: '2', room_number: '102', housekeeping_reported_status: 'dirty' };
const DIRTY_ASSIGNED_ROOM = { id: '3', room_number: '103', housekeeping_reported_status: 'dirty' };
const ATTENDANT = { id: '9', email: 'ada@example.com', first_name: 'Ada', last_name: 'Bello' };

/**
 * Gap closure (user-reported): "all dirty rooms shld show and all
 * houseppers shld show i dont need to type anytin" — the assignment form
 * used to be every room in the property plus a free-text staff-id field.
 */
describe('<BoardTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getBoard.mockResolvedValue([{ id: '50', room_id: '3', room_number: '103', attendant_user_id: '9', status: 'assigned', has_discrepancy: false }]);
    mocks.listRooms.mockResolvedValue([CLEAN_ROOM, DIRTY_ROOM, DIRTY_ASSIGNED_ROOM]);
    mocks.listAttendants.mockResolvedValue([ATTENDANT]);
  });

  it('offers only dirty, unassigned rooms in the assignment picker', async () => {
    render(<BoardTab />);
    await screen.findByText('103'); // board row loaded

    await userEvent.click(screen.getByLabelText('Dirty room'));
    expect(screen.getByRole('option', { name: '102' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '101' })).not.toBeInTheDocument(); // clean, excluded
    expect(screen.queryByRole('option', { name: '103' })).not.toBeInTheDocument(); // dirty but already assigned today
  });

  it('offers a real housekeeper picker, no free-text field', async () => {
    render(<BoardTab />);
    await screen.findByText('103');

    expect(screen.queryByPlaceholderText('e.g. 2')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Housekeeper'));
    expect(screen.getByRole('option', { name: 'Ada Bello' })).toBeInTheDocument();
  });

  it('assigns a dirty room to a housekeeper with no typing', async () => {
    mocks.createAssignment.mockResolvedValue({ id: '51', status: 'assigned' });
    render(<BoardTab />);
    await screen.findByText('103');

    await userEvent.selectOptions(screen.getByLabelText('Dirty room'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Housekeeper'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Assign' }));

    expect(mocks.createAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: '2', attendantUserId: '9' })
    );
  });

  it('resolves the attendant id on the board to a real name, not a bare id', async () => {
    render(<BoardTab />);
    // "Ada Bello" legitimately also appears as an option in the housekeeper
    // picker below — scope to the board's own table cell.
    const cell = await screen.findByText('Ada Bello', { selector: 'td' });
    expect(cell).toBeInTheDocument();
  });
});
