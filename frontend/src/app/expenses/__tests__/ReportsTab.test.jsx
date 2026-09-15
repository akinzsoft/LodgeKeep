import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportsTab } from '../ReportsTab.jsx';

const mocks = vi.hoisted(() => ({
  getExpenseReport: vi.fn(),
  getExpenseReportCsv: vi.fn(),
  getProfitSummary: vi.fn(),
  getProfitSummaryCsv: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    expensesApi: {
      getExpenseReport: mocks.getExpenseReport,
      getExpenseReportCsv: mocks.getExpenseReportCsv,
      getProfitSummary: mocks.getProfitSummary,
      getProfitSummaryCsv: mocks.getProfitSummaryCsv,
    },
  };
});

vi.mock('../../../shared/download.js', () => ({ triggerDownload: vi.fn() }));

const EMPTY_EXPENSE_REPORT = { totalExpenses: '0.00', byCategory: [], expenses: [] };
const EMPTY_PROFIT_SUMMARY = { totals: { roomRevenue: '0.00', posRevenue: '0.00', totalRevenue: '0.00', totalExpenses: '0.00', profit: '0.00' }, byDay: [], expensesByCategory: [] };

const activeProperty = { base_currency: 'NGN' };

describe('ReportsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs both reports and renders the totals line including the audited caveat', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitSummary.mockResolvedValue({
      ...EMPTY_PROFIT_SUMMARY,
      totals: { roomRevenue: '100.00', posRevenue: '20.00', totalRevenue: '120.00', totalExpenses: '30.00', profit: '90.00' },
      byDay: [{ date: '2027-01-15', roomRevenue: '100.00', posRevenue: '20.00', totalRevenue: '120.00', totalExpenses: '30.00', profit: '90.00', audited: true }],
    });
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

    // "90.00" (the profit figure) appears twice — once in the totals line, once in the by-day table row.
    expect((await screen.findAllByText(/90\.00/)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/reflects room revenue only/i)).toBeInTheDocument();
    expect(screen.getByText(/Yes \(room revenue\)/)).toBeInTheDocument();
  });

  it('a zero-expense, zero-revenue day shows an honest 0.00 profit, not an error', async () => {
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitSummary.mockResolvedValue({ ...EMPTY_PROFIT_SUMMARY, byDay: [{ date: '2027-01-16', roomRevenue: '0.00', posRevenue: '0.00', totalRevenue: '0.00', totalExpenses: '0.00', profit: '0.00', audited: false }] });
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    await screen.findByText('2027-01-16');
    expect(screen.getAllByText(/0\.00/).length).toBeGreaterThan(0);
  });

  it('exports both reports as CSV via the shared download helper', async () => {
    const { triggerDownload } = await import('../../../shared/download.js');
    mocks.getExpenseReport.mockResolvedValue(EMPTY_EXPENSE_REPORT);
    mocks.getProfitSummary.mockResolvedValue(EMPTY_PROFIT_SUMMARY);
    mocks.getExpenseReportCsv.mockResolvedValue(new Blob(['csv']));
    mocks.getProfitSummaryCsv.mockResolvedValue(new Blob(['csv']));
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    await userEvent.click(await screen.findByRole('button', { name: /export profit summary/i }));
    await userEvent.click(screen.getByRole('button', { name: /export expense list/i }));

    expect(mocks.getProfitSummaryCsv).toHaveBeenCalled();
    expect(mocks.getExpenseReportCsv).toHaveBeenCalled();
    expect(triggerDownload).toHaveBeenCalledTimes(2);
  });

  it('surfaces a real backend error without breaking the rest of the screen', async () => {
    mocks.getExpenseReport.mockRejectedValue(new Error('boom'));
    mocks.getProfitSummary.mockResolvedValue(EMPTY_PROFIT_SUMMARY);
    render(<ReportsTab activeProperty={activeProperty} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
