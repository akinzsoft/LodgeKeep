import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportingScreen } from '../ReportingScreen.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  listProperties: vi.fn(),
  getOccupancyReport: vi.fn(),
  getRevenueReport: vi.fn(),
  getHousekeepingSummary: vi.fn(),
  getOversoldRoomTypes: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { listProperties: mocks.listProperties },
    reportingApi: {
      getOccupancyReport: mocks.getOccupancyReport,
      getRevenueReport: mocks.getRevenueReport,
      getHousekeepingSummary: mocks.getHousekeepingSummary,
      getOversoldRoomTypes: mocks.getOversoldRoomTypes,
    },
  };
});

const PROPERTY = { id: '1', name: 'Alpha Hotels', base_currency: 'NGN' };

describe('<ReportingScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listProperties.mockResolvedValue([PROPERTY]);
  });

  it('renders all three tabs and defaults to Occupancy', async () => {
    render(<ReportingScreen activePropertyId="1" />);
    expect(await screen.findByRole('tab', { name: 'Occupancy' })).toHaveAttribute('aria-selected', 'true');
    ['Revenue', 'Housekeeping'].forEach((label) => {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    });
  });

  it('runs the occupancy report and shows the resulting rows', async () => {
    mocks.getOccupancyReport.mockResolvedValue([{ date: '2027-01-01', physicalCount: 5, roomsSold: 2, occupancyPct: 40 }]);
    render(<ReportingScreen activePropertyId="1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByText('40%')).toBeInTheDocument();
  });

  it('shows a real 403 error banner on the revenue tab, not a silent failure', async () => {
    mocks.getRevenueReport.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have this permission.' }));
    render(<ReportingScreen activePropertyId="1" />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Revenue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByText('You do not have this permission.')).toBeInTheDocument();
  });

  it('runs the housekeeping summary report', async () => {
    mocks.getHousekeepingSummary.mockResolvedValue({ openDiscrepancies: 2, resolvedDiscrepancies: 1, assignments: { assigned: 1, in_progress: 0, completed: 3 } });
    mocks.getOversoldRoomTypes.mockResolvedValue([]);
    render(<ReportingScreen activePropertyId="1" />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Housekeeping' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByText('2 open discrepancies')).toBeInTheDocument();
  });
});
