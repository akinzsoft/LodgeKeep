import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeDashboard } from '../HomeDashboard.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  listReservations: vi.fn(),
  listArrivals: vi.fn(),
  listDepartures: vi.fn(),
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

/**
 * "This week" is 2026-09-04..09-10, "last week" 08-28..09-03.
 * - Guest 1: first stay last week (new then), back this week (returning).
 * - Guests 2 and 3: first stays this week (new).
 * - Guest 4: cancelled — never counts.
 */
const RESERVATIONS = [
  { id: '1', guest_id: '1', room_type_id: '1', status: 'checked_out', arrival_date: '2026-08-30' },
  { id: '2', guest_id: '1', room_type_id: '1', status: 'checked_in', arrival_date: '2026-09-08' },
  { id: '3', guest_id: '2', room_type_id: '2', status: 'confirmed', arrival_date: '2026-09-09' },
  { id: '4', guest_id: '3', room_type_id: '1', status: 'tentative', arrival_date: '2026-09-10' },
  { id: '5', guest_id: '4', room_type_id: '2', status: 'cancelled', arrival_date: '2026-09-09' },
];

const OCCUPANCY = [
  // Audited days carry no physical count — today's live one stands in.
  { date: '2026-09-09', physicalCount: null, roomsSold: 4, occupancyPct: 40, audited: true },
  { date: '2026-09-10', physicalCount: 10, roomsSold: 3, occupancyPct: 30, audited: false },
];

const REVENUE = [
  { date: '2026-09-02', roomRevenue: '100.00' },
  { date: '2026-09-09', roomRevenue: '200.00' },
  { date: '2026-09-10', roomRevenue: '250.00' },
];

function renderDashboard(props = {}) {
  return render(
    <HomeDashboard greetingName="Ada" businessDate={BUSINESS_DATE} activeProperty={PROPERTY} now={MORNING} {...props} />
  );
}

