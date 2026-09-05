import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeDashboard } from '../HomeDashboard.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  listReservations: vi.fn(),
  listArrivals: vi.fn(),
  listDepartures: vi.fn(),
  listRooms: vi.fn(),
  listProperties: vi.fn(),
  getSetupProgress: vi.fn(),
  listDiscrepancies: vi.fn(),
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
    setupApi: { listRooms: mocks.listRooms, listProperties: mocks.listProperties, getSetupProgress: mocks.getSetupProgress },
    housekeepingApi: { listDiscrepancies: mocks.listDiscrepancies },
    reportingApi: { getRevenueReport: mocks.getRevenueReport, getOversoldRoomTypes: mocks.getOversoldRoomTypes },
    nightAuditApi: { listRuns: mocks.listRuns },
  };
});

/**
 * PLAN.md Phase 3: Reservations, Rooms, Housekeeping, and Reporting now
 * back four of this screen's data-bearing pieces — this file replaces the
 * pre-Phase-3 assertions (which expected only static placeholders) with
 * mocked-API coverage for the real loading/success/empty/error states each
 * card can now be in.
 */
describe('<HomeDashboard>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listReservations.mockResolvedValue([]);
    mocks.listArrivals.mockResolvedValue([]);
    mocks.listDepartures.mockResolvedValue([]);
    mocks.listRooms.mockResolvedValue([]);
    mocks.listProperties.mockResolvedValue([]);
    mocks.getSetupProgress.mockResolvedValue({ steps: [], operational: true });
    mocks.listDiscrepancies.mockResolvedValue([]);
    mocks.getRevenueReport.mockResolvedValue([]);
    mocks.getOversoldRoomTypes.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue([]);
  });

  it('greets the signed-in user by name', () => {
    render(<HomeDashboard greetingName="Emily Smith" />);
    expect(screen.getByRole('heading', { name: 'Hi, Emily Smith!' })).toBeInTheDocument();
  });

  it('falls back to a generic greeting with no name', () => {
    render(<HomeDashboard />);
    expect(screen.getByRole('heading', { name: 'Welcome back!' })).toBeInTheDocument();
  });

  it('shows a loading skeleton, never a stale number, before the reservations count resolves', () => {
    mocks.listReservations.mockImplementation(() => new Promise(() => {}));
    render(<HomeDashboard greetingName="Emily" />);
    expect(screen.getAllByTestId('kpi-loading').length).toBeGreaterThan(0);
  });

  it('renders real counts once the reservations/rooms endpoints resolve', async () => {
    mocks.listReservations.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    mocks.listRooms.mockResolvedValue([
      { id: '1', status: 'active' },
      { id: '2', status: 'out_of_service' },
    ]);
    render(<HomeDashboard greetingName="Emily" />);
    expect(await screen.findByText('2')).toBeInTheDocument(); // Total Booking
    expect(await screen.findByText('1')).toBeInTheDocument(); // Rooms Available (only the active one)
  });

  it('degrades the Total Revenue card to an honest "not available" message on a 403, not an error banner', async () => {
    mocks.getRevenueReport.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'Forbidden' }));
    render(<HomeDashboard greetingName="Emily" />);
    expect(await screen.findByText('Not available for your role.')).toBeInTheDocument();
  });

  it('still shows the honest empty state for New Customers — no real data source yet', async () => {
    render(<HomeDashboard greetingName="Emily" />);
    expect(await screen.findByText(/Available once guest profiles can be filtered by date/)).toBeInTheDocument();
  });

  it('shows "Not yet run" for Night audit when no run exists for today\'s business date', async () => {
    mocks.listRuns.mockResolvedValue([]);
    render(<HomeDashboard greetingName="Emily" businessDate="2026-09-05" />);
    const row = (await screen.findByText("Night audit for today's business date")).closest('li');
    expect(row).toHaveTextContent('Not yet run');
  });

  it("renders the real status once today's business date has a night-audit run", async () => {
    mocks.listRuns.mockResolvedValue([{ id: '1', business_date: '2026-09-05', status: 'COMPLETED' }]);
    render(<HomeDashboard greetingName="Emily" businessDate="2026-09-05" />);
    const row = (await screen.findByText("Night audit for today's business date")).closest('li');
    expect(row).toHaveTextContent('COMPLETED');
  });

  it('degrades the Night audit row to an honest "not available" message on a 403, not an error banner', async () => {
    mocks.listRuns.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'Forbidden' }));
    render(<HomeDashboard greetingName="Emily" />);
    const row = (await screen.findByText("Night audit for today's business date")).closest('li');
    expect(row).toHaveTextContent('Not available for your role.');
  });

  it('renders the chart row as named, honest empty states', () => {
    render(<HomeDashboard greetingName="Emily" />);
    expect(screen.getByText('New vs Returning Customers')).toBeInTheDocument();
    expect(screen.getByText('Bookings by Room Type')).toBeInTheDocument();
  });

  it('flags housekeeping discrepancies and oversold room types in danger tone when non-zero', async () => {
    mocks.listDiscrepancies.mockResolvedValue([{ id: '1' }]);
    mocks.getOversoldRoomTypes.mockResolvedValue([{ roomTypeId: '1' }]);
    render(<HomeDashboard greetingName="Emily" />);
    const discrepancyRow = (await screen.findByText('Housekeeping discrepancies')).closest('li');
    expect(discrepancyRow).toHaveTextContent('1');
  });

  it("shows a setup-incomplete banner with a way to finish setup when the property isn't operational yet", async () => {
    mocks.getSetupProgress.mockResolvedValue({ steps: [], operational: false });
    const onNavigateToSetup = vi.fn();
    render(<HomeDashboard greetingName="Emily" onNavigateToSetup={onNavigateToSetup} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('fully set up yet');
    await userEvent.click(await screen.findByRole('button', { name: 'Finish setup' }));
    expect(onNavigateToSetup).toHaveBeenCalled();
  });

  it('shows no setup banner once the property is operational', () => {
    render(<HomeDashboard greetingName="Emily" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
