import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountsTab } from '../AccountsTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  generateInvoice: vi.fn(),
  listCompanyProfiles: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    arApi: { ...actual.arApi, ...mocks },
    profilesApi: { ...actual.profilesApi, listCompanyProfiles: mocks.listCompanyProfiles },
  };
});

// "Acme Corp" appears both as a table cell and as an <option> in the
// create form's Company select — always resolve the row via its cell.
async function findCompanyCell() {
  return (await screen.findAllByText('Acme Corp')).find((el) => el.tagName === 'TD');
}

const COMPANY = { id: '50', name: 'Acme Corp' };
const ACCOUNT = {
  id: '900',
  company_profile_id: '50',
  credit_limit: '500.00',
  current_balance: '100.00',
  currency: 'NGN',
  enforcement_mode: 'block',
  status: 'active',
  is_over_limit: false,
};

describe('<AccountsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listAccounts.mockResolvedValue([ACCOUNT]);
    mocks.listCompanyProfiles.mockResolvedValue([COMPANY]);
  });

  it('lists AR accounts with the company name resolved', async () => {
    render(<AccountsTab />);
    expect(await findCompanyCell()).toBeInTheDocument();
    expect(screen.getByText('Within limit')).toBeInTheDocument();
  });

  it('shows an "Over limit" pill for an over-limit account', async () => {
    mocks.listAccounts.mockResolvedValue([{ ...ACCOUNT, is_over_limit: true }]);
    render(<AccountsTab />);
    expect(await screen.findByText('Over limit')).toBeInTheDocument();
  });

  it('creates an AR account through the real endpoint', async () => {
    mocks.listAccounts.mockResolvedValueOnce([]).mockResolvedValueOnce([ACCOUNT]);
    mocks.createAccount.mockResolvedValue(ACCOUNT);
    render(<AccountsTab />);
    await screen.findByText(/no AR accounts yet/i);

    await userEvent.selectOptions(screen.getByLabelText('Company'), '50');
    await userEvent.type(screen.getByLabelText('Currency'), 'NGN');
    await userEvent.click(screen.getByRole('button', { name: 'Add AR account' }));

    expect(mocks.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ companyProfileId: '50', currency: 'NGN' })
    );
  });

  it('edits an account, pre-filled with its current settings', async () => {
    mocks.updateAccount.mockResolvedValue({ ...ACCOUNT, credit_limit: '1000.00' });
    render(<AccountsTab />);
    await findCompanyCell();

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editCard = screen.getByText('Edit AR account').closest('section');
    expect(within(editCard).getByLabelText('Credit limit')).toHaveValue('500.00');

    await userEvent.clear(within(editCard).getByLabelText('Credit limit'));
    await userEvent.type(within(editCard).getByLabelText('Credit limit'), '1000.00');
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateAccount).toHaveBeenCalledWith('900', expect.objectContaining({ creditLimit: '1000.00' }));
  });

  it('generates an invoice and shows a real confirmation message (TESTING.md AR-1)', async () => {
    mocks.generateInvoice.mockResolvedValue({ invoice_number: 'INV-3-000001', total_amount: '250.00', currency: 'NGN' });
    render(<AccountsTab />);
    await findCompanyCell();

    await userEvent.click(screen.getByRole('button', { name: 'Generate Invoice' }));

    expect(mocks.generateInvoice).toHaveBeenCalledWith('900');
    expect(await screen.findByText(/INV-3-000001/)).toBeInTheDocument();
  });

  it('surfaces a real "no charges to invoice" error', async () => {
    mocks.generateInvoice.mockRejectedValue(
      new ApiError({ code: 'VALIDATION_NO_CHARGES_TO_INVOICE', message: 'This account has no un-invoiced charges to generate an invoice from.' })
    );
    render(<AccountsTab />);
    await findCompanyCell();

    await userEvent.click(screen.getByRole('button', { name: 'Generate Invoice' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no un-invoiced charges');
  });

  it('disables mutating actions while offline', async () => {
    render(<AccountsTab isOffline />);
    await findCompanyCell();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Generate Invoice' })).toBeDisabled();
  });
});
