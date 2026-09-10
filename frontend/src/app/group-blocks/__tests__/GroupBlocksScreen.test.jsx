import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupBlocksScreen } from '../GroupBlocksScreen.jsx';

const mocks = vi.hoisted(() => ({
  listGroupBlocks: vi.fn(),
  listCompanyProfiles: vi.fn(),
  listRoomAllocations: vi.fn(),
  listRoomTypes: vi.fn(),
  listReservations: vi.fn(),
  getPickupSummary: vi.fn(),
  listAccounts: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    groupBlocksApi: { ...actual.groupBlocksApi, ...mocks },
    profilesApi: { ...actual.profilesApi, listCompanyProfiles: mocks.listCompanyProfiles },
    setupApi: { ...actual.setupApi, listRoomTypes: mocks.listRoomTypes },
    reservationsApi: { ...actual.reservationsApi, listReservations: mocks.listReservations },
    arApi: { ...actual.arApi, listAccounts: mocks.listAccounts },
  };
});

const BLOCK = { id: '1', block_name: 'Acme Conference', company_profile_id: null, start_date: '2027-03-10', end_date: '2027-03-13', cutoff_date: null, status: 'active' };

describe('<GroupBlocksScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listGroupBlocks.mockResolvedValue([BLOCK]);
    mocks.listCompanyProfiles.mockResolvedValue([]);
    mocks.listRoomAllocations.mockResolvedValue([]);
    mocks.listRoomTypes.mockResolvedValue([]);
    mocks.listReservations.mockResolvedValue([]);
    mocks.getPickupSummary.mockResolvedValue({ groupBlockId: '1', blockName: 'Acme Conference', rows: [], totalRoomsBlocked: 0, totalRoomsPickedUp: 0 });
    mocks.listAccounts.mockResolvedValue([]);
  });

  it('defaults to the Blocks tab', async () => {
    render(<GroupBlocksScreen />);
    expect(await screen.findByRole('tab', { name: 'Blocks' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Acme Conference')).toBeInTheDocument();
  });

  it('the other three tabs show an honest "select a block" prompt with no block selected', async () => {
    render(<GroupBlocksScreen />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Room Allocations' }));
    expect(await screen.findByText(/select a block/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Rooming List' }));
    expect(await screen.findByText(/select a block/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Pickup & Billing' }));
    expect(await screen.findByText(/select a block/i)).toBeInTheDocument();
  });

  it('clicking "Manage" on a block switches to Room Allocations with that block selected', async () => {
    render(<GroupBlocksScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(screen.getByRole('tab', { name: 'Room Allocations' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/Acme Conference/)).toBeInTheDocument();
    expect(mocks.listRoomAllocations).toHaveBeenCalledWith('1');
  });
});
