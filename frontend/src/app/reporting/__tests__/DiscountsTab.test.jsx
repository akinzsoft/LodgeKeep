import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiscountsTab } from '../DiscountsTab.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({ getReport: vi.fn(), getReportCsv: vi.fn(), triggerDownload: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, discountsApi: { getReport: mocks.getReport, getReportCsv: mocks.getReportCsv } };
});
vi.mock('../../../shared/download.js', () => ({ triggerDownload: mocks.triggerDownload }));

const REPORT = {
  dateFrom: '2027-08-01',
  dateTo: '2027-08-01',
  currency: 'NGN',
  summary: { count: 3, total: '60.00', discounts: '40.00', comps: '20.00', compCount: 1, netSales: '440.00', percentOfSales: '12.00' },
  byReason: [
    { key: '1', label: 'Promotion', count: 2, total: '40.00' },
    { key: '2', label: 'Staff meal', count: 1, total: '20.00' },
  ],
  byGiver: [{ key: '5', label: 'Ada Cashier', count: 3, total: '60.00' }],
  byApprover: [{ key: '7', label: 'Grace Manager', count: 1, total: '20.00' }],
  byOutlet: [{ key: '1', label: 'Main Bar', count: 3, total: '60.00' }],
  lines: [
    { id: '1', settlement_id: '10', business_date: '2027-08-01', outlet: 'Main Bar', kind: 'comp', scope: 'order', type: 'percent', value: '100.00', amount: '20.00', currency: 'NGN', reason: 'Staff meal', given_by: 'Ada Cashier', approved_by: 'Grace Manager' },
    { id: '2', settlement_id: '11', business_date: '2027-08-01', outlet: 'Main Bar', kind: 'discount', scope: 'line', type: 'fixed', value: '20.00', amount: '20.00', currency: 'NGN', reason: 'Promotion', given_by: 'Ada Cashier', approved_by: '' },
  ],
};

describe('<DiscountsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('asks nothing until the report is run, then shows the summary, the groupings and every line', async () => {
    mocks.getReport.mockResolvedValue(REPORT);
    render(<DiscountsTab activeProperty={{ base_currency: 'NGN', current_business_date: '2027-08-01' }} />);
    expect(mocks.getReport).not.toHaveBeenCalled();
    expect(screen.getAllByText('Choose a date range and run the report.').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    // The range starts on the property's business date, not the wall-clock day.
    expect(mocks.getReport).toHaveBeenCalledWith({ dateFrom: '2027-08-01', dateTo: '2027-08-01' });

    const summary = await screen.findByText(/3 given/);
    expect(summary.closest('li')).toHaveTextContent(/60\.00/);
    expect(summary.closest('li')).toHaveTextContent(/12\.00%/);
    expect(screen.getByText(/Comps \(1\)/).closest('li')).toHaveTextContent(/20\.00/);

    const byReason = screen.getByRole('heading', { name: 'By reason' }).closest('div');
    expect(within(byReason.parentElement).getAllByText('Promotion').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Grace Manager').length).toBeGreaterThan(0);
    const line = screen.getAllByRole('row').find((row) => row.textContent.includes('Staff meal') && row.textContent.includes('Comp'));
    expect(line).toBeDefined();
    expect(within(line).getByText('Grace Manager')).toBeInTheDocument();
    // A discount nobody had to approve has no approver.
    const plain = screen.getAllByRole('row').find((row) => row.textContent.includes('Promotion') && row.textContent.includes('Discount') && !row.textContent.includes('Grace'));
    expect(plain).toBeDefined();
  });

  it('says so when nothing was given', async () => {
    mocks.getReport.mockResolvedValue({ ...REPORT, summary: { ...REPORT.summary, count: 0, total: '0.00' }, byReason: [], byGiver: [], byApprover: [], byOutlet: [], lines: [] });
    render(<DiscountsTab activeProperty={{ base_currency: 'NGN', current_business_date: '2027-08-01' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByText('No discounts or comps in this range.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });

  it("shows the server's refusal, such as a missing permission", async () => {
    mocks.getReport.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission to do that.', status: 403 }));
    render(<DiscountsTab activeProperty={{ base_currency: 'NGN', current_business_date: '2027-08-01' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do that.');
  });

  it('exports the same range as CSV', async () => {
    mocks.getReport.mockResolvedValue(REPORT);
    mocks.getReportCsv.mockResolvedValue(new Blob(['x']));
    render(<DiscountsTab activeProperty={{ base_currency: 'NGN', current_business_date: '2027-08-01' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByText(/3 given/);
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mocks.getReportCsv).toHaveBeenCalledWith(expect.objectContaining({ dateFrom: expect.any(String), dateTo: expect.any(String) }));
    expect(mocks.triggerDownload).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^discounts-.*\.csv$/));
  });
});
