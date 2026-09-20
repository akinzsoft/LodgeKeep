import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentReconciliationTab } from '../PaymentReconciliationTab.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  getPaymentReconciliation: vi.fn(),
  getPaymentReconciliationCsv: vi.fn(),
  triggerDownload: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    reconciliationApi: { getPaymentReconciliation: mocks.getPaymentReconciliation, getPaymentReconciliationCsv: mocks.getPaymentReconciliationCsv },
  };
});

vi.mock('../../../shared/download.js', () => ({ triggerDownload: mocks.triggerDownload }));

const REPORT = {
  dateFrom: '2027-06-01',
  dateTo: '2027-06-01',
  currency: 'NGN',
  summary: [{ currency: 'NGN', count: 2, grossTotal: '155.20', feeTotal: '3.88', netTotal: '151.32' }],
  bySource: [
    { currency: 'NGN', source: { kind: 'room_folio', label: 'Room folio', channel: null }, count: 1, grossTotal: '100.00', netTotal: '97.50' },
    { currency: 'NGN', source: { kind: 'pos', label: 'Reconciliation Bar', channel: 'guest' }, count: 1, grossTotal: '55.20', netTotal: '53.82' },
  ],
  byMethod: [{ currency: 'NGN', method: 'card', count: 2, grossTotal: '155.20' }],
  lines: [
    {
      paymentId: '1',
      businessDate: '2027-06-01',
      capturedAt: '2027-06-01T10:00:00Z',
      grossAmount: '100.00',
      feeAmount: '2.50',
      netAmount: '97.50',
      currency: 'NGN',
      method: 'card',
      providerChannel: 'card',
      providerReference: 'ref-abc',
      providerPaymentId: 'ps_1',
      source: { kind: 'room_folio', label: 'Room folio', channel: null },
      guestName: 'Jordan Fixture',
      roomNumber: null,
      isRefund: false,
      parentPaymentId: null,
    },
    {
      paymentId: '2',
      businessDate: '2027-06-01',
      capturedAt: '2027-06-01T11:00:00Z',
      grossAmount: '55.20',
      feeAmount: '1.38',
      netAmount: '53.82',
      currency: 'NGN',
      method: 'card',
      providerChannel: 'qr',
      providerReference: 'ref-def',
      providerPaymentId: 'ps_2',
      source: { kind: 'pos', label: 'Reconciliation Bar', channel: 'guest' },
      guestName: null,
      roomNumber: null,
      isRefund: false,
      parentPaymentId: null,
    },
  ],
};

describe('<PaymentReconciliationTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPaymentReconciliation.mockResolvedValue(REPORT);
  });

  it('defaults the range to today and keeps the filters reachable before any run', async () => {
    render(<PaymentReconciliationTab />);
    const today = new Date().toISOString().slice(0, 10);
    expect(screen.getByLabelText('From')).toHaveValue(today);
    expect(screen.getByLabelText('To')).toHaveValue(today);
    expect(screen.getAllByText('Choose a date range and run the report.')).toHaveLength(3);
    expect(mocks.getPaymentReconciliation).not.toHaveBeenCalled();
  });

  it('runs the report and shows gross/fee/net totals, the source and method breakdowns, and every line', async () => {
    render(<PaymentReconciliationTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));

    expect(mocks.getPaymentReconciliation).toHaveBeenCalledWith({ dateFrom: expect.any(String), dateTo: expect.any(String) });
    expect(await screen.findByText(/2 payments/)).toBeInTheDocument();

    // Source breakdown: a folio line reads "Room folio"; a guest-QR POS
    // line's outlet name gets a "· QR" badge, not a competing "QR" outlet.
    // "Room folio" appears once in the by-source breakdown and once in the
    // full ledger below it — both real, not a duplicate render.
    expect(screen.getAllByText('Room folio')).toHaveLength(2);
    expect(screen.getAllByText('Reconciliation Bar · QR')).toHaveLength(2);

    // The full ledger carries the reference/provider-id/channel columns.
    expect(screen.getByText('ref-abc')).toBeInTheDocument();
    expect(screen.getByText('ps_1')).toBeInTheDocument();
    expect(screen.getByText('Jordan Fixture')).toBeInTheDocument();
  });

  it('surfaces a real backend error rather than a silent empty table', async () => {
    mocks.getPaymentReconciliation.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'Not authorized' }));
    render(<PaymentReconciliationTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not authorized');
  });

  it('disables export until a report with rows has actually run, then downloads the CSV with the same filters', async () => {
    render(<PaymentReconciliationTab />);
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();

    mocks.getPaymentReconciliationCsv.mockResolvedValue(new Blob(['csv']));
    await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByText('ref-abc');

    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mocks.getPaymentReconciliationCsv).toHaveBeenCalledWith({ dateFrom: expect.any(String), dateTo: expect.any(String) });
    expect(mocks.triggerDownload).toHaveBeenCalled();
  });
});
