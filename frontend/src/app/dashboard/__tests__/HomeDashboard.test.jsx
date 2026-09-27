import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeDashboard } from '../HomeDashboard.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  listReservations: vi.fn(),
  listArrivals: vi.fn(),
  listDepartures: vi.fn(),
  listInHouse: vi.fn(),
  listRoomTypes: vi.fn(),
  getSetupProgress: vi.fn(),
  listDiscrepancies: vi.fn(),
  getOccupancyReport: vi.fn(),
  getRevenueReport: vi.fn(),
  getOversoldRoomTypes: vi.fn(),
  listRuns: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    reservationsApi: {
      listReservations: mocks.listReservations,
      listArrivals: mocks.listArrivals,
      listDepartures: mocks.listDepartures,
      listInHouse: mocks.listInHouse,
    },
    setupApi: { listRoomTypes: mocks.listRoomTypes, getSetupProgress: mocks.getSetupProgress },
    housekeepingApi: { listDiscrepancies: mocks.listDiscrepancies },
    reportingApi: {
      getOccupancyReport: mocks.getOccupancyReport,
      getRevenueReport: mocks.getRevenueReport,
      getOversoldRoomTypes: mocks.getOversoldRoomTypes,
    },
    nightAuditApi: { listRuns: mocks.listRuns },
  };
});

const BUSINESS_DATE = '2026-09-10';
const PROPERTY = { id: '3', name: 'Harbour View Lodge', timezone: 'Africa/Lagos', base_currency: 'NGN' };
// 09:00 in Lagos (UTC+1).
const MORNING = new Date('2026-09-10T08:00:00Z');

/** Arrivals this month (September): two Deluxe, one Suite. The cancelled one and August's never count. */
const RESERVATIONS = [
  { id: '1', guest_id: '1', room_type_id: '1', status: 'checked_out', arrival_date: '2026-08-30' },
  { id: '2', guest_id: '1', room_type_id: '1', status: 'checked_in', arrival_date: '2026-09-08' },
  { id: '3', guest_id: '2', room_type_id: '2', status: 'confirmed', arrival_date: '2026-09-09' },
  { id: '4', guest_id: '3', room_type_id: '1', status: 'tentative', arrival_date: '2026-09-10' },
  { id: '5', guest_id: '4', room_type_id: '2', status: 'cancelled', arrival_date: '2026-09-09' },
];

const OCCUPANCY = [
  // Audited days carry no physical count — the open day's live one stands in.
  { date: '2026-09-09', physicalCount: null, roomsSold: 4, occupancyPct: 40, audited: true },
  { date: '2026-09-10', physicalCount: 10, roomsSold: 3, occupancyPct: 30, audited: false },
];

const REVENUE = [
  { date: '2026-09-02', roomRevenue: '100.00', roomsSold: 1, adr: '100.00', revpar: '10.00' },
  { date: '2026-09-09', roomRevenue: '200.00', roomsSold: 2, adr: '100.00', revpar: '20.00' },
  { date: '2026-09-10', roomRevenue: '250.00', roomsSold: 2, adr: '125.00', revpar: '25.00' },
];

function renderDashboard(props = {}) {
  return render(<HomeDashboard greetingName="Ada" businessDate={BUSINESS_DATE} activeProperty={PROPERTY} now={MORNING} {...props} />);
}

const card = (name) => screen.getByRole('article', { name });
const region = (name) => screen.getByRole('region', { name });

