import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupTab } from '../SetupTab.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  createOutlet: vi.fn(),
  updateOutlet: vi.fn(),
  archiveOutlet: vi.fn(),
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  updateTerminal: vi.fn(),
  archiveTerminal: vi.fn(),
  // Menu items/categories now live in `MenuItemsTab.jsx` (its own test
  // file, `MenuItemsTab.test.jsx`, covers that behavior in depth) — but
  // `SetupTab` renders it for real once an outlet is selected, so these
  // are mocked here only to keep it quiet (empty defaults), never asserted
  // on directly in this file.
  listMenuItems: vi.fn(),
  listMenuCategories: vi.fn(),
  setOutletCategories: vi.fn(),
  listOutletTerminalAccounts: vi.fn(),
  setOutletTerminalAccount: vi.fn(),
  removeOutletTerminalAccount: vi.fn(),
}));

const stockMocks = vi.hoisted(() => ({
  listStockItems: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks, stockApi: stockMocks };
});

const OUTLET = { id: '1', code: 'BAR', name: 'Main Bar', type: 'bar' };

/** Setup opens on the shared Catalogue; the outlet list is under the Outlets view. */
async function renderOutlets() {
  render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
  await userEvent.click(screen.getByRole('tab', { name: 'Outlets' }));
}

