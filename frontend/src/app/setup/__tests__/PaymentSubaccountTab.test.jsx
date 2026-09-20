import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentSubaccountTab } from '../PaymentSubaccountTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  getPaymentSubaccount: vi.fn(),
  resolvePaymentBankAccount: vi.fn(),
  savePaymentSubaccount: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: {
      getPaymentSubaccount: mocks.getPaymentSubaccount,
      resolvePaymentBankAccount: mocks.resolvePaymentBankAccount,
      savePaymentSubaccount: mocks.savePaymentSubaccount,
    },
  };
});

describe('<PaymentSubaccountTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPaymentSubaccount.mockResolvedValue(null);
  });

  it('shows a real message when a property has not been created yet', () => {
    render(<PaymentSubaccountTab disabled />);
    expect(screen.getByText(/create a property first/i)).toBeInTheDocument();
  });

  it('shows nothing configured yet, and only "Check account name" until a resolve succeeds', async () => {
    render(<PaymentSubaccountTab disabled={false} />);
    expect(await screen.findByRole('button', { name: 'Check account name' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save payout account' })).not.toBeInTheDocument();
    expect(screen.queryByText(/currently paying out to/i)).not.toBeInTheDocument();
  });

  it('shows the real currently-configured payout account', async () => {
    mocks.getPaymentSubaccount.mockResolvedValue({
      subaccount_code: 'ACCT_existing',
      bank_code: '057',
      bank_name: 'Zenith Bank',
      account_number_last4: '4321',
      account_name: 'Alpha Hotels Ltd',
      percentage_charge: '0.00',
    });
    render(<PaymentSubaccountTab disabled={false} />);
    expect(await screen.findByText(/Alpha Hotels Ltd/)).toBeInTheDocument();
    expect(screen.getByText(/ending\s*4321/)).toBeInTheDocument();
  });

  it('resolves the bank account, shows the real name, then saves and creates a real subaccount', async () => {
    mocks.resolvePaymentBankAccount.mockResolvedValue({ accountName: 'JANE DOE' });
    mocks.savePaymentSubaccount.mockResolvedValue({
      subaccount_code: 'ACCT_new',
      bank_code: '057',
      bank_name: 'Zenith Bank',
      account_number_last4: '6789',
      account_name: 'JANE DOE',
      percentage_charge: '0.00',
    });

    render(<PaymentSubaccountTab disabled={false} />);
    await screen.findByRole('button', { name: 'Check account name' });

    await userEvent.type(screen.getByPlaceholderText('Zenith Bank'), 'Zenith Bank');
    await userEvent.type(screen.getByPlaceholderText('057'), '057');
    await userEvent.type(screen.getByPlaceholderText('0123456789'), '0123456789');
    await userEvent.click(screen.getByRole('button', { name: 'Check account name' }));

    expect(mocks.resolvePaymentBankAccount).toHaveBeenCalledWith({ bankCode: '057', accountNumber: '0123456789' });
    expect(await screen.findByText(/Resolved to/)).toBeInTheDocument();
    expect(screen.getByText('JANE DOE')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save payout account' }));

    expect(mocks.savePaymentSubaccount).toHaveBeenCalledWith({
      bankCode: '057',
      bankName: 'Zenith Bank',
      accountNumber: '0123456789',
    });
    expect(await screen.findByText('Payout account saved')).toBeInTheDocument();
  });

  it('clears an earlier resolve confirmation when a field changes afterward — never saves a stale confirmation', async () => {
    mocks.resolvePaymentBankAccount.mockResolvedValue({ accountName: 'JANE DOE' });
    render(<PaymentSubaccountTab disabled={false} />);
    await screen.findByRole('button', { name: 'Check account name' });

    await userEvent.type(screen.getByPlaceholderText('Zenith Bank'), 'Zenith Bank');
    await userEvent.type(screen.getByPlaceholderText('057'), '057');
    await userEvent.type(screen.getByPlaceholderText('0123456789'), '0123456789');
    await userEvent.click(screen.getByRole('button', { name: 'Check account name' }));
    await screen.findByText(/Resolved to/);

    // Editing the account number after a successful resolve must drop the
    // confirmation — the Save button must not still be offered.
    await userEvent.type(screen.getByPlaceholderText('0123456789'), '9');
    expect(screen.queryByRole('button', { name: 'Save payout account' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check account name' })).toBeInTheDocument();
  });

  it('surfaces a real resolve failure (e.g. no integration configured for this currency)', async () => {
    mocks.resolvePaymentBankAccount.mockRejectedValue(
      new ApiError({ code: 'PAYMENT_GATEWAY_NOT_CONFIGURED', message: 'The "paystack" payment gateway has no credentials configured for this environment.' })
    );
    render(<PaymentSubaccountTab disabled={false} />);
    await screen.findByRole('button', { name: 'Check account name' });
    await userEvent.type(screen.getByPlaceholderText('Zenith Bank'), 'Zenith Bank');
    await userEvent.type(screen.getByPlaceholderText('057'), '057');
    await userEvent.type(screen.getByPlaceholderText('0123456789'), '0123456789');
    await userEvent.click(screen.getByRole('button', { name: 'Check account name' }));
    expect(await screen.findByText(/no credentials configured/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save payout account' })).not.toBeInTheDocument();
  });

  it('disables the resolve action while offline', async () => {
    render(<PaymentSubaccountTab disabled={false} isOffline />);
    expect(await screen.findByRole('button', { name: 'Check account name' })).toBeDisabled();
    expect(screen.getByText(/you.re offline/i)).toBeInTheDocument();
  });
});
