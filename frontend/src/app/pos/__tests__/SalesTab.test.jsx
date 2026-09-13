import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SalesTab } from '../SalesTab.jsx';
import { ApiError } from '../../../shared/api/index.js';
import { selectWhenLoaded } from './selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  getSalesReport: vi.fn(),
  getSalesReportCsv: vi.fn(),
  refundPayment: vi.fn(),
  triggerDownload: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets, getSalesReport: mocks.getSalesReport, getSalesReportCsv: mocks.getSalesReportCsv },
    cashieringApi: { refundPayment: mocks.refundPayment },
  };
});

vi.mock('../../../shared/download.js', () => ({ triggerDownload: mocks.triggerDownload }));

const PROPERTY = { base_currency: 'NGN', current_business_date: '2027-03-01' };

const REPORT = {
  dateFrom: '2027-03-01',
  dateTo: '2027-03-01',
  outletId: null,
  currency: 'NGN',
  summary: { tabs: 2, checks: 2, subtotal: '60.00', tax: '4.50', serviceCharge: '4.50', tips: '0.00', total: '69.00' },
  byTender: [
    { tender: 'cash', checks: 1, total: '46.00' },
    { tender: 'card', checks: 0, total: '0.00' },
    { tender: 'nqr', checks: 1, total: '23.00' },
    { tender: 'room_charge', checks: 0, total: '0.00' },
  ],
  topItems: [
    { menuItemId: '1', name: 'Beer', quantity: 3, sales: '60.00' },
  ],
  tabs: [
    { orderId: '9', tableLabel: 'Table 1', source: 'staff', businessDate: '2027-03-01', settledAt: '2027-03-01T20:15:00Z', cashier: 'Ada Bello', tenders: ['cash'], payments: [{ tender: 'cash', channel: null, roomNumber: null, guestName: null, total: '46.00' }], itemCount: 2, total: '46.00' },
    { orderId: '10', tableLabel: '', source: 'guest', businessDate: '2027-03-01', settledAt: '2027-03-01T21:00:00Z', cashier: null, tenders: ['nqr'], payments: [{ tender: 'nqr', channel: 'qr', roomNumber: null, guestName: null, total: '23.00' }], itemCount: 1, total: '23.00' },
    { orderId: '11', tableLabel: 'Table 4', source: 'staff', businessDate: '2027-03-01', settledAt: '2027-03-01T21:30:00Z', cashier: 'Ada Bello', tenders: ['room_charge', 'card'], payments: [
      { tender: 'room_charge', channel: null, roomNumber: '205', guestName: 'Sam Okoro', total: '10.00' },
      { tender: 'card', channel: 'ussd', roomNumber: null, guestName: null, total: '13.00' },
    ], itemCount: 2, total: '23.00' },
  ],
  unsettledCardPayments: [],
};

