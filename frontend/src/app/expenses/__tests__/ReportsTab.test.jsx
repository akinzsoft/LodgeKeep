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
  itemsSoldWithoutCost: 0,
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

  it('names the un-audited days, collapsing consecutive ones into a range', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue({
      ...EMPTY_STATEMENT,
      revenue: { ...EMPTY_STATEMENT.revenue, unauditedDates: ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-12'] },
    });
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByText(/no Night Audit for: 2026-09-06 to 2026-09-08, 2026-09-12/)).toBeInTheDocument();
  });

  it('shows no un-audited day list when every day is reconciled', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue({
      ...EMPTY_STATEMENT,
      revenue: { ...EMPTY_STATEMENT.revenue, roomRevenueFullyAudited: true, unauditedDates: [] },
    });
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByText(/fully reconciled by Night Audit/i)).toBeInTheDocument();
    expect(screen.queryByText(/no Night Audit for/)).not.toBeInTheDocument();
  });

  it('shows the cost-price estimate as its own sub-line only when there is one', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue({ ...EMPTY_STATEMENT, costOfSales: '600.00', costOfSalesFromCostPrice: '600.00' });
    render(<ReportsTab activeProperty={activeProperty} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByText(/of which from item cost price/i)).toBeInTheDocument();
  });

  it('omits the cost-price sub-line when none of cost of sales came from cost price', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue({ ...EMPTY_STATEMENT, costOfSalesFromCostPrice: '0.00' });
    render(<ReportsTab activeProperty={activeProperty} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    await screen.findByText(/Gross profit/i);
    expect(screen.queryByText(/of which from item cost price/i)).not.toBeInTheDocument();
  });

  it('shows the two other-income lines only when folio adjustments exist', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue({
      ...EMPTY_STATEMENT,
      revenue: { ...EMPTY_STATEMENT.revenue, otherIncome: { fees: '500.00', discounts: '-120.00', total: '380.00' }, totalRevenue: '380.00' },
    });
    render(<ReportsTab activeProperty={activeProperty} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByText('Fees and other charges')).toBeInTheDocument();
    expect(screen.getByText('Discounts and corrections (net)')).toBeInTheDocument();
  });

  it('omits the other-income lines when there are no adjustments', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue({
      ...EMPTY_STATEMENT,
      revenue: { ...EMPTY_STATEMENT.revenue, otherIncome: { fees: '0.00', discounts: '0.00', total: '0.00' } },
    });
    render(<ReportsTab activeProperty={activeProperty} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    await screen.findByText(/Gross profit/i);
    expect(screen.queryByText('Fees and other charges')).not.toBeInTheDocument();
  });

  it('warns when folio adjustments in another currency were left out of revenue', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue({ ...EMPTY_STATEMENT, adjustmentsInOtherCurrency: 2 });
    render(<ReportsTab activeProperty={activeProperty} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByText(/2 folio adjustment\(s\) in another currency/)).toBeInTheDocument();
  });

  it('shows "None recorded" when no operating expenses exist in range, and an honest zero net profit', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT);
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByText('None recorded in this range.')).toBeInTheDocument();
  });

  it('warns when menu items sold in range have no cost (no recipe deduction and no cost price), so their cost never reached Cost of sales', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue({ ...EMPTY_STATEMENT, itemsSoldWithoutCost: 2 });
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toMatch(/2 menu item\(s\) sold in this range with no cost \(no recipe deduction and no cost price\)/);
    expect(warning.textContent).toMatch(/Gross profit is overstated/);
  });

  it('shows no such warning when every item sold in range has a tracked cost', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT); // itemsSoldWithoutCost: 0
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    await screen.findByText('Room revenue');
    expect(screen.queryByText(/no cost \(no recipe/i)).not.toBeInTheDocument();
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

    expect(await screen.findByRole('heading', { name: 'Profit & Loss Statement', hidden: true })).not.toBeVisible();
    expect(screen.getByText('Alpha Hotels')).toBeInTheDocument();
    expect(screen.getByText('2027-01-01 to 2027-01-01')).toBeInTheDocument();
    const [logo] = container.querySelectorAll('img');
    expect(logo).toHaveAttribute('src', 'https://example.com/logo.png');
    // The same logo, faint, as the printed page's watermark.
    expect(screen.getByTestId('print-watermark')).toHaveAttribute('src', 'https://example.com/logo.png');
  });

  it('omits the logo image when the property has none configured', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitAndLoss.mockResolvedValue(EMPTY_STATEMENT);
    const { container } = render(<ReportsTab activeProperty={{ ...activeProperty, name: 'Alpha Hotels' }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

    // Print-only: hidden on screen (it used to show there too — its flex
    // rule overrode .printOnly), so query including hidden elements.
    expect(await screen.findByRole('heading', { name: 'Profit & Loss Statement', hidden: true })).not.toBeVisible();
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
