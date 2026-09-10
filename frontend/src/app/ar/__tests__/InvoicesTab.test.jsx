import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoicesTab } from '../InvoicesTab.jsx';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listCompanyProfiles: vi.fn(),
  listInvoicesForAccount: vi.fn(),
  getInvoice: vi.fn(),
  voidInvoice: vi.fn(),
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
const ACCOUNT = { id: '900', company_profile_id: '50' };
const INVOICE = { id: '1000', invoice_number: 'INV-3-000001', issued_at: '2027-01-01', due_at: '2027-01-31', total_amount: '250.00', currency: 'NGN', status: 'issued' };

describe('<InvoicesTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listAccounts.mockResolvedValue([ACCOUNT]);
    mocks.listCompanyProfiles.mockResolvedValue([COMPANY]);
    mocks.listInvoicesForAccount.mockResolvedValue([INVOICE]);
  });

  async function selectAccount() {
    render(<InvoicesTab />);
    await userEvent.selectOptions(await screen.findByLabelText('Account'), '900');
  }

  it('lists invoices for the selected account', async () => {
    await selectAccount();
    expect(await screen.findByText('INV-3-000001')).toBeInTheDocument();
  });

  it('shows an empty state before any account is selected', async () => {
    render(<InvoicesTab />);
    await screen.findByLabelText('Account');
    expect(screen.queryByText('INV-3-000001')).not.toBeInTheDocument();
  });

  it('expands to show real line items (TESTING.md AR-1)', async () => {
    mocks.getInvoice.mockResolvedValue({ ...INVOICE, lines: [{ id: '1', business_date: '2027-01-01', amount: '250.00', currency: 'NGN' }] });
    await selectAccount();
    await screen.findByText('INV-3-000001');

    await userEvent.click(screen.getByRole('button', { name: 'View lines' }));

    expect(mocks.getInvoice).toHaveBeenCalledWith('1000');
    expect(await screen.findByText(/Invoice INV-3-000001 — line items/)).toBeInTheDocument();
  });

  it('voids an invoice only after confirming with a mandatory reason', async () => {
    mocks.voidInvoice.mockResolvedValue({ ...INVOICE, status: 'void' });
    await selectAccount();
    await screen.findByText('INV-3-000001');

    await userEvent.click(screen.getByRole('button', { name: 'Void' }));
    expect(mocks.voidInvoice).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Duplicate invoice');
    await userEvent.click(screen.getByRole('button', { name: 'Void this invoice' }));

    expect(mocks.voidInvoice).toHaveBeenCalledWith('1000', 'Duplicate invoice');
  });

  it('does not offer a Void action on an already-void invoice', async () => {
    mocks.listInvoicesForAccount.mockResolvedValue([{ ...INVOICE, status: 'void' }]);
    await selectAccount();
    await screen.findByText('INV-3-000001');
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });

  it('disables the Void action while offline', async () => {
    render(<InvoicesTab isOffline />);
    await userEvent.selectOptions(await screen.findByLabelText('Account'), '900');
    await screen.findByText('INV-3-000001');
    expect(screen.getByRole('button', { name: 'Void' })).toBeDisabled();
  });
});
