import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BusinessSummaryTab } from '../BusinessSummaryTab.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({ getBusinessSummary: vi.fn(), getBusinessSummaryCsv: vi.fn(), triggerDownload: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, reportingApi: { getBusinessSummary: mocks.getBusinessSummary, getBusinessSummaryCsv: mocks.getBusinessSummaryCsv } };
});
vi.mock('../../../shared/download.js', () => ({ triggerDownload: mocks.triggerDownload }));

const METHODS = (o = {}) => ({ cash: '0.00', card: '0.00', transfer: '0.00', nqr: '0.00', terminal: '0.00', other: '0.00', ...o });

const SUMMARY = {
  dateFrom: '2027-07-01',
  dateTo: '2027-07-01',
  basis: 'gross_collected',
  basisNote: 'Gross money collected (tax, service charge and tips included).',
  currency: 'NGN',
  currencies: [
    {
      currency: 'NGN',
      rows: [
        { key: 'rooms', kind: 'rooms', label: 'Rooms', byMethod: METHODS({ cash: '70.00' }), grossCollected: '70.00', breakdown: null, chargedToRooms: null },
        {
          key: 'outlet:1',
          kind: 'outlet',
          label: 'Summary Bar',
          byMethod: METHODS({ cash: '90.00', nqr: '46.00' }),
          grossCollected: '136.00',
          breakdown: { net: '120.00', tax: '9.00', service: '7.00', tips: '0.00', other: '0.00' },
          chargedToRooms: '43.00',
        },
        { key: 'outlet:2', kind: 'supermarket', label: 'Summary Mart', byMethod: METHODS({ cash: '50.00' }), grossCollected: '50.00', breakdown: { net: '50.00', tax: '0.00', service: '0.00', tips: '0.00', other: '0.00' }, chargedToRooms: '0.00' },
      ],
      total: { count: 5, byMethod: METHODS({ cash: '210.00', nqr: '46.00' }), grossCollected: '256.00' },
      reconciliation: { grossTotal: '256.00', matches: true },
    },
  ],
  roomChargesBilled: { currency: 'NGN', basis: 'billed_before_tax', amount: '300.00', estimate: true, unauditedDates: ['2027-07-01'] },
};

const PROPERTY = { id: '1', base_currency: 'NGN', current_business_date: '2027-07-01' };

describe('<BusinessSummaryTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getBusinessSummary.mockResolvedValue(SUMMARY);
  });

  it('runs for the business date by default (not the wall clock) and states the basis', async () => {
    render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    expect(await screen.findByText(/Basis: gross collected/)).toBeInTheDocument();
    expect(mocks.getBusinessSummary).toHaveBeenCalledWith({ dateFrom: '2027-07-01', dateTo: '2027-07-01' });
  });

  it('lists rooms, each outlet, the mini-mart and a grand total, with NQR apart from card', async () => {
    render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    const table = await screen.findByRole('table', { name: /Collected by source/ }).catch(() => null);
    const scope = table ?? (await screen.findByText(/Collected by source/)).closest('div');
    ['Rooms', 'Summary Bar', 'Summary Mart', 'Grand total'].forEach((label) => expect(within(scope).getAllByText(label).length).toBeGreaterThan(0));
    ['Cash', 'Card', 'Transfer', 'NQR', 'Terminal'].forEach((label) => expect(within(scope).getAllByText(label).length).toBeGreaterThan(0));
    expect(within(scope).getAllByText(/256\.00/).length).toBeGreaterThan(0);
  });

  it('says the total ties to Payment Reconciliation, and warns loudly if it ever does not', async () => {
    const { unmount } = render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    expect(await screen.findByText(/Ties to Payment Reconciliation/)).toBeInTheDocument();
    unmount();
    mocks.getBusinessSummary.mockResolvedValue({ ...SUMMARY, currencies: [{ ...SUMMARY.currencies[0], reconciliation: { grossTotal: '255.00', matches: false } }] });
    render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    expect(await screen.findByText(/Does not tie to Payment Reconciliation/)).toBeInTheDocument();
    expect(screen.getByText(/Do not rely on this total/)).toBeInTheDocument();
  });

  it('shows the outlet breakdown and the charged-to-rooms memo, but no tax split for rooms', async () => {
    render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    expect(await screen.findByText(/Charged to rooms \(memo\)/)).toBeInTheDocument();
    expect(screen.getByText(/Sales before tax/)).toBeInTheDocument();
    const detail = screen.getAllByRole('table')[1];
    expect(within(detail).queryByText('Rooms')).not.toBeInTheDocument();
    expect(within(detail).getByText('Summary Bar')).toBeInTheDocument();
  });

  it('flags room charges billed as an ESTIMATE naming the unclosed dates, and says it is not in the totals', async () => {
    render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    expect(await screen.findByText('Estimate')).toBeInTheDocument();
    expect(screen.getByText(/not yet closed by Night Audit \(2027-07-01\)/)).toBeInTheDocument();
    expect(screen.getByText(/not part of the collected totals/)).toBeInTheDocument();
  });

  it('shows a closed day as final, with no estimate flag', async () => {
    mocks.getBusinessSummary.mockResolvedValue({ ...SUMMARY, roomChargesBilled: { ...SUMMARY.roomChargesBilled, estimate: false, unauditedDates: [] } });
    render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    expect(await screen.findByText('Night Audit closed')).toBeInTheDocument();
    expect(screen.queryByText('Estimate')).not.toBeInTheDocument();
  });

  it('renders one block per currency, never merged', async () => {
    mocks.getBusinessSummary.mockResolvedValue({ ...SUMMARY, currencies: [SUMMARY.currencies[0], { ...SUMMARY.currencies[0], currency: 'USD' }] });
    render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    expect(await screen.findByRole('region', { name: 'Business summary in NGN' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Business summary in USD' })).toBeInTheDocument();
  });

  it('runs a chosen date range and exports the same range as CSV', async () => {
    mocks.getBusinessSummaryCsv.mockResolvedValue(new Blob(['x']));
    render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    await screen.findByText(/Basis: gross collected/);
    await userEvent.clear(screen.getByLabelText('From'));
    await userEvent.type(screen.getByLabelText('From'), '2027-06-28');
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(mocks.getBusinessSummary).toHaveBeenLastCalledWith({ dateFrom: '2027-06-28', dateTo: '2027-07-01' });
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mocks.getBusinessSummaryCsv).toHaveBeenCalledWith({ dateFrom: '2027-06-28', dateTo: '2027-07-01' });
    expect(mocks.triggerDownload).toHaveBeenCalledWith(expect.any(Blob), 'business-summary-2027-06-28-to-2027-07-01.csv');
  });

  it('surfaces a server refusal instead of a blank screen', async () => {
    mocks.getBusinessSummary.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission.' }));
    render(<BusinessSummaryTab activeProperty={PROPERTY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission.');
  });
});