describe('<HomeDashboard>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listReservations.mockResolvedValue(RESERVATIONS);
    mocks.listRoomTypes.mockResolvedValue([
      { id: '1', name: 'Deluxe' },
      { id: '2', name: 'Suite' },
    ]);
    mocks.getOccupancyReport.mockResolvedValue(OCCUPANCY);
    mocks.getRevenueReport.mockResolvedValue(REVENUE);
    mocks.listArrivals.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    mocks.listDepartures.mockResolvedValue([{ id: 'c' }]);
    mocks.listInHouse.mockResolvedValue([{ id: 'd' }, { id: 'e' }, { id: 'f' }]);
    mocks.getSetupProgress.mockResolvedValue({ steps: [], operational: true });
    mocks.listDiscrepancies.mockResolvedValue([]);
    mocks.getOversoldRoomTypes.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue([]);
  });

  describe('page header', () => {
    it("greets the signed-in user by name for the time of day at the property's timezone", () => {
      renderDashboard();
      expect(screen.getByRole('heading', { level: 1, name: 'Good morning, Ada' })).toBeInTheDocument();
    });

    it('shows the property, the calendar date and the business date', () => {
      renderDashboard();
      expect(screen.getByText('Harbour View Lodge')).toBeInTheDocument();
      expect(screen.getByText('Thursday, 10 September · Business date Thu, 10 Sep 2026')).toBeInTheDocument();
    });

    it('greets without a name rather than falling back to an email or placeholder', () => {
      renderDashboard({ greetingName: undefined, now: new Date('2026-09-10T19:00:00Z') });
      expect(screen.getByRole('heading', { level: 1, name: 'Good evening' })).toBeInTheDocument();
    });

    it("offers shortcuts only to screens this user's role can open", async () => {
      const onNavigate = vi.fn();
      renderDashboard({ onNavigate, canNavigate: (key) => key === 'booking' });
      await userEvent.click(screen.getByRole('button', { name: 'Front desk & bookings' }));
      expect(onNavigate).toHaveBeenCalledWith('booking');
      expect(screen.queryByRole('button', { name: 'Reports' })).not.toBeInTheDocument();
    });

    it('shows no shortcuts when the shell supplies no navigation', () => {
      renderDashboard();
      expect(screen.queryByRole('button', { name: 'Front desk & bookings' })).not.toBeInTheDocument();
    });
  });

  describe('headline KPIs', () => {
    it('reads occupancy for the business date from the occupancy report, against the previous day in percentage points', async () => {
      renderDashboard();
      const occupancy = card('Occupancy');
      expect(await within(occupancy).findByText('30%')).toBeInTheDocument();
      expect(within(occupancy).getByLabelText('Down 10 pts vs. the previous business day')).toBeInTheDocument();
      expect(within(occupancy).getByText('3 of 10 rooms sold')).toBeInTheDocument();
      // A 14-day window ending on the business date — never the wall clock.
      expect(mocks.getOccupancyReport).toHaveBeenCalledWith({ dateFrom: '2026-08-28', dateTo: BUSINESS_DATE });
    });

    it('shows ADR, RevPAR and room revenue from the revenue report, each against the previous day', async () => {
      renderDashboard();
      expect(await within(card('ADR')).findByText(/125\.00/)).toBeInTheDocument();
      expect(within(card('ADR')).getByLabelText('Up 25% vs. the previous business day')).toBeInTheDocument();
      expect(within(card('RevPAR')).getByText(/25\.00/)).toBeInTheDocument();
      expect(within(card('Room revenue')).getByText(/250\.00/)).toBeInTheDocument();
      expect(within(card('Room revenue')).getByLabelText('Up 25% vs. the previous business day')).toBeInTheDocument();
      // The last 7 days only: 200.00 + 250.00 (09-02 is outside).
      expect(within(card('Room revenue')).getByText(/450\.00/)).toBeInTheDocument();
      expect(mocks.getRevenueReport).toHaveBeenCalledWith({ dateFrom: '2026-08-28', dateTo: BUSINESS_DATE });
    });

    it('shows no average rate when no rooms were sold, never a false 0.00', async () => {
      mocks.getRevenueReport.mockResolvedValue([{ date: BUSINESS_DATE, roomRevenue: '0.00', roomsSold: 0, adr: '0.00', revpar: '0.00' }]);
      renderDashboard();
      const adr = card('ADR');
      expect(await within(adr).findByText('No rooms sold on this business date yet.')).toBeInTheDocument();
      expect(within(adr).getByText('—')).toBeInTheDocument();
      expect(within(adr).queryByText(/0\.00/)).not.toBeInTheDocument();
    });

    it('degrades only the revenue cards to "Not available for your role." on a 403 — occupancy still shows', async () => {
      mocks.getRevenueReport.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'No.', status: 403 }));
      renderDashboard();
      for (const name of ['ADR', 'RevPAR', 'Room revenue']) {
        expect(await within(card(name)).findByText('Not available for your role.')).toBeInTheDocument();
      }
      expect(await within(card('Occupancy')).findByText('30%')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows a real error message, not a blank card, when a report fails', async () => {
      mocks.getOccupancyReport.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'Report failed.', status: 500 }));
      renderDashboard();
      expect(await within(card('Occupancy')).findByText('Report failed.')).toBeInTheDocument();
    });

    it('shows skeletons while loading', () => {
      mocks.getOccupancyReport.mockReturnValue(new Promise(() => {}));
      renderDashboard();
      expect(within(card('Occupancy')).queryByText('30%')).not.toBeInTheDocument();
    });

    it('explains every figure that needs a business date when the property has none', () => {
      renderDashboard({ businessDate: null });
      expect(within(card('Occupancy')).getByText('Available once this property has a business date.')).toBeInTheDocument();
      expect(within(card('Room revenue')).getByText('Available once this property has a business date.')).toBeInTheDocument();
      expect(mocks.getOccupancyReport).not.toHaveBeenCalled();
    });
  });

  describe("today's operations", () => {
    it('counts arrivals, departures and in-house stays, and rooms still free tonight', async () => {
      renderDashboard();
      const ops = region("Today's operations");
      expect(await within(ops).findByRole('group', { name: 'Arrivals' })).toHaveTextContent('2');
      expect(within(ops).getByRole('group', { name: 'Departures' })).toHaveTextContent('1');
      expect(within(ops).getByRole('group', { name: 'In-house' })).toHaveTextContent('3');
      const rooms = within(ops).getByRole('group', { name: 'Rooms available' });
      expect(rooms).toHaveTextContent('7');
      expect(rooms).toHaveTextContent('Free tonight, of 10 sellable');
    });

    it('says a count is not available for the role rather than showing zero', async () => {
      mocks.listInHouse.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'No.', status: 403 }));
      renderDashboard();
      const inHouse = within(region("Today's operations")).getByRole('group', { name: 'In-house' });
      expect(await within(inHouse).findByText('Not available for your role.')).toBeInTheDocument();
      expect(within(inHouse).getByText('—')).toBeInTheDocument();
    });
  });

  describe('trends', () => {
    it('charts occupancy and daily room revenue over 14 days, with the average and the total', async () => {
      renderDashboard();
      const occupancy = region('Occupancy trend');
      expect(await within(occupancy).findByRole('img', { name: /Occupancy over the last 14 business days, ending at 30%/ })).toBeInTheDocument();
      // (40 + 30) / 2 — only days with a figure count.
      expect(within(occupancy).getByText('35%')).toBeInTheDocument();
      expect(within(occupancy).getByText('Last 14 days · 28 Aug – 10 Sep')).toBeInTheDocument();

      const revenue = region('Room revenue trend');
      expect(within(revenue).getByRole('img', { name: 'Daily room revenue over the last 14 business days' })).toBeInTheDocument();
      expect(within(revenue).getByText(/550\.00/)).toBeInTheDocument();
    });

    it("breaks this month's arrivals down by room type, excluding cancelled bookings", async () => {
      renderDashboard();
      const byType = region('Bookings by room type');
      expect(await within(byType).findByRole('img', { name: 'Bookings by room type: Deluxe 67%, Suite 33%' })).toBeInTheDocument();
      expect(within(byType).getByText('Deluxe')).toBeInTheDocument();
    });

    it('says so when nothing arrives this month', async () => {
      mocks.listReservations.mockResolvedValue([]);
      renderDashboard();
      expect(await within(region('Bookings by room type')).findByText('No bookings arriving this month yet.')).toBeInTheDocument();
    });
  });

  describe('needs attention', () => {
    it('shows "None" when nothing needs attention, and that night audit has not run', async () => {
      renderDashboard();
      const attention = region('Needs attention');
      expect(await within(attention).findAllByText('None')).toHaveLength(2);
      expect(await within(attention).findByText('Not yet run')).toBeInTheDocument();
    });

    it('counts open discrepancies and oversold room types, and shows the real night audit status', async () => {
      mocks.listDiscrepancies.mockResolvedValue([{ id: '1' }, { id: '2' }]);
      mocks.getOversoldRoomTypes.mockResolvedValue([{ roomTypeId: '1' }]);
      mocks.listRuns.mockResolvedValue([{ business_date: BUSINESS_DATE, status: 'COMPLETED' }]);
      renderDashboard();
      const attention = region('Needs attention');
      expect(await within(attention).findByText('2')).toBeInTheDocument();
      expect(within(attention).getByText('1')).toBeInTheDocument();
      expect(await within(attention).findByText('COMPLETED')).toBeInTheDocument();
    });

    it('says a check is not available rather than claiming "None" when it could not load', async () => {
      mocks.listDiscrepancies.mockRejectedValue(new Error('boom'));
      renderDashboard();
      const row = (await within(region('Needs attention')).findByText('Housekeeping discrepancies')).closest('li');
      expect(await within(row).findByText('Not available')).toBeInTheDocument();
    });
  });

  describe('setup banner', () => {
    it('shows while the property is not yet operational, with a way to finish setup', async () => {
      const onNavigateToSetup = vi.fn();
      mocks.getSetupProgress.mockResolvedValue({ steps: [], operational: false });
      renderDashboard({ onNavigateToSetup });
      const banner = await screen.findByRole('alert');
      expect(banner).toHaveTextContent('isn’t fully set up yet');
      await userEvent.click(within(banner).getByRole('button', { name: 'Finish setup' }));
      expect(onNavigateToSetup).toHaveBeenCalled();
    });

    it('stays hidden once setup is complete', async () => {
      renderDashboard();
      await within(card('Occupancy')).findByText('30%');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
