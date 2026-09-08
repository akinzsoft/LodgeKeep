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
  verifyPayment: vi.fn(),
  listOutstandingBalances: vi.fn(),
  getOutstandingBalancesCsv: vi.fn(),
  openPaystackPopup: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, cashieringApi: mocks };
});

vi.mock('../../../shared/paystack.js', () => ({
  openPaystackPopup: mocks.openPaystackPopup,
}));

const FOLIO = { id: '1', folio_number: 'F1', billed_to: 'Guest', status: 'open', balance: '100.00', currency: 'NGN' };
const LINE_ITEM = { id: '10', folio_id: '1', type: 'room_charge', description: 'Room 101', amount: '100.00', business_date: '2027-01-01', voided_at: null };

describe('<CashieringScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getFolio.mockResolvedValue({ ...FOLIO, lineItems: [LINE_ITEM], payments: [] });
    mocks.listOutstandingBalances.mockResolvedValue([]);
  });

  // The screen now defaults to the Balances tab (PRODUCT_REQUIREMENTS.md's
  // own "Open folios list" landing screen for Cashier) — every existing
  // lookup-form test switches to "Folio Lookup" first.
  async function loadReservation() {
    render(<CashieringScreen />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Folio Lookup' }));
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

  /**
   * Gap closure (user-reported): a real Paystack payment that succeeded on
   * Paystack's own side stayed PENDING in the app — the webhook that would
   * normally reconcile it can't reach a local dev backend, and nothing in
   * the UI ever called the backend's already-real verify endpoint. "Verify"
   * shows only for a still-pending gateway payment, never cash or an
   * already-settled one.
   */
  it('shows a Verify action for a pending Paystack payment, and calls the real verify endpoint', async () => {
    const PENDING_PAYSTACK_PAYMENT = { id: '5', provider: 'paystack', status: 'PENDING', amount: '100.00', currency: 'NGN' };
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    mocks.getFolio.mockResolvedValue({ ...FOLIO, lineItems: [LINE_ITEM], payments: [PENDING_PAYSTACK_PAYMENT] });
    mocks.verifyPayment.mockResolvedValue({ id: '5', status: 'CAPTURED' });

    await loadReservation();
    await screen.findByText('Room 101');

    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(mocks.verifyPayment).toHaveBeenCalledWith('5');
  });

  it('does not show a Verify action for a cash payment or an already-captured payment', async () => {
    const CASH_PAYMENT = { id: '6', provider: 'cash', status: 'CAPTURED', amount: '50.00', currency: 'NGN' };
    const CAPTURED_PAYSTACK_PAYMENT = { id: '7', provider: 'paystack', status: 'CAPTURED', amount: '50.00', currency: 'NGN' };
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    mocks.getFolio.mockResolvedValue({ ...FOLIO, lineItems: [LINE_ITEM], payments: [CASH_PAYMENT, CAPTURED_PAYSTACK_PAYMENT] });

    await loadReservation();
    await screen.findByText('Room 101');

    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "the payment i noticed it rendered a url
   * paystack to make payment cant it be done same page." The backend now
   * also returns `accessCode` — this proves the screen offers a same-page
   * popup for it alongside the existing link, and that closing the popup
   * re-verifies through the real backend and refreshes the folio (the
   * popup's own close/success event is never trusted by itself).
   */
  it('offers an embedded "Pay now" popup for a Paystack checkout, and re-verifies + reloads on close', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    mocks.capturePaystackPayment.mockResolvedValue({
      id: '31',
      authorizationUrl: 'https://paystack.test/pay/abc',
      accessCode: 'access-abc',
    });
    mocks.verifyPayment.mockResolvedValue({ id: '31', status: 'CAPTURED' });
    mocks.openPaystackPopup.mockImplementation(async ({ onClose }) => {
      await onClose();
    });
    await loadReservation();
    await screen.findByText('Room 101');

    await userEvent.click(screen.getByRole('button', { name: 'Capture a payment' }));
    await userEvent.selectOptions(screen.getByLabelText('Method'), 'paystack');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '100.00');
    await userEvent.type(screen.getByLabelText('Guest email'), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Capture payment' }));

    await screen.findByRole('link', { name: 'https://paystack.test/pay/abc' });
    await userEvent.click(screen.getByRole('button', { name: 'Pay now (same page)' }));

    expect(mocks.openPaystackPopup).toHaveBeenCalledWith(
      expect.objectContaining({ accessCode: 'access-abc', onClose: expect.any(Function) })
    );
    expect(mocks.verifyPayment).toHaveBeenCalledWith('31');
    expect(mocks.getFolio).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Pay now (same page)' })).not.toBeInTheDocument();
  });

  it('disables mutating actions while offline', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    render(<CashieringScreen isOffline />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Folio Lookup' }));
    await userEvent.type(screen.getByPlaceholderText('e.g. 42'), '7');
    await userEvent.click(screen.getByRole('button', { name: 'Load folios' }));
    await screen.findByText('Room 101');
    expect(screen.getByText(/cashiering actions are disabled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Void' })).toBeDisabled();
  });

  /**
   * Gap closure (user-reported): "Cashiering menu shld be able to see all
   * outstanding balance of guest and there room no."
   */
  describe('Balances tab (default)', () => {
    it('defaults to the Balances tab, not the lookup form', async () => {
      render(<CashieringScreen />);
      expect(await screen.findByRole('tab', { name: 'Balances' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByPlaceholderText('e.g. 42')).not.toBeInTheDocument();
    });

    it('renders real outstanding balances with room number and guest name', async () => {
      mocks.listOutstandingBalances.mockResolvedValue([
        {
          id: '9',
          confirmation_number: 'CONF9',
          guest_first_name: 'Jordan',
          guest_last_name: 'Fixture',
          room_number: '204',
          arrival_date: '2027-01-01',
          departure_date: '2027-01-03',
          folio_balance: '150.00',
          folio_currency: 'NGN',
        },
      ]);
      render(<CashieringScreen />);
      expect(await screen.findByText('Jordan Fixture')).toBeInTheDocument();
      expect(screen.getByText('204')).toBeInTheDocument();
      expect(screen.getByText('CONF9')).toBeInTheDocument();
    });

    it('clicking "View folio" switches to Folio Lookup and loads that reservation', async () => {
      mocks.listOutstandingBalances.mockResolvedValue([
        {
          id: '9',
          confirmation_number: 'CONF9',
          guest_first_name: 'Jordan',
          guest_last_name: 'Fixture',
          room_number: '204',
          arrival_date: '2027-01-01',
          departure_date: '2027-01-03',
          folio_balance: '150.00',
          folio_currency: 'NGN',
        },
      ]);
      mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
      render(<CashieringScreen />);
      await screen.findByText('Jordan Fixture');

      await userEvent.click(screen.getByRole('button', { name: 'View folio' }));

      expect(mocks.listFoliosForReservation).toHaveBeenCalledWith('9');
      expect(await screen.findByRole('tab', { name: 'Folio Lookup' })).toHaveAttribute('aria-selected', 'true');
      expect(await screen.findByText(/Folio F1 — Guest/)).toBeInTheDocument();
    });

    it('shows the empty-state message when every folio is settled', async () => {
      mocks.listOutstandingBalances.mockResolvedValue([]);
      render(<CashieringScreen />);
      expect(await screen.findByText(/every in-house folio is settled/i)).toBeInTheDocument();
    });
  });
});
