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
  billFolioToCompany: vi.fn(),
  verifyPayment: vi.fn(),
  listOutstandingBalances: vi.fn(),
  getOutstandingBalancesCsv: vi.fn(),
  openPaystackPopup: vi.fn(),
  listCompanyProfiles: vi.fn(),
  listAccounts: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    cashieringApi: mocks,
    profilesApi: { ...actual.profilesApi, listCompanyProfiles: mocks.listCompanyProfiles },
    arApi: { ...actual.arApi, listAccounts: mocks.listAccounts },
  };
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
    mocks.listCompanyProfiles.mockResolvedValue([{ id: '50', name: 'Acme Corp' }]);
    mocks.listAccounts.mockResolvedValue([]);
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

  it('captures a cash payment for the folio’s real balance, with no amount to type', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    mocks.captureCashPayment.mockResolvedValue({ id: '99', status: 'CAPTURED' });
    await loadReservation();
    await screen.findByText('Room 101');

    await userEvent.click(screen.getByRole('button', { name: 'Capture a payment' }));
    await userEvent.click(screen.getByRole('button', { name: 'Capture payment' }));

    expect(mocks.captureCashPayment).toHaveBeenCalledWith('1', { amount: '100.00', currency: 'NGN' });
  });

  /**
   * Gap closure (user-reported): "the form textfield amt is editable pls
   * correct it."
   */
  it('renders the payment Amount field as read-only, locked to the real balance', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    await loadReservation();
    await screen.findByText('Room 101');

    await userEvent.click(screen.getByRole('button', { name: 'Capture a payment' }));

    const amountInput = screen.getByLabelText('Amount');
    expect(amountInput).toHaveAttribute('readonly');
    expect(amountInput).toHaveValue('100.00');
  });

  /**
   * Gap closure (user-reported): "wen payment is done disable the ...
   * payment buttons." `folio.status` never reflects a zero balance, so the
   * disable is driven purely by the balance the parent's refreshed `folios`
   * list carries.
   */
  it('disables "Capture a payment" and shows a "Paid in full" pill once the folio balance is zero', async () => {
    const SETTLED_FOLIO = { ...FOLIO, balance: '0.00' };
    mocks.listFoliosForReservation.mockResolvedValue([SETTLED_FOLIO]);
    await loadReservation();
    await screen.findByText('Room 101');

    expect(screen.getByRole('button', { name: 'Capture a payment' })).toBeDisabled();
    expect(screen.getByText('Paid in full')).toBeInTheDocument();
  });

  it('treats a negative (credit) balance as settled too — "Credit balance" pill, "Capture a payment" disabled', async () => {
    const CREDIT_FOLIO = { ...FOLIO, balance: '-20.00' };
    mocks.listFoliosForReservation.mockResolvedValue([CREDIT_FOLIO]);
    await loadReservation();
    await screen.findByText('Room 101');

    expect(screen.getByRole('button', { name: 'Capture a payment' })).toBeDisabled();
    expect(screen.getByText('Credit balance')).toBeInTheDocument();
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
    await userEvent.type(screen.getByLabelText('Guest email'), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Capture payment' }));

    await userEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(mocks.openPaystackPopup).toHaveBeenCalledWith(
      expect.objectContaining({ accessCode: 'access-abc', onClose: expect.any(Function) })
    );
    expect(mocks.verifyPayment).toHaveBeenCalledWith('31');
    expect(mocks.getFolio).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Pay now' })).not.toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "make it more profeesional and standard
   * form with the payment button" — the raw checkout URL is never shown as
   * visible link text; the popup button is primary, the link is a small,
   * clearly-labelled fallback.
   */
  it('never shows the raw checkout URL as link text', async () => {
    mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
    mocks.capturePaystackPayment.mockResolvedValue({
      id: '31',
      authorizationUrl: 'https://paystack.test/pay/abc',
      accessCode: 'access-abc',
    });
    await loadReservation();
    await screen.findByText('Room 101');

    await userEvent.click(screen.getByRole('button', { name: 'Capture a payment' }));
    await userEvent.selectOptions(screen.getByLabelText('Method'), 'paystack');
    await userEvent.type(screen.getByLabelText('Guest email'), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Capture payment' }));

    const link = await screen.findByRole('link', { name: 'Open payment page in a new tab' });
    expect(link).toHaveAttribute('href', 'https://paystack.test/pay/abc');
    expect(screen.queryByText('https://paystack.test/pay/abc')).not.toBeInTheDocument();
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

  /**
   * PLAN.md Phase 4 (Accounts Receivable) — gap closure: `billed_to` used
   * to be set via a raw `window.prompt`; there is now a real company
   * picker wired to the backend's bill-to-account endpoint.
   */
  describe('Accounts Receivable — billing a folio to a company', () => {
    it('bills a folio to a company through a real picker, never window.prompt', async () => {
      mocks.listFoliosForReservation.mockResolvedValue([FOLIO]);
      mocks.billFolioToCompany.mockResolvedValue({ ...FOLIO, company_profile_id: '50', billed_to: 'Acme Corp' });
      const promptSpy = vi.spyOn(window, 'prompt');
      await loadReservation();
      await screen.findByText('Room 101');

      await userEvent.click(screen.getByRole('button', { name: 'Bill to company' }));
      await userEvent.selectOptions(screen.getByRole('combobox'), '50');
      await userEvent.click(screen.getByRole('button', { name: 'Bill this folio' }));

      expect(mocks.billFolioToCompany).toHaveBeenCalledWith('1', '50');
      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('shows a settled-through-AR notice and hides Cash/Card capture for a folio billed to a company', async () => {
      const AR_FOLIO = { ...FOLIO, company_profile_id: '50', billed_to: 'Acme Corp' };
      mocks.listFoliosForReservation.mockResolvedValue([AR_FOLIO]);
      mocks.getFolio.mockResolvedValue({ ...AR_FOLIO, lineItems: [LINE_ITEM], payments: [] });
      mocks.listAccounts.mockResolvedValue([
        { id: '900', company_profile_id: '50', credit_limit: '500.00', current_balance: '100.00', currency: 'NGN', is_over_limit: false },
      ]);
      await loadReservation();
      await screen.findByText('Room 101');

      expect(await screen.findByText(/settled through Accounts Receivable/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Capture a payment' })).not.toBeInTheDocument();
    });

    it('shows an "AR account over limit" pill when the billed company is over its credit limit', async () => {
      const AR_FOLIO = { ...FOLIO, company_profile_id: '50', billed_to: 'Acme Corp' };
      mocks.listFoliosForReservation.mockResolvedValue([AR_FOLIO]);
      mocks.getFolio.mockResolvedValue({ ...AR_FOLIO, lineItems: [LINE_ITEM], payments: [] });
      mocks.listAccounts.mockResolvedValue([
        { id: '900', company_profile_id: '50', credit_limit: '50.00', current_balance: '100.00', currency: 'NGN', is_over_limit: true },
      ]);
      await loadReservation();
      await screen.findByText('Room 101');

      expect(await screen.findByText('AR account over limit')).toBeInTheDocument();
    });

    it('un-bills a folio back to the guest', async () => {
      const AR_FOLIO = { ...FOLIO, company_profile_id: '50', billed_to: 'Acme Corp' };
      mocks.listFoliosForReservation.mockResolvedValue([AR_FOLIO]);
      mocks.getFolio.mockResolvedValue({ ...AR_FOLIO, lineItems: [LINE_ITEM], payments: [] });
      mocks.listAccounts.mockResolvedValue([
        { id: '900', company_profile_id: '50', credit_limit: '500.00', current_balance: '0.00', currency: 'NGN', is_over_limit: false },
      ]);
      mocks.billFolioToCompany.mockResolvedValue({ ...FOLIO, company_profile_id: null, billed_to: 'Guest' });
      await loadReservation();
      await screen.findByText('Room 101');

      await userEvent.click(screen.getByRole('button', { name: 'Un-bill (settle with guest instead)' }));

      expect(mocks.billFolioToCompany).toHaveBeenCalledWith('1', null);
    });

    it('offers a credit-limit override checkbox and reason field on the charge form for an AR-billed folio', async () => {
      const AR_FOLIO = { ...FOLIO, company_profile_id: '50', billed_to: 'Acme Corp' };
      mocks.listFoliosForReservation.mockResolvedValue([AR_FOLIO]);
      mocks.getFolio.mockResolvedValue({ ...AR_FOLIO, lineItems: [LINE_ITEM], payments: [] });
      mocks.listAccounts.mockResolvedValue([
        { id: '900', company_profile_id: '50', credit_limit: '50.00', current_balance: '100.00', currency: 'NGN', is_over_limit: true },
      ]);
      mocks.postCharge.mockResolvedValue({ chargeLine: LINE_ITEM, taxLines: [] });
      await loadReservation();
      await screen.findByText('Room 101');

      await userEvent.click(screen.getByRole('button', { name: 'Post a charge' }));
      await userEvent.type(screen.getByLabelText('Description'), 'Extra charge');
      await userEvent.type(screen.getByLabelText('Amount'), '10.00');
      await userEvent.click(screen.getByLabelText('Override credit limit if this would exceed it'));
      await userEvent.type(screen.getByLabelText('Override reason'), 'Manager approved');
      await userEvent.click(screen.getByRole('button', { name: 'Post charge' }));

      expect(mocks.postCharge).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ overrideCreditLimit: true, overrideReason: 'Manager approved' })
      );
    });
  });
});
