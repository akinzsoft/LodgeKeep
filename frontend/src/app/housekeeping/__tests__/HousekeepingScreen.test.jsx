import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HousekeepingScreen } from '../HousekeepingScreen.jsx';

const mocks = vi.hoisted(() => ({
  getBoard: vi.fn(),
  listAttendants: vi.fn(),
  listRooms: vi.fn(),
  listDiscrepancies: vi.fn(),
  listOutOfOrderPeriods: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    housekeepingApi: {
      getBoard: mocks.getBoard,
      listAttendants: mocks.listAttendants,
      listRooms: mocks.listRooms,
      listDiscrepancies: mocks.listDiscrepancies,
      listOutOfOrderPeriods: mocks.listOutOfOrderPeriods,
    },
  };
});

describe('<HousekeepingScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getBoard.mockResolvedValue([]);
    mocks.listAttendants.mockResolvedValue([]);
    mocks.listRooms.mockResolvedValue([]);
    mocks.listDiscrepancies.mockResolvedValue([]);
    mocks.listOutOfOrderPeriods.mockResolvedValue([]);
  });

  it('renders all three tabs and defaults to Board', async () => {
    render(<HousekeepingScreen canManage />);
    expect(await screen.findByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
    ['Discrepancies', 'Out of Order'].forEach((label) => {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    });
  });

  it('shows the board empty state with no assignments', async () => {
    render(<HousekeepingScreen canManage />);
    expect(await screen.findByText(/no rooms assigned for this date yet/i)).toBeInTheDocument();
  });

  it('switches to the Discrepancies tab and loads it', async () => {
    mocks.listDiscrepancies.mockResolvedValue([
      { id: '1', room_id: '5', business_date: '2027-01-01', front_desk_status: 'vacant', housekeeping_status: 'occupied', resolved_at: null },
    ]);
    render(<HousekeepingScreen canManage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Discrepancies' }));
    expect(await screen.findByText('vacant')).toBeInTheDocument();
    expect(screen.getByText('occupied')).toBeInTheDocument();
  });

  it('switches to the Out of Order tab and loads it', async () => {
    render(<HousekeepingScreen canManage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Out of Order' }));
    expect(await screen.findByText(/no out-of-order periods scheduled/i)).toBeInTheDocument();
  });

  it('disables mutating actions while offline', async () => {
    render(<HousekeepingScreen isOffline canManage />);
    expect(await screen.findByText(/assignments are disabled until the connection returns/i)).toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): `canManage`/`currentUserId` (from
   * `main.jsx`'s already-resolved `grantedPermissions`) thread down to the
   * Board tab so a plain housekeeper sees their own rooms, not the whole
   * property's board or the supervisor-only Assign panel.
   */
  it('threads canManage/currentUserId down to the Board tab for a plain housekeeper', async () => {
    mocks.getBoard.mockResolvedValue([
      { id: '50', room_id: '3', room_number: '103', attendant_user_id: '9', status: 'assigned', has_discrepancy: false },
    ]);
    render(<HousekeepingScreen currentUserId="9" canManage={false} />);
    expect(await screen.findByText('My rooms today')).toBeInTheDocument();
    expect(screen.queryByText('Assign a dirty room')).not.toBeInTheDocument();
  });
});