function card(name) {
  return screen.getByRole('article', { name });
}

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
    mocks.listArrivals.mockResolvedValue([]);
    mocks.listDepartures.mockResolvedValue([]);
    mocks.getSetupProgress.mockResolvedValue({ steps: [], operational: true });
    mocks.listDiscrepancies.mockResolvedValue([]);
    mocks.getOversoldRoomTypes.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue([]);
  });

  describe('greeting', () => {
    it("greets the signed-in user by name for the time of day at the property's timezone", () => {
      renderDashboard();
      expect(screen.getByRole('heading', { level: 1, name: 'Good morning, Ada' })).toBeInTheDocument();
    });

    it('shows the real property name and date in the subline', () => {
      renderDashboard();
      expect(screen.getByText('Harbour View Lodge — Thursday, 10 September')).toBeInTheDocument();
    });

    it('greets without a name rather than falling back to an email or placeholder', () => {
      renderDashboard({ greetingName: undefined, now: new Date('2026-09-10T19:00:00Z') });
      expect(screen.getByRole('heading', { level: 1, name: 'Good evening' })).toBeInTheDocument();
    });
  });

  describe('summary widgets', () => {
    it('shows an honest empty state for Guest Rating — no guest reviews are collected anywhere yet', () => {
      renderDashboard();
      const widget = screen.getByRole('region', { name: 'Guest Rating' });
      expect(widget).toHaveTextContent('Guest ratings appear once guest reviews are collected.');
    });

    it("shows this week's real total income with a sparkline", async () => {
      renderDashboard();
      const widget = screen.getByRole('region', { name: 'Total Income — this week' });
      // 09-04..09-10 only: 200.00 + 250.00. Last week's 100.00 is excluded.
      expect(await within(widget).findByText(/450\.00/)).toBeInTheDocument();
      expect(within(widget).getByRole('img', { name: 'Daily income over the last 7 business days' })).toBeInTheDocument();
      expect(mocks.getRevenueReport).toHaveBeenCalledWith({ dateFrom: '2026-08-28', dateTo: BUSINESS_DATE });
    });

    it('falls back to the existing empty message when no income has been posted', async () => {
      mocks.getRevenueReport.mockResolvedValue([{ date: BUSINESS_DATE, roomRevenue: '0.00' }]);
      renderDashboard();
      const widget = screen.getByRole('region', { name: 'Total Income — this week' });
      expect(await within(widget).findByText('Total income appears once Cashiering is posting revenue.')).toBeInTheDocument();
    });
  });

  describe('KPI cards', () => {
    it('shows a loading skeleton, never a stale number, before data resolves', () => {
      mocks.listReservations.mockImplementation(() => new Promise(() => {}));
      renderDashboard();
      expect(screen.getAllByTestId('kpi-loading').length).toBeGreaterThan(0);
    });

    it("Total Bookings: this week's room-holding arrivals, with a real delta vs. last week and occupancy bar", async () => {
      renderDashboard();
      const bookings = await screen.findByRole('article', { name: 'Total Bookings' });
      expect(await within(bookings).findByText('3')).toBeInTheDocument();
      expect(within(bookings).getByLabelText('Up 2 vs. the previous 7 days')).toBeInTheDocument();
      expect(within(bookings).getByRole('progressbar', { name: 'Average occupancy this week: 35%' })).toBeInTheDocument();
    });

    it("Rooms Available: tonight's live free rooms, with a delta vs. the previous business day", async () => {
      renderDashboard();
      const rooms = card('Rooms Available');
      expect(await within(rooms).findByText('7')).toBeInTheDocument();
      expect(within(rooms).getByLabelText('Up 1 vs. the previous business day')).toBeInTheDocument();
      expect(within(rooms).getByRole('progressbar', { name: '7 of 10 rooms free tonight' })).toHaveAttribute('aria-valuenow', '70');
    });

    it('New Guests: first-time guests arriving this week, with a delta vs. last week', async () => {
      renderDashboard();
      const guests = card('New Guests');
      expect(await within(guests).findByText('2')).toBeInTheDocument();
      expect(within(guests).getByLabelText('Up 1 vs. the previous 7 days')).toBeInTheDocument();
      expect(within(guests).getByRole('progressbar', { name: "67% of this week's bookings are first-time guests" })).toBeInTheDocument();
    });

    it("Total Revenue: today's posted revenue, with a percent delta vs. the previous business day", async () => {
      renderDashboard();
      const revenue = card('Total Revenue');
      expect(await within(revenue).findByText(/250\.00/)).toBeInTheDocument();
      expect(within(revenue).getByLabelText('Up 25% vs. the previous business day')).toBeInTheDocument();
    });

    it('shows a down delta when a figure fell', async () => {
      mocks.getRevenueReport.mockResolvedValue([
        { date: '2026-09-09', roomRevenue: '400.00' },
        { date: '2026-09-10', roomRevenue: '100.00' },
      ]);
      renderDashboard();
      const revenue = card('Total Revenue');
      expect(await within(revenue).findByLabelText('Down 75% vs. the previous business day')).toBeInTheDocument();
    });

    it('degrades only the revenue cards to "Not available for your role." on a 403', async () => {
      mocks.getRevenueReport.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'Forbidden' }));
      renderDashboard();
      expect(await within(card('Total Revenue')).findByText('Not available for your role.')).toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: 'Total Income — this week' })).getByText('Not available for your role.')).toBeInTheDocument();
      expect(await within(card('Total Bookings')).findByText('3')).toBeInTheDocument();
    });

    it('uses the existing empty-state messages when nothing is populated yet', async () => {
      mocks.listReservations.mockResolvedValue([]);
      mocks.getOccupancyReport.mockResolvedValue([{ date: BUSINESS_DATE, physicalCount: 0, roomsSold: 0, occupancyPct: 0 }]);
      mocks.getRevenueReport.mockResolvedValue([]);
      renderDashboard();
      expect(await within(card('Total Bookings')).findByText('No reservations yet.')).toBeInTheDocument();
      expect(within(card('Rooms Available')).getByText('No rooms configured yet.')).toBeInTheDocument();
      expect(within(card('Total Revenue')).getByText('No revenue posted for today yet.')).toBeInTheDocument();
    });

    it('never fetches business-date reports for a property with no business date configured', async () => {
      renderDashboard({ businessDate: null });
      expect(await within(card('Rooms Available')).findByText('Available once this property has a business date.')).toBeInTheDocument();
      expect(mocks.getOccupancyReport).not.toHaveBeenCalled();
      expect(mocks.getRevenueReport).not.toHaveBeenCalled();
    });
  });

  describe('charts', () => {
    it('draws the New vs. Returning chart from real arrivals, with its legend', async () => {
      renderDashboard();
      const chartCard = screen.getByRole('region', { name: 'New vs. Returning Guests' });
      expect(await within(chartCard).findByRole('img', { name: 'Guest arrivals over the last 7 business days: 2 new, 1 returning' })).toBeInTheDocument();
      expect(within(chartCard).getByText('New')).toBeInTheDocument();
      expect(within(chartCard).getByText('Returning')).toBeInTheDocument();
    });

    it("draws this month's room-type donut with real names and percentages", async () => {
      renderDashboard();
      const chartCard = screen.getByRole('region', { name: 'Bookings by Room Type' });
      // September only: Deluxe 2 (ids 2, 4), Suite 1 (id 3). The August stay
      // (id 1) is last month and the cancelled one (id 5) never counts.
      expect(await within(chartCard).findByRole('img', { name: 'Bookings by room type: Deluxe 67%, Suite 33%' })).toBeInTheDocument();
      expect(within(chartCard).getByText('67%')).toBeInTheDocument();
      expect(within(chartCard).getByText('This month')).toBeInTheDocument();
    });

    it('renders both charts as their existing empty states when there are no reservations', async () => {
      mocks.listReservations.mockResolvedValue([]);
      renderDashboard();
      expect(await screen.findByText('This trend chart fills in once Reservations and Guest Profiles are tracking bookings.')).toBeInTheDocument();
      expect(screen.getByText('This breakdown appears once Rooms and Reservations are configured.')).toBeInTheDocument();
    });

    it('says so plainly when reservations exist but none arrived this week', async () => {
      mocks.listReservations.mockResolvedValue([RESERVATIONS[0]]);
      renderDashboard();
      expect(await screen.findByText('No guest arrivals in the last 7 business days.')).toBeInTheDocument();
      // Its only stay arrived in August, so this month's donut is honestly empty too.
      expect(screen.getByText('No bookings arriving this month yet.')).toBeInTheDocument();
    });
  });

  describe('today at a glance', () => {
    it('shows "Not yet run" for Night audit when no run exists for today\'s business date', async () => {
      renderDashboard();
      const row = (await screen.findByText("Night audit for today's business date")).closest('li');
      expect(row).toHaveTextContent('Not yet run');
    });

    it("renders the real status once today's business date has a night-audit run", async () => {
      mocks.listRuns.mockResolvedValue([{ id: '1', business_date: BUSINESS_DATE, status: 'COMPLETED' }]);
      renderDashboard();
      const row = (await screen.findByText("Night audit for today's business date")).closest('li');
      expect(await within(row).findByText('COMPLETED')).toBeInTheDocument();
    });

    it('degrades the Night audit row to "Not available for your role." on a 403', async () => {
      mocks.listRuns.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'Forbidden' }));
      renderDashboard();
      const row = (await screen.findByText("Night audit for today's business date")).closest('li');
      expect(await within(row).findByText('Not available for your role.')).toBeInTheDocument();
    });

    it('flags housekeeping discrepancies when non-zero', async () => {
      mocks.listDiscrepancies.mockResolvedValue([{ id: '1' }]);
      renderDashboard();
      const row = (await screen.findByText('Housekeeping discrepancies')).closest('li');
      expect(await within(row).findByText('1')).toBeInTheDocument();
    });
  });

  describe('setup banner', () => {
    it("shows a way to finish setup when the property isn't operational yet", async () => {
      mocks.getSetupProgress.mockResolvedValue({ steps: [], operational: false });
      const onNavigateToSetup = vi.fn();
      renderDashboard({ onNavigateToSetup });
      expect(await screen.findByRole('alert')).toHaveTextContent('fully set up yet');
      await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
      expect(onNavigateToSetup).toHaveBeenCalled();
    });

    it('shows no setup banner once the property is operational', async () => {
      renderDashboard();
      await within(card('Total Bookings')).findByText('3');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