describe('<SalesTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([{ id: '1', name: 'Main Bar' }]);
    mocks.getSalesReport.mockResolvedValue(REPORT);
  });

  it('defaults the range to the business date, not the wall clock, and keeps the filters reachable before any run', async () => {
    render(<SalesTab activeProperty={PROPERTY} />);
    expect(await screen.findByLabelText('Outlet')).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveValue('2027-03-01');
    expect(screen.getByLabelText('To')).toHaveValue('2027-03-01');
    expect(screen.getAllByText('Choose a date range and run the report.')).toHaveLength(3);
    expect(mocks.getSalesReport).not.toHaveBeenCalled();
  });

  it('runs the report for the chosen outlet and shows totals by tender, top sellers, and settled tabs', async () => {
    render(<SalesTab activeProperty={PROPERTY} />);
    await selectWhenLoaded('Outlet', 'Main Bar');
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));

    expect(await screen.findByRole('region', { name: 'Sales summary' })).toHaveTextContent(/69\.00/);
    expect(mocks.getSalesReport).toHaveBeenCalledWith({ dateFrom: '2027-03-01', dateTo: '2027-03-01', outletId: '1' });

    const tenderRows = screen.getAllByText('NQR').map((cell) => cell.closest('tr'));
    expect(tenderRows[0]).toHaveTextContent(/23\.00/);
    expect(tenderRows[0]).toHaveTextContent('1');
    expect(screen.getByText('Beer').closest('tr')).toHaveTextContent('3');
    expect(screen.getByText('Table 1').closest('tr')).toHaveTextContent('Ada Bello');
    // A room charge names the room and guest; a Card check paid another way names the channel.
    expect(screen.getByText('Table 4').closest('tr')).toHaveTextContent('Charge to room · Room 205 (Sam Okoro) + Card · USSD');
    // A guest QR order has no cashier and no table label.
    expect(screen.getByText('Tab #10').closest('tr')).toHaveTextContent('Guest order');
  });

  it('says there were no sales rather than a blank table when the range is empty', async () => {
    mocks.getSalesReport.mockResolvedValue({ ...REPORT, summary: { ...REPORT.summary, tabs: 0, total: '0.00' }, topItems: [], tabs: [] });
    render(<SalesTab activeProperty={PROPERTY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));

    expect(await screen.findAllByText('No sales in this range.')).toHaveLength(2);
  });

  it('shows the real error when the report is refused', async () => {
    mocks.getSalesReport.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission to do this.' }));
    render(<SalesTab activeProperty={PROPERTY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do this.');
  });

  it('exports a section as CSV with the same filters', async () => {
    const blob = new Blob(['x']);
    mocks.getSalesReportCsv.mockResolvedValue(blob);
    render(<SalesTab activeProperty={PROPERTY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));

    await screen.findByText('Top-selling items');
    // One Export button per table, in order: tenders, items, tabs.
    await userEvent.click(screen.getAllByRole('button', { name: 'Export CSV' })[1]);

    expect(mocks.getSalesReportCsv).toHaveBeenCalledWith({ dateFrom: '2027-03-01', dateTo: '2027-03-01', outletId: undefined }, 'items');
    expect(mocks.triggerDownload).toHaveBeenCalledWith(blob, 'pos-sales-items-2027-03-01-to-2027-03-01.csv');
  });

  it('exports the report that is on screen even after the filters are changed without rerunning', async () => {
    mocks.getSalesReportCsv.mockResolvedValue(new Blob(['x']));
    render(<SalesTab activeProperty={PROPERTY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByText('Settled tabs');

    await selectWhenLoaded('Outlet', 'Main Bar');
    await userEvent.clear(screen.getByLabelText('From'));
    await userEvent.type(screen.getByLabelText('From'), '2027-02-01');
    await userEvent.click(screen.getAllByRole('button', { name: 'Export CSV' })[0]);

    expect(mocks.getSalesReportCsv).toHaveBeenCalledWith({ dateFrom: '2027-03-01', dateTo: '2027-03-01', outletId: undefined }, 'tenders');
  });

  it('exports the settled tabs section by its own button', async () => {
    mocks.getSalesReportCsv.mockResolvedValue(new Blob(['x']));
    render(<SalesTab activeProperty={PROPERTY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByText('Settled tabs');

    const buttons = screen.getAllByRole('button', { name: 'Export CSV' });
    expect(buttons).toHaveLength(3);
    await userEvent.click(buttons[2]);
    expect(mocks.getSalesReportCsv).toHaveBeenCalledWith(expect.any(Object), 'tabs');
  });

  describe('card payments to refund', () => {
    const STRAY = { paymentId: '70', orderId: '12', tableLabel: 'Table 5', orderStatus: 'void', tender: 'card', amount: '23.00', currency: 'NGN', capturedAt: '2027-03-01T22:00:00Z' };

    it('is hidden when there is nothing to refund', async () => {
      render(<SalesTab activeProperty={PROPERTY} />);
      await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
      await screen.findByText('Settled tabs');
      expect(screen.queryByText('Card payments to refund')).not.toBeInTheDocument();
    });

    it('refunds a stray payment with a required reason, then reruns the report', async () => {
      mocks.getSalesReport.mockResolvedValueOnce({ ...REPORT, unsettledCardPayments: [STRAY] }).mockResolvedValueOnce(REPORT);
      mocks.refundPayment.mockResolvedValue({});
      render(<SalesTab activeProperty={PROPERTY} />);
      await userEvent.click(screen.getByRole('button', { name: 'Run report' }));

      const row = (await screen.findByText('Table 5')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Refund' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByRole('button', { name: 'Refund' })).toBeDisabled();
      await userEvent.type(within(dialog).getByLabelText('Reason'), 'Paid after the tab was removed');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Refund' }));

      expect(mocks.refundPayment).toHaveBeenCalledWith('70', { reason: 'Paid after the tab was removed' });
      expect(await screen.findByText('Refund sent to Paystack.')).toBeInTheDocument();
      expect(mocks.getSalesReport).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('Card payments to refund')).not.toBeInTheDocument();
    });

    it('disables refunds while offline', async () => {
      mocks.getSalesReport.mockResolvedValue({ ...REPORT, unsettledCardPayments: [STRAY] });
      render(<SalesTab activeProperty={PROPERTY} isOffline />);
      await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
      expect(within((await screen.findByText('Table 5')).closest('tr')).getByRole('button', { name: 'Refund' })).toBeDisabled();
    });
  });
});
