import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CashieringScreen } from '../CashieringScreen.jsx';

const mocks = vi.hoisted(() => ({
  listFoliosForReservation: vi.fn(),
  getFolio: vi.fn(),
  postCharge: vi.fn(),
  postAdjustment: vi.fn(),
  voidLineItem: vi.fn(),
  moveLineItem: vi.fn(),
  captureCashPayment: vi.fn(),
  capturePaystackPayment: vi.fn(),
  refundPayment: vi.fn(),
  openAdditionalFolio: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, cashieringApi: mocks };
});

const FOLIO = { id: '1', folio_number: 'F1', billed_to: 'Guest', status: 'open', balance: '100.00', currency: 'NGN' };
const LINE_ITEM = { id: '10', folio_id: '1', type: 'room_charge', description: 'Room 101', amount: '100.00', business_date: '2027-01-01', voided_at: null };

describe('<CashieringScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getFolio.mockResolvedValue({ ...FOLIO, lineItems: [LINE_ITEM], payments: [] });
  });

  async function loadReservation() {
    render(<CashieringScreen />);
    await userEvent.type(screen.getByPlaceholderText('e.g. 42'), '7');
    await userEvent.click(screen.getByRole('button', { name: 'Load folios' }));
  }

  it('shows an empty state when a reservation has no folios yet', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([]);
    await loadReservation();
    expect(await screen.findByText(/check in the guest first/i)).toBeInTheDocument();
  });

  it('loads and renders a folio with its line items and balance', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    await loadReservation();
    expect(await screen.findByText(/Folio F1 — Guest/)).toBeInTheDocument();
    expect(await screen.findByText('Room 101')).toBeInTheDocument();
  });

  it('shows an error message when the lookup fails', async () => {
    mocks.listFoliosForReservation.mockRejectedValue(new Error('Not found'));
    await loadReservation();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('voids a line item after confirming with a reason', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    mocks.voidLineItem.mockResolvedValue({});
    await loadReservation();
    await screen.findByText('Room 101');

    await userEvent.click(screen.getByRole('button', { name: 'Void' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'Posted in error');
    await userEvent.click(screen.getByRole('button', { name: 'Void this line' }));

    expect(mocks.voidLineItem).toHaveBeenCalledWith('10', 'Posted in error');
  });

  it('captures a cash payment', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    mocks.captureCashPayment.mockResolvedValue({ id: '99', status: 'CAPTURED' });
    await loadReservation();
    await screen.findByText('Room 101');

    await userEvent.click(screen.getByRole('button', { name: 'Capture a payment' }));
    await userEvent.type(screen.getByPlaceholderText('0.00'), '100.00');
    await userEvent.click(screen.getByRole('button', { name: 'Capture payment' }));

    expect(mocks.captureCashPayment).toHaveBeenCalledWith('1', { amount: '100.00', currency: 'NGN' });
  });

  it('disables mutating actions while offline', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    render(<CashieringScreen isOffline />);
    await userEvent.type(screen.getByPlaceholderText('e.g. 42'), '7');
    await userEvent.click(screen.getByRole('button', { name: 'Load folios' }));
    await screen.findByText('Room 101');
    expect(screen.getByText(/cashiering actions are disabled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Void' })).toBeDisabled();
  });
});
