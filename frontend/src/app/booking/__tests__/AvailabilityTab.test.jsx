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
  openBookingFolio: vi.fn(),
  captureCashPayment: vi.fn(),
  capturePaystackPayment: vi.fn(),
  verifyPayment: vi.fn(),
  getFolio: vi.fn(),
  openPaystackPopup: vi.fn(),
  listGroupBlocks: vi.fn(),
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
      openBookingFolio: mocks.openBookingFolio,
    },
    cashieringApi: {
      captureCashPayment: mocks.captureCashPayment,
      capturePaystackPayment: mocks.capturePaystackPayment,
      verifyPayment: mocks.verifyPayment,
      getFolio: mocks.getFolio,
    },
    groupBlocksApi: { listGroupBlocks: mocks.listGroupBlocks },
  };
});

vi.mock('../../../shared/paystack.js', () => ({
  openPaystackPopup: mocks.openPaystackPopup,
}));

const ROOM_TYPE = { id: '1', code: 'DLX', name: 'Deluxe' };
const RATE_CODE = { id: '1', code: 'BAR', base_rate: '150.00', currency: 'NGN' };
const GUEST = { id: '1', first_name: 'Jordan', last_name: 'Fixture' };
const GUEST_WITH_EMAIL = { id: '2', first_name: 'Sam', last_name: 'Withemail', email: 'sam@example.com' };
const ROOM = { id: '5', room_number: '101', room_type_id: '1', floor: '1', housekeeping_reported_status: 'clean' };

