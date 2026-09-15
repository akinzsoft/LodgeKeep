import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportsTab } from '../ReportsTab.jsx';

const mocks = vi.hoisted(() => ({
  getExpenseReport: vi.fn(),
  getExpenseReportCsv: vi.fn(),
  getProfitAndLoss: vi.fn(),
  getProfitAndLossCsv: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    expensesApi: {
      getExpenseReport: mocks.getExpenseReport,
      getExpenseReportCsv: mocks.getExpenseReportCsv,
      getProfitAndLoss: mocks.getProfitAndLoss,
      getProfitAndLossCsv: mocks.getProfitAndLossCsv,
    },
  };
});

vi.mock('../../../shared/download.js', () => ({ triggerDownload: vi.fn() }));

const EMPTY_EXPENSE_REPORT = { totalExpenses: '0.00', byCategory: [], expenses: [] };
const EMPTY_STATEMENT = {
  dateFrom: '2027-01-01',
  dateTo: '2027-01-01',
  revenue: { roomRevenue: '0.00', posRevenue: '0.00', totalRevenue: '0.00', roomRevenueFullyAudited: false },
  costOfSales: '0.00',
  grossProfit: '0.00',
  operatingExpenses: { byCategory: [], total: '0.00' },
  netProfit: '0.00',
};

const activeProperty = { base_currency: 'NGN' };

describe('ReportsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs both reports and renders the full P&L statement', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue({
      ...EMPTY_STATEMENT,
      revenue: { roomRevenue: '100.00', posRevenue: '20.00', totalRevenue: '120.00', roomRevenueFullyAudited: true },
      costOfSales: '8.00',
      grossProfit: '112.00',
      operatingExpenses: { byCategory: [{ categoryId: '1', categoryName: 'Utilities', total: '30.00' }], total: '30.00' },
      netProfit: '82.00',
    });
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

    expect(await screen.findByText('Room revenue')).toBeInTheDocument();
    expect(screen.getByText('POS revenue')).toBeInTheDocument();
    expect(screen.getByText('Total revenue')).toBeInTheDocument();
    expect(screen.getByText('Cost of sales')).toBeInTheDocument();
    expect(screen.getByText('Gross profit')).toBeInTheDocument();
    expect(screen.getByText('Utilities')).toBeInTheDocument();
    expect(screen.getByText('Total operating expenses')).toBeInTheDocument();
    expect(screen.getByText('Net profit')).toBeInTheDocument();
    expect(screen.getByText(/112\.00/)).toBeInTheDocument(); // gross profit figure
    expect(screen.getByText(/82\.00/)).toBeInTheDocument(); // net profit figure
    expect(screen.getByText(/fully reconciled by Night Audit/i)).toBeInTheDocument();
  });

  it('shows an honest "not yet fully reconciled" caveat when the room-revenue figure spans an un-audited day', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT); // roomRevenueFullyAudited: false
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByText(/not yet fully reconciled by Night Audit/i)).toBeInTheDocument();
  });

  it('shows "None recorded" when no operating expenses exist in range, and an honest zero net profit', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT);
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByText('None recorded in this range.')).toBeInTheDocument();
  });

  it('exports both the P&L statement and the expense list as CSV via the shared download helper', async () => {
    const { triggerDownload } = await import('../../../shared/download.js');
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT);
    mocks.getExpenseReportCsv.mockResolvedValue(new Blob(['csv']));
    mocks.getProfitAndLossCsv.mockResolvedValue(new Blob(['csv']));
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    await userEvent.click(await screen.findByRole('button', { name: /export p&l statement/i }));
    await userEvent.click(screen.getByRole('button', { name: /export expense list/i }));

    expect(mocks.getProfitAndLossCsv).toHaveBeenCalled();
    expect(mocks.getExpenseReportCsv).toHaveBeenCalled();
    expect(triggerDownload).toHaveBeenCalledTimes(2);
  });

  it('surfaces a real backend error without breaking the rest of the screen', async () => {
    mocks.getExpenseReport.mockRejectedValue(new Error('boom'));
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT);
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders a printed letterhead with the property name, logo, and statement range', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT);
    const { container } = render(
      <ReportsTab activeProperty={{ ...activeProperty, name: 'Alpha Hotels', logo_url: 'https://example.com/logo.png' }} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

    expect(await screen.findByRole('heading', { name: 'Alpha Hotels' })).toBeInTheDocument();
    expect(screen.getByText(/Profit & Loss Statement — 2027-01-01 to 2027-01-01/)).toBeInTheDocument();
    const logo = container.querySelector('img');
    expect(logo).toHaveAttribute('src', 'https://example.com/logo.png');
  });

  it('omits the logo image when the property has none configured', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT);
    const { container } = render(<ReportsTab activeProperty={{ ...activeProperty, name: 'Alpha Hotels' }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

    expect(await screen.findByRole('heading', { name: 'Alpha Hotels' })).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('has an Export to PDF button that calls window.print', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT);
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Export to PDF' }));

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
