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
  listFreeRooms: vi.fn(),
  listEligiblePreferredRooms: vi.fn(),
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
      listFreeRooms: mocks.listFreeRooms,
      listEligiblePreferredRooms: mocks.listEligiblePreferredRooms,
    },
  };
});

const ROOM_TYPE = { id: '1', code: 'DLX', name: 'Deluxe' };
const RATE_CODE = { id: '1', code: 'BAR', base_rate: '150.00', currency: 'NGN' };
const GUEST = { id: '1', first_name: 'Jordan', last_name: 'Fixture' };
const ROOM = { id: '5', room_number: '101', room_type_id: '1', floor: '1', housekeeping_reported_status: 'clean' };

describe('<AvailabilityTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE]);
    mocks.listRateCodes.mockResolvedValue([RATE_CODE]);
    mocks.listGuests.mockResolvedValue([GUEST]);
    mocks.listFreeRooms.mockResolvedValue([ROOM]);
    mocks.listEligiblePreferredRooms.mockResolvedValue([ROOM]);
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

  it('shows actual room numbers free right now only when the search date is the property\'s own current business date', async () => {
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });

    render(<AvailabilityTab activeProperty={{ id: '1', current_business_date: '2027-01-01' }} />);
    await screen.findByText('Deluxe (DLX)');

    await userEvent.selectOptions(screen.getByLabelText('Room type'), '1');
    const dateInputs = document.querySelectorAll('input[type="date"]');
    await userEvent.type(dateInputs[0], '2027-01-01');
    await userEvent.type(dateInputs[1], '2027-01-02');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Rooms free right now')).toBeInTheDocument();
    expect(mocks.listFreeRooms).toHaveBeenCalledWith('1');
    expect(await screen.findAllByText('101')).not.toHaveLength(0);
  });

  it('does not show the free-rooms-right-now panel for a future-dated search', async () => {
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2027-06-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });

    render(<AvailabilityTab activeProperty={{ id: '1', current_business_date: '2027-01-01' }} />);
    await screen.findByText('Deluxe (DLX)');

    await userEvent.selectOptions(screen.getByLabelText('Room type'), '1');
    const dateInputs = document.querySelectorAll('input[type="date"]');
    await userEvent.type(dateInputs[0], '2027-06-01');
    await userEvent.type(dateInputs[1], '2027-06-02');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    await screen.findByText('2027-06-01');
    expect(screen.queryByText('Rooms free right now')).not.toBeInTheDocument();
    expect(mocks.listFreeRooms).not.toHaveBeenCalled();
  });

  it('books a reservation carrying an optional preferred_room_id — a request, not a lock', async () => {
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
    await userEvent.selectOptions(screen.getByLabelText('Preferred room (optional)'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));

    expect(await screen.findByText(/Booked — confirmation ABC123/)).toBeInTheDocument();
    expect(mocks.createReservation).toHaveBeenCalledWith(expect.objectContaining({ preferred_room_id: '5' }));
  });

  it('fetches only the eligible preferred rooms for the searched date range, not every room of the type', async () => {
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });
    mocks.listEligiblePreferredRooms.mockResolvedValue([]);

    render(<AvailabilityTab />);
    await screen.findByText('Deluxe (DLX)');

    await userEvent.selectOptions(screen.getByLabelText('Room type'), '1');
    const dateInputs = document.querySelectorAll('input[type="date"]');
    await userEvent.type(dateInputs[0], '2027-01-01');
    await userEvent.type(dateInputs[1], '2027-01-02');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('2027-01-01');

    expect(mocks.listEligiblePreferredRooms).toHaveBeenCalledWith({
      roomTypeId: '1',
      arrivalDate: '2027-01-01',
      departureDate: '2027-01-02',
    });
    // Excluded (committed elsewhere) — only "No preference" remains.
    const preferredRoomSelect = screen.getByLabelText('Preferred room (optional)');
    expect(preferredRoomSelect.querySelectorAll('option')).toHaveLength(1);
  });

  it('omits preferred_room_id from the request entirely when left as "No preference"', async () => {
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
    const call = mocks.createReservation.mock.calls[0][0];
    expect(call).not.toHaveProperty('preferred_room_id');
  });
});