describe('<AvailabilityTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE]);
    mocks.listRateCodes.mockResolvedValue([RATE_CODE]);
    mocks.listGuests.mockResolvedValue([GUEST, GUEST_WITH_EMAIL]);
    mocks.listFreeRooms.mockResolvedValue([ROOM]);
    mocks.listEligiblePreferredRooms.mockResolvedValue([ROOM]);
    mocks.listGroupBlocks.mockResolvedValue([]);
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

  it('books a reservation carrying an optional group_block_id — PLAN.md Phase 4', async () => {
    mocks.listGroupBlocks.mockResolvedValue([{ id: '7', block_name: 'Acme Conference' }]);
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });
    mocks.createReservation.mockResolvedValue({ id: '11', status: 'confirmed', confirmation_number: 'GRP123' });

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
    expect(await screen.findByRole('option', { name: 'Acme Conference' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Group block (optional)'), '7');
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));

    expect(await screen.findByText(/Booked — confirmation GRP123/)).toBeInTheDocument();
    expect(mocks.createReservation).toHaveBeenCalledWith(expect.objectContaining({ group_block_id: '7' }));
  });

  it('omits group_block_id from the request when left as "Not part of a group"', async () => {
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });
    mocks.createReservation.mockResolvedValue({ id: '12', status: 'confirmed', confirmation_number: 'NOGRP1' });

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

    await screen.findByText(/Booked — confirmation NOGRP1/);
    expect(mocks.createReservation).toHaveBeenCalledWith(expect.not.objectContaining({ group_block_id: expect.anything() }));
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

  /**
   * Gap closure (user-reported): "pay at the point of booking." A
   * successful CONFIRMED booking opens a real folio and shows its balance
   * with Cash/Card actions — see this file's own header.
   */
  async function searchAndBook() {
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
    await screen.findByText('2027-01-01');
    await userEvent.selectOptions(screen.getByLabelText('Guest'), '1');
    await userEvent.selectOptions(screen.getByLabelText('Rate code'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await screen.findByText(/Booked — confirmation ABC123/);
  }

  it('opens a real folio and shows the balance for a confirmed booking', async () => {
    mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });
    mocks.openBookingFolio.mockResolvedValue({ id: '20', balance: '150.00', currency: 'NGN', status: 'open' });

    await searchAndBook();

    expect(mocks.openBookingFolio).toHaveBeenCalledWith('10');
    expect(await screen.findByText(/₦150\.00/)).toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "wen payment is done disable the book
   * button ... " — disabled the instant a reservation exists this search
   * cycle (not only once payment settles), since a booked-but-unpaid
   * reservation is still one real booking and a second Book click before
   * paying would create a genuine duplicate. A fresh Search is the only
   * thing that re-enables it.
   */
  it('disables Book after a successful booking, re-enabled only by a new Search', async () => {
    mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });
    mocks.openBookingFolio.mockResolvedValue({ id: '20', balance: '150.00', currency: 'NGN', status: 'open' });

    await searchAndBook();

    expect(screen.getByRole('button', { name: 'Book' })).toBeDisabled();
    expect(screen.getByText('Run a new search to make another booking.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('2027-01-01')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book' })).not.toBeDisabled();
    expect(screen.queryByText(/₦150\.00/)).not.toBeInTheDocument();
  });

  it('does not open a folio for a waitlisted booking — no room to bill yet', async () => {
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });
    mocks.createReservation.mockResolvedValue({ id: '11', status: 'waitlisted', confirmation_number: 'ABC123' });

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

    expect(await screen.findByText(/Added to the waitlist/)).toBeInTheDocument();
    expect(mocks.openBookingFolio).not.toHaveBeenCalled();
    expect(screen.queryByText(/Balance due/)).not.toBeInTheDocument();
  });

  it('captures a cash payment for the folio’s real balance, and shows the settled state once it zeroes', async () => {
    mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });
    mocks.openBookingFolio.mockResolvedValue({ id: '20', balance: '150.00', currency: 'NGN', status: 'open' });
    mocks.captureCashPayment.mockResolvedValue({ id: '30', status: 'CAPTURED' });
    mocks.getFolio.mockResolvedValue({ id: '20', balance: '0.00', currency: 'NGN', status: 'open' });

    await searchAndBook();
    await screen.findByText(/₦150\.00/);
    await userEvent.click(screen.getByRole('button', { name: 'Cash' }));

    expect(mocks.captureCashPayment).toHaveBeenCalledWith('20', { amount: '150.00', currency: 'NGN' });

    /**
     * Gap closure (user-reported): "wen payment is done disable the ...
     * payment buttons" — once settled, the form controls are replaced by a
     * positive-state summary rather than left as disabled buttons with no
     * explanation.
     */
    expect(await screen.findByText('Paid in full')).toBeInTheDocument();
    expect(screen.getByText(/No balance due/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cash' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Card' })).not.toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "the form textfield amt is editable pls
   * correct it."
   */
  it('renders the payment Amount field as read-only, locked to the real balance', async () => {
    mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });
    mocks.openBookingFolio.mockResolvedValue({ id: '20', balance: '150.00', currency: 'NGN', status: 'open' });

    await searchAndBook();
    await screen.findByText(/₦150\.00/);

    const amountInput = screen.getByLabelText('Amount');
    expect(amountInput).toHaveAttribute('readonly');
    expect(amountInput).toHaveValue('150.00');
  });

  it('disables the Card button when the selected guest has no email on file', async () => {
    mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });
    mocks.openBookingFolio.mockResolvedValue({ id: '20', balance: '150.00', currency: 'NGN', status: 'open' });

    await searchAndBook();
    await screen.findByText(/₦150\.00/);

    expect(screen.getByRole('button', { name: 'Card' })).toBeDisabled();
    expect(screen.getByText('Add an email to this guest to accept card payment.')).toBeInTheDocument();
  });

  it('generates a real Paystack checkout link for a guest with an email on file', async () => {
    mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });
    mocks.openBookingFolio.mockResolvedValue({ id: '20', balance: '150.00', currency: 'NGN', status: 'open' });
    mocks.capturePaystackPayment.mockResolvedValue({ id: '31', authorizationUrl: 'https://paystack.test/pay/abc' });

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
    await screen.findByText('2027-01-01');
    await userEvent.selectOptions(screen.getByLabelText('Guest'), '2'); // GUEST_WITH_EMAIL
    await userEvent.selectOptions(screen.getByLabelText('Rate code'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await screen.findByText(/₦150\.00/);

    await userEvent.click(screen.getByRole('button', { name: 'Card' }));

    expect(mocks.capturePaystackPayment).toHaveBeenCalledWith('20', {
      amount: '150.00',
      currency: 'NGN',
      guestEmail: 'sam@example.com',
    });
    expect(await screen.findByRole('link', { name: 'Open payment page in a new tab' })).toHaveAttribute(
      'href',
      'https://paystack.test/pay/abc'
    );
    expect(screen.queryByText('https://paystack.test/pay/abc')).not.toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "cant it be done same page." The backend
   * now also returns `accessCode` alongside `authorizationUrl` — this
   * proves the screen surfaces a same-page popup option for it, and that
   * closing the popup re-verifies through the real backend and refreshes
   * the folio, exactly like `CashieringScreen`'s identical flow.
   */
  it('offers an embedded "Pay now" popup when accessCode is present, and re-verifies + refreshes on close', async () => {
    mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });
    mocks.openBookingFolio.mockResolvedValue({ id: '20', balance: '150.00', currency: 'NGN', status: 'open' });
    mocks.capturePaystackPayment.mockResolvedValue({
      id: '31',
      authorizationUrl: 'https://paystack.test/pay/abc',
      accessCode: 'access-abc',
    });
    mocks.verifyPayment.mockResolvedValue({ id: '31', status: 'CAPTURED' });
    mocks.getFolio.mockResolvedValue({ id: '20', balance: '0.00', currency: 'NGN', status: 'open' });
    mocks.openPaystackPopup.mockImplementation(async ({ onClose }) => {
      await onClose();
    });

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
    await screen.findByText('2027-01-01');
    await userEvent.selectOptions(screen.getByLabelText('Guest'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Rate code'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await screen.findByText(/₦150\.00/);

    await userEvent.click(screen.getByRole('button', { name: 'Card' }));
    await screen.findByRole('link', { name: 'Open payment page in a new tab' });

    await userEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(mocks.openPaystackPopup).toHaveBeenCalledWith(
      expect.objectContaining({ accessCode: 'access-abc', onClose: expect.any(Function) })
    );
    expect(mocks.verifyPayment).toHaveBeenCalledWith('31');
    expect(await screen.findByText('Paid in full')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay now' })).not.toBeInTheDocument();
  });

  it('shows the honest partial-success message when the gateway is not configured', async () => {
    mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });
    mocks.openBookingFolio.mockResolvedValue({ id: '20', balance: '150.00', currency: 'NGN', status: 'open' });
    mocks.capturePaystackPayment.mockResolvedValue({
      id: '31',
      checkoutError: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
      retry: '/cashiering/payments/31/start-checkout',
    });

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
    await screen.findByText('2027-01-01');
    await userEvent.selectOptions(screen.getByLabelText('Guest'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Rate code'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await screen.findByText(/₦150\.00/);

    await userEvent.click(screen.getByRole('button', { name: 'Card' }));

    expect(await screen.findByText('PAYMENT_GATEWAY_NOT_CONFIGURED')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open payment page in a new tab' })).not.toBeInTheDocument();
  });
});
