import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AvailabilityTab } from '../AvailabilityTab.jsx';

const mocks = vi.hoisted(() => ({
  listRoomTypes: vi.fn(),
  listRateCodes: vi.fn(),
  resolveRate: vi.fn(),
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
    setupApi: { listRoomTypes: mocks.listRoomTypes, listRateCodes: mocks.listRateCodes, resolveRate: mocks.resolveRate },
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
// `valid_from` is NOT NULL on the real `rate_codes` table (backend/migrations/
// 20260905092000_create_rate_codes.js) — always populated on real data, set
// here too so `resolvePrimaryRateCodeForStay`'s own date check (no
// empty-result fallback, unlike `filterRateCodesForStay`) resolves this
// fixture correctly rather than accidentally exercising its "nothing is
// date-valid" branch instead.
const RATE_CODE = { id: '1', code: 'BAR', base_rate: '150.00', currency: 'NGN', valid_from: '2020-01-01', valid_to: null };
const GUEST = { id: '1', first_name: 'Jordan', last_name: 'Fixture' };
const GUEST_WITH_EMAIL = { id: '2', first_name: 'Sam', last_name: 'Withemail', email: 'sam@example.com' };
const GUEST_WITH_PHONE = { id: '3', first_name: 'Pat', last_name: 'Withphone', phone: '0801 234 5678' };
const ROOM = { id: '5', room_number: '101', room_type_id: '1', floor: '1', housekeeping_reported_status: 'clean' };

describe('<AvailabilityTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE]);
    mocks.listRateCodes.mockResolvedValue([RATE_CODE]);
    // A distinct value from `RATE_CODE.base_rate` (and from the folio/
    // payment amounts other, unrelated tests in this file assert on
    // broadly) — the new always-visible rate list (below) would otherwise
    // duplicate "150.00" text elsewhere on the page and break an
    // unscoped `findByText(/150\.00/)` in a test that has nothing to do
    // with rate codes at all.
    mocks.resolveRate.mockResolvedValue({ rate: '75.00', overridden: false });
    mocks.listGuests.mockResolvedValue([GUEST, GUEST_WITH_EMAIL, GUEST_WITH_PHONE]);
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

  /**
   * Gap closure (user-reported): "the rate code dropdown ... shows what
   * appears to be all rate codes regardless of room type" — narrowed to
   * codes valid for the searched dates (rate codes aren't room-type scoped
   * in this schema at all; see `rate-code-eligibility.js`'s own header).
   */
  it('narrows the rate code dropdown to codes valid for the searched dates', async () => {
    const lapsedPromo = { id: '2', code: 'OLDPROMO', base_rate: '99.00', currency: 'NGN', valid_from: '2020-01-01', valid_to: '2021-12-31' };
    mocks.listRateCodes.mockResolvedValue([{ ...RATE_CODE, valid_from: '2020-01-01', valid_to: null }, lapsedPromo]);
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

    const rateCodeSelect = screen.getByLabelText('Rate code');
    expect(within(rateCodeSelect).getByText(/^BAR —/)).toBeInTheDocument();
    expect(within(rateCodeSelect).queryByText(/^OLDPROMO —/)).not.toBeInTheDocument();
    expect(screen.getByText('Narrowed to rate codes valid for these dates.')).toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "wen Room type is selected it shld show
   * the Rate/cost per night on the Rate code drop box only" — the dropdown
   * shows the ROOM-TYPE-resolved per-night rate (`setupApi.resolveRate`),
   * not just the rate code's own generic `base_rate`.
   */
  it('shows the room-type-resolved rate, not the plain base_rate, once a search resolves', async () => {
    mocks.resolveRate.mockResolvedValue({ rate: '175.00', overridden: false });
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

    expect(mocks.resolveRate).toHaveBeenCalledWith({ rateCodeId: '1', roomTypeId: '1', stayDate: '2027-01-01' });
    const rateCodeSelect = screen.getByLabelText('Rate code');
    expect(await within(rateCodeSelect).findByText('BAR — 175.00 NGN/night')).toBeInTheDocument();
    expect(within(rateCodeSelect).queryByText(/150\.00/)).not.toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported, with a screenshot): a closed, unselected
   * native <select> only ever shows its placeholder text ("Select a rate
   * code") — its own option list, however good, is invisible without a
   * click. This proves the per-night rate is ALSO rendered directly on the
   * page as plain text, with no interaction of any kind — the fix that
   * closes the actual gap the screenshot showed.
   */
  it('shows the per-night rate directly on the page, with no dropdown interaction needed', async () => {
    mocks.resolveRate.mockResolvedValue({ rate: '5000.00', overridden: false });
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

    // No click on the "Rate code" <select> at all — the amount is still on
    // the page as plain, always-rendered text.
    expect(await screen.findByText(/BAR: ₦5,000\.00\/night/)).toBeInTheDocument();
    expect(screen.getByLabelText('Rate code')).toHaveValue('');
  });

  /**
   * Gap closure (user-reported, third round, with a screenshot): "THE RATE
   * CODE PUT ONLY THE PRICE OF THE ROOM TYPE SELECTED... SHOWING ALL THE
   * RATE CODE ON THE DROP BOX [is] WRONG." Closed with a real
   * room_types.primary_rate_code_id link, confirmed with the user.
   */
  describe('a room type with a configured primary rate code', () => {
    const ROOM_TYPE_WITH_PRIMARY = { ...ROOM_TYPE, primary_rate_code_id: '1' };
    const OTHER_CODE = { id: '2', code: 'CORP-ACME', base_rate: '120.00', currency: 'NGN', valid_from: '2020-01-01', valid_to: null };

    async function searchDeluxe() {
      render(<AvailabilityTab />);
      await screen.findByText('Deluxe (DLX)');
      await userEvent.selectOptions(screen.getByLabelText('Room type'), '1');
      const dateInputs = document.querySelectorAll('input[type="date"]');
      await userEvent.type(dateInputs[0], '2027-01-01');
      await userEvent.type(dateInputs[1], '2027-01-02');
      await userEvent.click(screen.getByRole('button', { name: 'Search' }));
      await screen.findByText('2027-01-01');
    }

    it('collapses to just that one rate code, auto-selected, no dropdown shown', async () => {
      mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE_WITH_PRIMARY]);
      mocks.listRateCodes.mockResolvedValue([RATE_CODE, OTHER_CODE]);
      mocks.resolveRate.mockResolvedValue({ rate: '150.00', overridden: false });
      mocks.checkAvailability.mockResolvedValue({
        roomTypeId: '1',
        physicalCount: 5,
        minSellable: 3,
        nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
      });

      await searchDeluxe();

      expect(await screen.findByText(/BAR: ₦150\.00\/night/)).toBeInTheDocument();
      // The other, non-primary rate code never appears — not in a select,
      // not in a list, until "Use a different rate code" is clicked.
      expect(screen.queryByText(/CORP-ACME/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Rate code')).not.toBeInTheDocument();
    });

    it('auto-selects the primary rate code, so Book is enabled without any manual pick', async () => {
      mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE_WITH_PRIMARY]);
      mocks.listRateCodes.mockResolvedValue([RATE_CODE]);
      mocks.resolveRate.mockResolvedValue({ rate: '150.00', overridden: false });
      mocks.checkAvailability.mockResolvedValue({
        roomTypeId: '1',
        physicalCount: 5,
        minSellable: 3,
        nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
      });
      mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });

      await searchDeluxe();
      await screen.findByText(/BAR: ₦150\.00\/night/);
      await userEvent.selectOptions(screen.getByLabelText('Guest'), '1');
      await userEvent.click(screen.getByRole('button', { name: 'Book' }));

      expect(await screen.findByText(/Booked — confirmation ABC123/)).toBeInTheDocument();
      expect(mocks.createReservation).toHaveBeenCalledWith(expect.objectContaining({ rate_code_id: '1' }));
    });

    it('"Use a different rate code" reveals the full picker for a corporate/negotiated rate', async () => {
      mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE_WITH_PRIMARY]);
      mocks.listRateCodes.mockResolvedValue([RATE_CODE, OTHER_CODE]);
      mocks.resolveRate.mockResolvedValue({ rate: '150.00', overridden: false });
      mocks.checkAvailability.mockResolvedValue({
        roomTypeId: '1',
        physicalCount: 5,
        minSellable: 3,
        nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
      });
      mocks.createReservation.mockResolvedValue({ id: '10', status: 'confirmed', confirmation_number: 'ABC123' });

      await searchDeluxe();
      await screen.findByText(/BAR: ₦150\.00\/night/);

      await userEvent.click(screen.getByRole('button', { name: 'Use a different rate code' }));

      const rateCodeSelect = await screen.findByLabelText('Rate code');
      expect(within(rateCodeSelect).getByText(/^CORP-ACME —/)).toBeInTheDocument();
      await userEvent.selectOptions(rateCodeSelect, '2');
      await userEvent.selectOptions(screen.getByLabelText('Guest'), '1');
      await userEvent.click(screen.getByRole('button', { name: 'Book' }));

      expect(await screen.findByText(/Booked — confirmation ABC123/)).toBeInTheDocument();
      expect(mocks.createReservation).toHaveBeenCalledWith(expect.objectContaining({ rate_code_id: '2' }));
    });

    it('falls back to the full picker when this room type has no primary rate code configured', async () => {
      mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE]); // no primary_rate_code_id
      mocks.listRateCodes.mockResolvedValue([RATE_CODE, OTHER_CODE]);
      mocks.checkAvailability.mockResolvedValue({
        roomTypeId: '1',
        physicalCount: 5,
        minSellable: 3,
        nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
      });

      await searchDeluxe();

      expect(await screen.findByLabelText('Rate code')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Use a different rate code' })).not.toBeInTheDocument();
    });

    it('falls back to the full picker when the configured primary is no longer date-valid for this search', async () => {
      const lapsedPrimary = { ...RATE_CODE, valid_from: '2020-01-01', valid_to: '2021-12-31' };
      mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE_WITH_PRIMARY]);
      mocks.listRateCodes.mockResolvedValue([lapsedPrimary, OTHER_CODE]);
      mocks.checkAvailability.mockResolvedValue({
        roomTypeId: '1',
        physicalCount: 5,
        minSellable: 3,
        nights: [{ stayDate: '2027-01-01', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
      });

      await searchDeluxe();

      expect(await screen.findByLabelText('Rate code')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Use a different rate code' })).not.toBeInTheDocument();
    });
  });

  it('flags a room/date-specific override explicitly, in the dropdown text', async () => {
    mocks.resolveRate.mockResolvedValue({ rate: '200.00', overridden: true });
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

    expect(
      await within(screen.getByLabelText('Rate code')).findByText('BAR — 200.00 NGN/night (room override)')
    ).toBeInTheDocument();
  });

  it('falls back to the rate code’s own base_rate when the resolve fails (e.g. a role without setup.view)', async () => {
    mocks.resolveRate.mockRejectedValue(new Error('403 forbidden'));
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

    expect(
      await within(screen.getByLabelText('Rate code')).findByText('BAR — 150.00 NGN/night')
    ).toBeInTheDocument();
  });

  it('offers every rate code, unfiltered, when none of them covers the searched dates', async () => {
    const lapsedPromo = { id: '2', code: 'OLDPROMO', base_rate: '99.00', currency: 'NGN', valid_from: '2020-01-01', valid_to: '2021-12-31' };
    const notYetOpen = { id: '3', code: 'FUTUREPLAN', base_rate: '120.00', currency: 'NGN', valid_from: '2030-01-01', valid_to: null };
    mocks.listRateCodes.mockResolvedValue([lapsedPromo, notYetOpen]);
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

    const rateCodeSelect = screen.getByLabelText('Rate code');
    expect(within(rateCodeSelect).getByText(/^OLDPROMO —/)).toBeInTheDocument();
    expect(within(rateCodeSelect).getByText(/^FUTUREPLAN —/)).toBeInTheDocument();
    expect(screen.queryByText('Narrowed to rate codes valid for these dates.')).not.toBeInTheDocument();
  });

  it('clears a selected rate code that is no longer valid once the searched dates change, but keeps it across an unchanged re-search', async () => {
    const summerOnly = { id: '1', code: 'SUMMER26', base_rate: '150.00', currency: 'NGN', valid_from: '2026-06-01', valid_to: '2026-08-31' };
    // A second, always-open code so the September re-search has a genuinely
    // valid option of its own — otherwise the empty-result fallback (see
    // `rate-code-eligibility.js`) would keep offering SUMMER26 anyway as
    // the only code there is, muddying what this test is actually proving.
    const alwaysOpen = { id: '2', code: 'BAR', base_rate: '120.00', currency: 'NGN', valid_from: '2020-01-01', valid_to: null };
    mocks.listRateCodes.mockResolvedValue([summerOnly, alwaysOpen]);
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2026-06-15', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });
    render(<AvailabilityTab />);
    await screen.findByText('Deluxe (DLX)');

    await userEvent.selectOptions(screen.getByLabelText('Room type'), '1');
    const dateInputs = document.querySelectorAll('input[type="date"]');
    await userEvent.type(dateInputs[0], '2026-06-15');
    await userEvent.type(dateInputs[1], '2026-06-18');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('2026-06-15');
    await userEvent.selectOptions(screen.getByLabelText('Rate code'), '1');
    expect(screen.getByLabelText('Rate code')).toHaveValue('1');

    // Re-run the identical search (unchanged dates) — the selection survives.
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('2026-06-15');
    expect(screen.getByLabelText('Rate code')).toHaveValue('1');

    // Now search dates the code no longer covers — the stale selection is cleared.
    mocks.checkAvailability.mockResolvedValue({
      roomTypeId: '1',
      physicalCount: 5,
      minSellable: 3,
      nights: [{ stayDate: '2026-09-10', physicalCount: 5, roomsSold: 2, threshold: 5, sellable: 3 }],
    });
    await userEvent.clear(dateInputs[0]);
    await userEvent.type(dateInputs[0], '2026-09-10');
    await userEvent.clear(dateInputs[1]);
    await userEvent.type(dateInputs[1], '2026-09-12');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('2026-09-10');

    expect(screen.getByLabelText('Rate code')).toHaveValue('');
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
   * Gap closure (user-reported): a "Phone number" field before Guest —
   * `guests` is already the tenant's full list, so matching is a plain
   * synchronous scan by a normalized (digits-only) phone; no new network
   * call. Deliberately typed with spaces to prove the normalization
   * matches the fixture's own differently-formatted stored phone.
   */
  async function searchOnly() {
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
  }

  it('finds a guest by phone number and auto-selects them in the Guest dropdown', async () => {
    await searchOnly();

    await userEvent.type(screen.getByLabelText('Phone number'), '08012345678');

    expect(await screen.findByText(/Guest found — Pat Withphone/)).toBeInTheDocument();
    expect(screen.getByLabelText('Guest')).toHaveValue('3');
  });

  it('prompts to register a new guest when the phone number matches nobody, and opens the New guest panel pre-filled', async () => {
    await searchOnly();

    await userEvent.type(screen.getByLabelText('Phone number'), '09999999999');

    expect(await screen.findByText('No guest found with this phone number.')).toBeInTheDocument();
    expect(screen.queryByText(/Guest found/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Register new guest' }));

    const detailsEl = screen.getByText('New guest').closest('details');
    expect(detailsEl).toHaveAttribute('open');
    expect(screen.getByLabelText('Phone')).toHaveValue('09999999999');
  });

  it('shows neither the found nor the not-found message for a partially-typed phone number', async () => {
    await searchOnly();

    await userEvent.type(screen.getByLabelText('Phone number'), '123');

    expect(screen.queryByText(/Guest found/)).not.toBeInTheDocument();
    expect(screen.queryByText('No guest found with this phone number.')).not.toBeInTheDocument();
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
