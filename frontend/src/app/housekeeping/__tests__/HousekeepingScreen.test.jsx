import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HousekeepingScreen } from '../HousekeepingScreen.jsx';

const mocks = vi.hoisted(() => ({
  getBoard: vi.fn(),
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
      listDiscrepancies: mocks.listDiscrepancies,
      listOutOfOrderPeriods: mocks.listOutOfOrderPeriods,
    },
    setupApi: { listRooms: mocks.listRooms },
  };
});

describe('<HousekeepingScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getBoard.mockResolvedValue([]);
    mocks.listRooms.mockResolvedValue([]);
    mocks.listDiscrepancies.mockResolvedValue([]);
    mocks.listOutOfOrderPeriods.mockResolvedValue([]);
  });

  it('renders all three tabs and defaults to Board', async () => {
    render(<HousekeepingScreen />);
    expect(await screen.findByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
    ['Discrepancies', 'Out of Order'].forEach((label) => {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    });
  });

  it('shows the board empty state with no assignments', async () => {
    render(<HousekeepingScreen />);
    expect(await screen.findByText(/no rooms assigned for this date yet/i)).toBeInTheDocument();
  });

  it('switches to the Discrepancies tab and loads it', async () => {
    mocks.listDiscrepancies.mockResolvedValue([
      { id: '1', room_id: '5', business_date: '2027-01-01', front_desk_status: 'vacant', housekeeping_status: 'occupied', resolved_at: null },
    ]);
    render(<HousekeepingScreen />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Discrepancies' }));
    expect(await screen.findByText('vacant')).toBeInTheDocument();
    expect(screen.getByText('occupied')).toBeInTheDocument();
  });

  it('switches to the Out of Order tab and loads it', async () => {
    render(<HousekeepingScreen />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Out of Order' }));
    expect(await screen.findByText(/no out-of-order periods scheduled/i)).toBeInTheDocument();
  });

  it('disables mutating actions while offline', async () => {
    render(<HousekeepingScreen isOffline />);
    expect(await screen.findByText(/assignments are disabled until the connection returns/i)).toBeInTheDocument();
  });
});
