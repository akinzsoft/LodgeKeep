import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlocksTab } from '../BlocksTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listGroupBlocks: vi.fn(),
  createGroupBlock: vi.fn(),
  updateGroupBlock: vi.fn(),
  listCompanyProfiles: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    groupBlocksApi: { ...actual.groupBlocksApi, ...mocks },
    profilesApi: { ...actual.profilesApi, listCompanyProfiles: mocks.listCompanyProfiles },
  };
});

const COMPANY = { id: '50', name: 'Acme Corp' };
const BLOCK = { id: '1', block_name: 'Acme Conference', company_profile_id: null, start_date: '2027-03-10', end_date: '2027-03-13', cutoff_date: null, status: 'active' };

describe('<BlocksTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listGroupBlocks.mockResolvedValue([BLOCK]);
    mocks.listCompanyProfiles.mockResolvedValue([COMPANY]);
  });

  it('lists blocks with "No sponsor" when unsponsored', async () => {
    render(<BlocksTab />);
    expect(await screen.findByText('Acme Conference')).toBeInTheDocument();
    // "No sponsor" also appears as a select <option> in the create form.
    expect((await screen.findAllByText('No sponsor')).find((el) => el.tagName === 'TD')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('resolves a sponsor company name', async () => {
    mocks.listGroupBlocks.mockResolvedValue([{ ...BLOCK, company_profile_id: '50' }]);
    render(<BlocksTab />);
    expect(await screen.findAllByText('Acme Corp')).not.toHaveLength(0);
  });

  it('creates a block via the form', async () => {
    mocks.createGroupBlock.mockResolvedValue({ ...BLOCK, id: '2', block_name: 'New Retreat' });
    render(<BlocksTab />);
    await screen.findByText('Acme Conference');

    await userEvent.type(screen.getByPlaceholderText(/Acme Conference/), 'New Retreat');
    const dateInputs = screen.getAllByDisplayValue('');
    await userEvent.type(dateInputs[0], '2027-04-01');
    await userEvent.type(dateInputs[1], '2027-04-05');
    await userEvent.click(screen.getByRole('button', { name: 'Add group block' }));

    expect(mocks.createGroupBlock).toHaveBeenCalledWith(
      expect.objectContaining({ blockName: 'New Retreat', startDate: '2027-04-01', endDate: '2027-04-05' })
    );
  });

  it('surfaces a real backend error on create', async () => {
    mocks.createGroupBlock.mockRejectedValue(new ApiError({ code: 'VALIDATION_COMPANY_PROFILE_NOT_FOUND', message: 'No company profile exists with this id in this tenant.' }));
    render(<BlocksTab />);
    await screen.findByText('Acme Conference');

    await userEvent.type(screen.getByPlaceholderText(/Acme Conference/), 'Bad Block');
    const dateInputs = screen.getAllByDisplayValue('');
    await userEvent.type(dateInputs[0], '2027-04-01');
    await userEvent.type(dateInputs[1], '2027-04-05');
    await userEvent.click(screen.getByRole('button', { name: 'Add group block' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No company profile exists with this id in this tenant.');
  });

  it('cancelling a block calls updateGroupBlock with status: cancelled', async () => {
    mocks.updateGroupBlock.mockResolvedValue({ ...BLOCK, status: 'cancelled' });
    render(<BlocksTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(mocks.updateGroupBlock).toHaveBeenCalledWith('1', expect.objectContaining({ status: 'cancelled' }));
  });

  it('disables mutating actions while offline', async () => {
    render(<BlocksTab isOffline />);
    expect(await screen.findByText(/you are offline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add group block' })).toBeDisabled();
  });
});
