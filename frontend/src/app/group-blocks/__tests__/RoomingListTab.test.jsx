import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoomingListTab } from '../RoomingListTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listReservations: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    reservationsApi: { ...actual.reservationsApi, listReservations: mocks.listReservations },
  };
});

const BLOCK = { id: '1', block_name: 'Acme Conference' };
const RESERVATION = { id: '900', confirmation_number: 'CONF900', arrival_date: '2027-03-10', departure_date: '2027-03-13', adults: 2, status: 'confirmed' };

describe('<RoomingListTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listReservations.mockResolvedValue([RESERVATION]);
  });

  it('shows an honest prompt with no block selected', () => {
    render(<RoomingListTab block={null} />);
    expect(screen.getByText(/select a block/i)).toBeInTheDocument();
  });

  it('lists reservations filtered by the block id', async () => {
    render(<RoomingListTab block={BLOCK} />);
    expect(await screen.findByText('CONF900')).toBeInTheDocument();
    expect(mocks.listReservations).toHaveBeenCalledWith({ groupBlockId: '1' });
  });

  it('surfaces a real backend error', async () => {
    mocks.listReservations.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission for this action.' }));
    render(<RoomingListTab block={BLOCK} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission for this action.');
  });
});
