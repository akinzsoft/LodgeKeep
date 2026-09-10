import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PickupBillingTab } from '../PickupBillingTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  getPickupSummary: vi.fn(),
  billToSponsor: vi.fn(),
  listAccounts: vi.fn(),
  listCompanyProfiles: vi.fn(),
  generateInvoice: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    groupBlocksApi: { ...actual.groupBlocksApi, getPickupSummary: mocks.getPickupSummary, billToSponsor: mocks.billToSponsor },
    arApi: { ...actual.arApi, listAccounts: mocks.listAccounts, generateInvoice: mocks.generateInvoice },
    profilesApi: { ...actual.profilesApi, listCompanyProfiles: mocks.listCompanyProfiles },
  };
});

const UNSPONSORED_BLOCK = { id: '1', block_name: 'Acme Conference', company_profile_id: null };
const SPONSORED_BLOCK = { id: '2', block_name: 'Sponsored Summit', company_profile_id: '50' };
const COMPANY = { id: '50', name: 'Acme Corp' };
const ACCOUNT = { id: '900', company_profile_id: '50', current_balance: '100.00', credit_limit: '1000.00', currency: 'NGN', is_over_limit: false };
const PICKUP = { groupBlockId: '2', blockName: 'Sponsored Summit', rows: [{ roomTypeId: '10', stayDate: '2027-03-10', roomsBlocked: 4, roomsPickedUp: 2 }], totalRoomsBlocked: 4, totalRoomsPickedUp: 2 };

describe('<PickupBillingTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getPickupSummary.mockResolvedValue(PICKUP);
    mocks.listAccounts.mockResolvedValue([ACCOUNT]);
    mocks.listCompanyProfiles.mockResolvedValue([COMPANY]);
  });

  it('shows an honest prompt with no block selected', () => {
    render(<PickupBillingTab block={null} />);
    expect(screen.getByText(/select a block/i)).toBeInTheDocument();
  });

  it('renders the pickup progress and per-row breakdown', async () => {
    render(<PickupBillingTab block={SPONSORED_BLOCK} />);
    expect(await screen.findByText(/2 of 4 blocked rooms picked up/i)).toBeInTheDocument();
  });

  it('an unsponsored block shows a plain explanation, no billing actions', async () => {
    render(<PickupBillingTab block={UNSPONSORED_BLOCK} />);
    await screen.findByText(/2 of 4|no room allocations/i);
    expect(screen.getByText(/no sponsoring company/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bill rooming list to sponsor' })).not.toBeInTheDocument();
  });

  it('a sponsored block with no AR account yet explains rather than offering a broken action', async () => {
    mocks.listAccounts.mockResolvedValue([]);
    render(<PickupBillingTab block={SPONSORED_BLOCK} />);
    expect(await screen.findByText(/has no active AR account yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bill rooming list to sponsor' })).not.toBeInTheDocument();
  });

  it('bills the rooming list to the sponsor after confirming', async () => {
    mocks.billToSponsor.mockResolvedValue({ groupBlockId: '2', companyProfileId: '50', billed: ['9001'], skipped: [] });
    render(<PickupBillingTab block={SPONSORED_BLOCK} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bill rooming list to sponsor' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Bill to sponsor' }));
    expect(mocks.billToSponsor).toHaveBeenCalledWith('2');
    expect(await screen.findByText(/Billed 1 folio\(s\) to Acme Corp/i)).toBeInTheDocument();
  });

  it('generates a block-scoped invoice', async () => {
    mocks.generateInvoice.mockResolvedValue({ invoice_number: 'INV-1-000001', total_amount: '150.00', currency: 'NGN' });
    render(<PickupBillingTab block={SPONSORED_BLOCK} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Generate invoice for this block' }));
    expect(mocks.generateInvoice).toHaveBeenCalledWith('900', { groupBlockId: '2' });
    expect(await screen.findByText(/INV-1-000001/)).toBeInTheDocument();
  });

  it('surfaces a real backend error from billToSponsor', async () => {
    mocks.billToSponsor.mockRejectedValue(new ApiError({ code: 'BUSINESS_RULE_GROUP_BLOCK_NOT_SPONSORED', message: 'This group block has no sponsoring company profile to bill its rooming list to.' }));
    render(<PickupBillingTab block={SPONSORED_BLOCK} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bill rooming list to sponsor' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Bill to sponsor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This group block has no sponsoring company profile to bill its rooming list to.');
  });
});