describe('<SetupTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    Object.values(stockMocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listTerminals.mockResolvedValue([]);
    mocks.listMenuItems.mockResolvedValue([]);
    mocks.listMenuCategories.mockResolvedValue([]);
    mocks.listOutletTerminalAccounts.mockResolvedValue([]);
    stockMocks.listStockItems.mockResolvedValue([]);
  });

  it('lists outlets and creates a new one', async () => {
    mocks.createOutlet.mockResolvedValue({ id: '2', code: 'REST', name: 'Restaurant', type: 'restaurant' });
    await renderOutlets();

    expect(await screen.findByText('Main Bar')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Code'), 'REST');
    await userEvent.type(screen.getByLabelText('Name'), 'Restaurant');
    await userEvent.click(screen.getByRole('button', { name: 'Add outlet' }));

    expect(mocks.createOutlet).toHaveBeenCalledWith(expect.objectContaining({ code: 'REST', name: 'Restaurant' }));
  });

  it('selecting an outlet loads its terminals, and creating a terminal calls the API', async () => {
    mocks.createTerminal.mockResolvedValue({ id: '9' });
    await renderOutlets();

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Terminals' }));
    expect(await screen.findByText('Terminals — Main Bar')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Device ref'), 'TERM-1');
    await userEvent.click(screen.getByRole('button', { name: 'Add terminal' }));

    expect(mocks.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1', deviceRef: 'TERM-1' }));
  });

  describe('terminal accounts (recording only)', () => {
    async function openAccounts() {
      await renderOutlets();
      await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
      await userEvent.click(screen.getByRole('tab', { name: 'Terminal accounts' }));
      await screen.findByRole('heading', { name: 'Terminal accounts — Main Bar' });
    }

    it('offers the three providers plus Other, masking a recorded number to its last 4', async () => {
      mocks.listOutletTerminalAccounts.mockResolvedValue([{ id: '5', provider: 'gtbank', account_number: '0123456789', account_number_last4: '6789', account_label: 'Bar GTB', bank_name: 'Any Microfinance Bank' }]);
      await openAccounts();

      expect(await screen.findByText('Bar GTB · Any Microfinance Bank · ····6789')).toBeInTheDocument();
      expect(screen.queryByText('0123456789')).not.toBeInTheDocument();
      expect(screen.getAllByText('No account recorded')).toHaveLength(3);
      expect(screen.getByText('Moniepoint')).toBeInTheDocument();
      expect(screen.getByText('Opay')).toBeInTheDocument();
      expect(screen.getByText('Other')).toBeInTheDocument();
    });

    it('records an Other account under a typed provider name and any bank, which must be named', async () => {
      mocks.setOutletTerminalAccount.mockResolvedValue({});
      await openAccounts();

      await userEvent.click(await screen.findByRole('button', { name: 'Record Other account' }));
      expect(screen.getByLabelText('Terminal provider name')).toBeRequired();
      await userEvent.type(screen.getByLabelText('Terminal provider name'), 'Zenith POS');
      await userEvent.type(screen.getByLabelText('Bank name (optional)'), 'Zenith Bank');
      await userEvent.type(screen.getByLabelText('Account number'), '7070707070');
      await userEvent.click(screen.getByRole('button', { name: 'Save account' }));

      expect(mocks.setOutletTerminalAccount).toHaveBeenCalledWith('1', 'other', { accountNumber: '7070707070', accountLabel: '', bankName: 'Zenith Bank', providerName: 'Zenith POS' });
    });

    it('only asks for a provider name on Other, and shows a recorded Other account by that name', async () => {
      mocks.listOutletTerminalAccounts.mockResolvedValue([{ id: '8', provider: 'other', provider_name: 'Zenith POS', account_number: '7070707070', account_number_last4: '7070', account_label: null, bank_name: 'Zenith Bank' }]);
      await openAccounts();
      expect(await screen.findByText('Other (Zenith POS)')).toBeInTheDocument();
      expect(screen.getByText('Zenith Bank · ····7070')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Record Opay account' }));
      expect(screen.queryByLabelText('Terminal provider name')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Bank name (optional)')).toBeInTheDocument();
    });

    it('records an account through the API and reloads', async () => {
      mocks.setOutletTerminalAccount.mockResolvedValue({});
      await openAccounts();

      await userEvent.click(await screen.findByRole('button', { name: 'Record Opay account' }));
      await userEvent.type(screen.getByLabelText('Account number'), '2020202020');
      await userEvent.type(screen.getByLabelText('Label (optional)'), 'Bar Opay');
      await userEvent.click(screen.getByRole('button', { name: 'Save account' }));

      expect(mocks.setOutletTerminalAccount).toHaveBeenCalledWith('1', 'opay', { accountNumber: '2020202020', accountLabel: 'Bar Opay', bankName: '', providerName: '' });
      expect(mocks.listOutletTerminalAccounts.mock.calls.length).toBeGreaterThan(1);
    });

    it('shows the real server error when saving is refused, and removes an account', async () => {
      const { ApiError } = await import('../../../shared/api/index.js');
      mocks.listOutletTerminalAccounts.mockResolvedValue([{ id: '5', provider: 'gtbank', account_number: '0123456789', account_number_last4: '6789', account_label: null }]);
      mocks.setOutletTerminalAccount.mockRejectedValue(new ApiError({ status: 400, code: 'VALIDATION_INVALID_ACCOUNT_NUMBER', message: 'Account number must be digits only.' }));
      mocks.removeOutletTerminalAccount.mockResolvedValue({ removed: true });
      await openAccounts();

      await userEvent.click(await screen.findByRole('button', { name: 'Edit GTBank account' }));
      expect(screen.getByLabelText('Account number')).toHaveValue('0123456789');
      await userEvent.click(screen.getByRole('button', { name: 'Save account' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Account number must be digits only.');

      await userEvent.click(screen.getByRole('button', { name: 'Remove GTBank account' }));
      expect(mocks.removeOutletTerminalAccount).toHaveBeenCalledWith('1', 'gtbank');
    });
  });

  it('shows a real error rather than an empty list on load failure', async () => {
    mocks.listOutlets.mockReset();
    mocks.listOutlets.mockRejectedValue(new Error('boom'));
    await renderOutlets();
    expect(await screen.findByText('No outlets yet — add one above.')).toBeInTheDocument();
  });

  it('gap closure: edits an outlet through the real update endpoint, pre-filled with its current values', async () => {
    mocks.updateOutlet.mockResolvedValue({ ...OUTLET, name: 'Renamed Bar' });
    await renderOutlets();

    await userEvent.click(within((await screen.findByText('Main Bar')).closest('tr')).getByRole('button', { name: 'Edit' }));
    const editCard = (await screen.findByRole('heading', { name: 'Edit outlet' })).closest('section');
    const nameInput = within(editCard).getByLabelText('Name');
    expect(nameInput).toHaveValue('Main Bar');

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed Bar');
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateOutlet).toHaveBeenCalledWith('1', { code: 'BAR', name: 'Renamed Bar', type: 'bar' });
  });

  it('gap closure: edits a terminal through the real update endpoint', async () => {
    mocks.listTerminals.mockResolvedValue([{ id: '9', device_ref: 'TERM-1', supports_contactless: false }]);
    mocks.updateTerminal.mockResolvedValue({ id: '9', device_ref: 'TERM-1-RENAMED', supports_contactless: true });
    await renderOutlets();

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Terminals' }));
    const terminalsSection = (await screen.findByRole('heading', { name: 'Terminals — Main Bar' })).closest('section');
    await userEvent.click(within(terminalsSection).getByRole('button', { name: 'Edit' }));
    const editCard = (await screen.findByRole('heading', { name: 'Edit terminal' })).closest('section');
    const deviceRefInput = within(editCard).getByLabelText('Device ref');
    expect(deviceRefInput).toHaveValue('TERM-1');

    await userEvent.click(within(editCard).getByLabelText('Supports contactless'));
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateTerminal).toHaveBeenCalledWith('9', { device_ref: 'TERM-1', supports_contactless: true });
  });

  it('gap closure: a real backend 403 editing an outlet renders in the error banner, not a silent failure', async () => {
    mocks.updateOutlet.mockRejectedValue(new Error('You do not have this permission.'));
    await renderOutlets();

    await userEvent.click(within((await screen.findByText('Main Bar')).closest('tr')).getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Could not update this outlet.')).toBeInTheDocument();
  });

  it('Cancel discards an outlet edit without submitting', async () => {
    await renderOutlets();

    await userEvent.click(within((await screen.findByText('Main Bar')).closest('tr')).getByRole('button', { name: 'Edit' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(mocks.updateOutlet).not.toHaveBeenCalled();
  });

  it('opens on the shared Catalogue, which lists every category and item — no outlet', async () => {
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
    expect(await screen.findByRole('heading', { name: 'Menu categories — all outlets' })).toBeInTheDocument();
    expect(mocks.listMenuCategories).toHaveBeenCalledWith({ outletId: null });
    expect(mocks.listMenuItems).toHaveBeenCalledWith(null);
  });

  it('managing an outlet starts on the categories it sells; ticking some and saving sets them', async () => {
    mocks.listMenuCategories.mockResolvedValue([
      { id: '5', name: 'Drinks', status: 'active', item_count: 3, outlet_ids: ['1'] },
      { id: '6', name: 'Snacks', status: 'active', item_count: 2, outlet_ids: [] },
    ]);
    mocks.setOutletCategories.mockResolvedValue({ category_ids: ['5', '6'] });
    await renderOutlets();
    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));

    const card = (await screen.findByRole('heading', { name: 'Categories sold at Main Bar' })).closest('section');
    expect(within(card).getByRole('checkbox', { name: /Drinks/ })).toBeChecked();
    expect(within(card).getByRole('checkbox', { name: /Snacks/ })).not.toBeChecked();
    await userEvent.click(within(card).getByRole('checkbox', { name: /Snacks/ }));
    await userEvent.click(within(card).getByRole('button', { name: 'Save categories' }));
    expect(mocks.setOutletCategories).toHaveBeenCalledWith('1', ['5', '6']);
    // Then on to what it sells, with its own prices.
    expect(await screen.findByRole('heading', { name: 'Menu categories sold at Main Bar' })).toBeInTheDocument();
    expect(mocks.listMenuCategories).toHaveBeenCalledWith({ outletId: '1' });
  });

  it('a new outlet opens straight on choosing its categories', async () => {
    mocks.createOutlet.mockResolvedValue({ id: '2', code: 'REST', name: 'Restaurant', type: 'restaurant' });
    mocks.listOutlets.mockResolvedValueOnce([OUTLET]).mockResolvedValue([OUTLET, { id: '2', code: 'REST', name: 'Restaurant', type: 'restaurant' }]);
    await renderOutlets();
    await screen.findByText('Main Bar');
    await userEvent.type(screen.getByLabelText('Code'), 'REST');
    await userEvent.type(screen.getByLabelText('Name'), 'Restaurant');
    await userEvent.click(screen.getByRole('button', { name: 'Add outlet' }));
    expect(await screen.findByRole('heading', { name: 'Categories sold at Restaurant' })).toBeInTheDocument();
  });

  it('shows which outlet is being managed, and the switcher moves everything below to the other outlet', async () => {
    mocks.listOutlets.mockResolvedValue([
      { id: '1', code: 'BAR', name: 'Main Bar', type: 'bar' },
      { id: '3', code: 'SHOP', name: 'Supermarket', type: 'restaurant' },
    ]);
    await renderOutlets();
    expect(await screen.findByText(/Choose an outlet with Manage/)).toBeInTheDocument();
    await userEvent.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);

    const bar = screen.getByRole('region', { name: 'Outlet being managed' });
    expect(within(bar).getByRole('heading', { name: 'Main Bar' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Menu & prices here' }));
    expect(await screen.findByRole('heading', { name: 'Menu categories sold at Main Bar' })).toBeInTheDocument();

    await userEvent.selectOptions(within(bar).getByLabelText('Switch outlet'), '3');
    expect(within(bar).getByRole('heading', { name: 'Supermarket' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Menu categories sold at Supermarket' })).toBeInTheDocument();
    expect(mocks.listMenuCategories).toHaveBeenLastCalledWith({ outletId: '3' });
    expect(mocks.listTerminals).toHaveBeenLastCalledWith('3');
  });
});
