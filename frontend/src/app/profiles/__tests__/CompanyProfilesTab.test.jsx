import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompanyProfilesTab } from '../CompanyProfilesTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listCompanyProfiles: vi.fn(),
  createCompanyProfile: vi.fn(),
  updateCompanyProfile: vi.fn(),
  archiveCompanyProfile: vi.fn(),
  listAccounts: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    profilesApi: { ...actual.profilesApi, ...mocks },
    arApi: { ...actual.arApi, listAccounts: mocks.listAccounts },
  };
});

const COMPANY = { id: '50', name: 'Acme Corp', type: 'company', billing_email: 'ap@acme.test', payment_terms_days: 30 };

describe('<CompanyProfilesTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listCompanyProfiles.mockResolvedValue([COMPANY]);
    mocks.listAccounts.mockResolvedValue([]);
  });

  it('lists real company profiles', async () => {
    render(<CompanyProfilesTab />);
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('ap@acme.test')).toBeInTheDocument();
  });

  it('shows an empty state with no companies yet', async () => {
    mocks.listCompanyProfiles.mockResolvedValue([]);
    render(<CompanyProfilesTab />);
    expect(await screen.findByText(/no company profiles yet/i)).toBeInTheDocument();
  });

  it('creates a company profile through the real endpoint', async () => {
    mocks.listCompanyProfiles.mockResolvedValueOnce([]).mockResolvedValueOnce([COMPANY]);
    mocks.createCompanyProfile.mockResolvedValue(COMPANY);
    render(<CompanyProfilesTab />);
    await screen.findByText(/no company profiles yet/i);

    await userEvent.type(screen.getByLabelText('Name'), 'Acme Corp');
    await userEvent.type(screen.getByLabelText('Billing email'), 'ap@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Add company profile' }));

    expect(mocks.createCompanyProfile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme Corp', billingEmail: 'ap@acme.test' })
    );
  });

  it('surfaces a real backend error on a failed create', async () => {
    mocks.createCompanyProfile.mockRejectedValue(new ApiError({ code: 'VALIDATION_MISSING_FIELD', message: '"name" is required.' }));
    render(<CompanyProfilesTab />);
    await screen.findByText('Acme Corp');

    await userEvent.type(screen.getByLabelText('Name'), 'Beta LLC');
    await userEvent.click(screen.getByRole('button', { name: 'Add company profile' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('is required');
  });

  it('edits an existing company profile, pre-filled', async () => {
    mocks.updateCompanyProfile.mockResolvedValue({ ...COMPANY, name: 'Acme Corporation' });
    render(<CompanyProfilesTab />);
    await screen.findByText('Acme Corp');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Acme Corp');

    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Acme Corporation');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateCompanyProfile).toHaveBeenCalledWith('50', expect.objectContaining({ name: 'Acme Corporation' }));
  });

  it('archives a company profile only after confirming, with a plain-words consequence', async () => {
    mocks.archiveCompanyProfile.mockResolvedValue({ ...COMPANY, status: 'archived' });
    render(<CompanyProfilesTab />);
    await screen.findByText('Acme Corp');

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(mocks.archiveCompanyProfile).not.toHaveBeenCalled();
    expect(await screen.findByText(/This archives "Acme Corp"/)).toBeInTheDocument();

    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));

    expect(mocks.archiveCompanyProfile).toHaveBeenCalledWith('50');
  });

  it('shows the AR account summary for a selected company', async () => {
    mocks.listAccounts.mockResolvedValue([
      { id: '900', company_profile_id: '50', credit_limit: '500.00', current_balance: '120.00', currency: 'NGN', enforcement_mode: 'block', is_over_limit: false },
    ]);
    render(<CompanyProfilesTab />);
    await screen.findByText('Acme Corp');

    await userEvent.click(screen.getByRole('button', { name: 'View AR account' }));

    expect(await screen.findByText(/AR account — Acme Corp/)).toBeInTheDocument();
    expect(screen.getByText('Within limit')).toBeInTheDocument();
  });

  it('shows a real "no account yet" message when the company has no AR account at this property', async () => {
    mocks.listAccounts.mockResolvedValue([]);
    render(<CompanyProfilesTab />);
    await screen.findByText('Acme Corp');

    await userEvent.click(screen.getByRole('button', { name: 'View AR account' }));

    expect(await screen.findByText(/no AR account exists yet/i)).toBeInTheDocument();
  });

  it('disables mutating actions while offline', async () => {
    render(<CompanyProfilesTab isOffline />);
    await screen.findByText('Acme Corp');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add company profile' })).toBeDisabled();
  });
});
