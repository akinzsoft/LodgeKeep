import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AvailabilityTab } from '../AvailabilityTab.jsx';

const mocks = vi.hoisted(() => ({
  listRoomTypes: vi.fn(),
  listRateCodes: vi.fn(),
  listGuests: vi.fn(),
  checkAvailability: vi.fn(),
  createReservation: vi.fn(),
  createGuest: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { listRoomTypes: mocks.listRoomTypes, listRateCodes: mocks.listRateCodes },
    reservationsApi: {
      listGuests: mocks.listGuests,
      checkAvailability: mocks.checkAvailability,
      createReservation: mocks.createReservation,
      createGuest: mocks.createGuest,
    },
  };
});

const ROOM_TYPE = { id: '1', code: 'DLX', name: 'Deluxe' };
const RATE_CODE = { id: '1', code: 'BAR', base_rate: '150.00', currency: 'NGN' };
const GUEST = { id: '1', first_name: 'Jordan', last_name: 'Fixture' };

describe('<AvailabilityTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE]);
    mocks.listRateCodes.mockResolvedValue([RATE_CODE]);
    mocks.listGuests.mockResolvedValue([GUEST]);
  });

  it('searches availability and shows the sellable count per night', async () => {
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });
    render(<AvailabilityTab />);
    await screen.findByText('Deluxe (DLX)');

    await userEvent.selectOptions(screen.getByLabelText('Room type'), '1');
    const dateInputs = document.querySelectorAll('input[type="date"]');
    await userEvent.type(dateInputs[0], '2027-01-01');
    await userEvent.type(dateInputs[1], '2027-01-02');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('2027-01-01')).toBeInTheDocument();
    expect(mocks.checkAvailability).toHaveBeenCalledWith({
      roomTypeId: '1',
      arrivalDate: '2027-01-01',
      departureDate: '2027-01-02',
    });
  });

  it('books a reservation after a search, and shows the confirmation number', async () => {
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });
    mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });

    render(<AvailabilityTab />);
    await screen.findByText('Deluxe (DLX)');

    await userEvent.selectOptions(screen.getByLabelText('Room type'), '1');
    const dateInputs = document.querySelectorAll('input[type="date"]');
    await userEvent.type(dateInputs[0], '2027-01-01');
    await userEvent.type(dateInputs[1], '2027-01-02');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('2027-01-01');

    await userEvent.selectOptions(screen.getByLabelText('Guest'), '1');
    await userEvent.selectOptions(screen.getByLabelText('Rate code'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));

    expect(await screen.findByText(/Booked — confirmation ABC123/)).toBeInTheDocument();
    expect(mocks.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ guest_id: '1', rate_code_id: '1', room_type_id: '1' })
    );
  });
});
