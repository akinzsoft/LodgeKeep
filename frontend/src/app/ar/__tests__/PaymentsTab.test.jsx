import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentsTab } from '../PaymentsTab.jsx';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listCompanyProfiles: vi.fn(),
  listPaymentsForAccount: vi.fn(),
  listInvoicesForAccount: vi.fn(),
  recordPayment: vi.fn(),
  applyPayment: vi.fn(),
  voidPayment: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    arApi: { ...actual.arApi, ...mocks },
    profilesApi: { ...actual.profilesApi, listCompanyProfiles: mocks.listCompanyProfiles },
  };
});

const COMPANY = { id: '50', name: 'Acme Corp' };
const ACCOUNT = { id: '900', company_profile_id: '50', currency: 'NGN' };
const PAYMENT = { id: '2000', received_at: '2027-01-15', method_label: 'wire', reference: 'WIRE-1', amount: '250.00', currency: 'NGN', voided_at: null };
const INVOICE = { id: '1000', invoice_number: 'INV-3-000001', total_amount: '250.00', currency: 'NGN', status: 'issued' };

describe('<PaymentsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listAccounts.mockResolvedValue([ACCOUNT]);
    mocks.listCompanyProfiles.mockResolvedValue([COMPANY]);
    mocks.listPaymentsForAccount.mockResolvedValue([PAYMENT]);
    mocks.listInvoicesForAccount.mockResolvedValue([INVOICE]);
  });

  async function selectAccount() {
    render(<PaymentsTab />);
    await userEvent.selectOptions(await screen.findByLabelText('Account'), '900');
  }

  it('lists real payments for the selected account', async () => {
    await selectAccount();
    expect(await screen.findByText('wire')).toBeInTheDocument();
    expect(screen.getByText('WIRE-1')).toBeInTheDocument();
  });

  it('records a payment with no invoice application (an on-account payment)', async () => {
    mocks.recordPayment.mockResolvedValue(PAYMENT);
    await selectAccount();
    await screen.findByText('wire');

    await userEvent.type(screen.getByLabelText('Amount'), '250.00');
    await userEvent.clear(screen.getByLabelText('Currency'));
    await userEvent.type(screen.getByLabelText('Currency'), 'NGN');
    await userEvent.type(screen.getByLabelText('Method'), 'bank transfer');
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(mocks.recordPayment).toHaveBeenCalledWith(
      '900',
      expect.objectContaining({ amount: '250.00', currency: 'NGN', methodLabel: 'bank transfer' })
    );
  });

  it('records a payment applied to an invoice', async () => {
    mocks.recordPayment.mockResolvedValue(PAYMENT);
    await selectAccount();
    await screen.findByText('wire');

    await userEvent.type(screen.getByLabelText('Amount'), '250.00');
    await userEvent.clear(screen.getByLabelText('Currency'));
    await userEvent.type(screen.getByLabelText('Currency'), 'NGN');
    await userEvent.type(screen.getByLabelText('Method'), 'wire');
    await userEvent.click(screen.getByRole('button', { name: 'Add an invoice application' }));
    const [invoiceSelect] = screen.getAllByRole('combobox').filter((el) => el.closest('form'));
    await userEvent.selectOptions(invoiceSelect, '1000');
    const amountInputs = screen.getAllByPlaceholderText('0.00');
    await userEvent.type(amountInputs[amountInputs.length - 1], '250.00');
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(mocks.recordPayment).toHaveBeenCalledWith(
      '900',
      expect.objectContaining({ applications: expect.arrayContaining([expect.objectContaining({ invoiceId: '1000' })]) })
    );
  });

  it('applies an already-recorded payment to an invoice', async () => {
    mocks.applyPayment.mockResolvedValue(PAYMENT);
    await selectAccount();
    await screen.findByText('wire');

    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const applyCard = screen.getByText(/^Apply payment/).closest('section');
    await userEvent.selectOptions(within(applyCard).getByRole('combobox'), '1000');
    await userEvent.type(within(applyCard).getByRole('textbox'), '250.00');
    await userEvent.click(within(applyCard).getByRole('button', { name: 'Apply' }));

    expect(mocks.applyPayment).toHaveBeenCalledWith('2000', expect.arrayContaining([expect.objectContaining({ invoiceId: '1000', amount: '250.00' })]));
  });

  it('voids a payment only after confirming with a mandatory reason', async () => {
    mocks.voidPayment.mockResolvedValue({ ...PAYMENT, voided_at: '2027-01-16T00:00:00Z' });
    await selectAccount();
    await screen.findByText('wire');

    await userEvent.click(screen.getByRole('button', { name: 'Void' }));
    expect(mocks.voidPayment).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Recorded in error');
    await userEvent.click(screen.getByRole('button', { name: 'Void this payment' }));

    expect(mocks.voidPayment).toHaveBeenCalledWith('2000', 'Recorded in error');
  });

  it('does not offer Apply/Void on an already-voided payment', async () => {
    mocks.listPaymentsForAccount.mockResolvedValue([{ ...PAYMENT, voided_at: '2027-01-16T00:00:00Z' }]);
    await selectAccount();
    await screen.findByText('wire');
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });
});
