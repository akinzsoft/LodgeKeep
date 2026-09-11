import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChainOverviewScreen } from '../ChainOverviewScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  getChainOverview: vi.fn(),
  getChainOverviewCsv: vi.fn(),
}));

const triggerDownloadMock = vi.hoisted(() => vi.fn());

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, reportingApi: mocks };
});

vi.mock('../../../shared/download.js', () => ({ triggerDownload: triggerDownloadMock }));

const OVERVIEW = {
  properties: [
    {
      propertyId: '1',
      propertyName: 'Alpha Hotels',
      currencyCode: 'NGN',
      businessDate: '2026-09-11',
      occupancyPct: 50,
      roomsSold: 5,
      roomRevenue: '500.00',
      audited: false,
    },
    {
      propertyId: '2',
      propertyName: 'Beta Resorts',
      currencyCode: 'NGN',
      businessDate: null,
      occupancyPct: null,
      roomsSold: null,
      roomRevenue: null,
      audited: false,
    },
  ],
  totals: {
    propertyCount: 2,
    configuredPropertyCount: 1,
    totalRoomsSoldToday: 5,
    averageOccupancyPctToday: 50,
    revenueByCurrency: [{ currencyCode: 'NGN', totalRoomRevenue: '500.00' }],
  },
};

/**
 * PLAN.md Phase 6's Multi-Property Roll-Up — the smallest defensible first
 * slice of Multi-Property Management (PRODUCT_REQUIREMENTS.md §3.13).
 */
describe('<ChainOverviewScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    triggerDownloadMock.mockReset();
  });

  it('renders KPI skeletons while loading', () => {
    mocks.getChainOverview.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ChainOverviewScreen />);
    expect(screen.getAllByTestId('kpi-loading').length).toBeGreaterThan(0);
  });

  it('renders real KPIs, the revenue-by-currency line, and the breakdown table on success', async () => {
    mocks.getChainOverview.mockResolvedValue(OVERVIEW);
    render(<ChainOverviewScreen />);

    expect(await screen.findByText('Alpha Hotels')).toBeInTheDocument();
    expect(screen.getByText('Beta Resorts')).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    // "50%" appears twice by design — the KPI card and the breakdown table's
    // own per-property row both show it.
    expect(screen.getAllByText('50%').length).toBe(2);
    // "5" appears twice too — the chain-wide KPI total and Alpha Hotels' own row.
    expect(screen.getAllByText('5').length).toBe(2);
    expect(screen.getAllByText(/₦500\.00/).length).toBe(2);
  });

  it('a property with no business date renders "Not yet configured", not blank or zero', async () => {
    mocks.getChainOverview.mockResolvedValue(OVERVIEW);
    render(<ChainOverviewScreen />);
    await screen.findByText('Beta Resorts');
    expect(screen.getByText('Not yet configured')).toBeInTheDocument();
  });

  it('shows the honest empty state when there are zero active properties', async () => {
    mocks.getChainOverview.mockResolvedValue({
      properties: [],
      totals: { propertyCount: 0, configuredPropertyCount: 0, totalRoomsSoldToday: 0, averageOccupancyPctToday: null, revenueByCurrency: [] },
    });
    render(<ChainOverviewScreen />);
    expect(await screen.findByText(/no active properties in this tenant yet/i)).toBeInTheDocument();
  });

  it('shows the real backend error when the load fails, in the top banner AND the property table (never the generic "no properties" message)', async () => {
    mocks.getChainOverview.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have access to this report.' }));
    render(<ChainOverviewScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access to this report.');
    // The property breakdown table must surface the same real error too —
    // never the generic "No active properties" message, which would be
    // actively misleading on a genuine load failure rather than a real
    // zero-property tenant.
    expect(screen.getAllByText('You do not have access to this report.').length).toBeGreaterThan(1);
    expect(screen.queryByText(/no active properties in this tenant yet/i)).not.toBeInTheDocument();
  });

  it('Refresh re-fetches the overview', async () => {
    mocks.getChainOverview.mockResolvedValue(OVERVIEW);
    render(<ChainOverviewScreen />);
    await screen.findByText('Alpha Hotels');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocks.getChainOverview).toHaveBeenCalledTimes(2);
  });

  it('Export CSV calls the real download when properties are present', async () => {
    mocks.getChainOverview.mockResolvedValue(OVERVIEW);
    const fakeBlob = { type: 'text/csv' };
    mocks.getChainOverviewCsv.mockResolvedValue(fakeBlob);
    render(<ChainOverviewScreen />);
    await screen.findByText('Alpha Hotels');

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mocks.getChainOverviewCsv).toHaveBeenCalled();
    expect(triggerDownloadMock).toHaveBeenCalledWith(fakeBlob, 'chain-overview.csv');
  });

  it('disables Refresh and Export CSV while offline', async () => {
    mocks.getChainOverview.mockResolvedValue(OVERVIEW);
    render(<ChainOverviewScreen isOffline />);
    await screen.findByText('Alpha Hotels');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });
});
