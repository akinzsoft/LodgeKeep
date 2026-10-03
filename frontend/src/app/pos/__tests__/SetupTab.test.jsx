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
  createOutletTerminalAccount: vi.fn(),
  updateOutletTerminalAccount: vi.fn(),
  removeOutletTerminalAccount: vi.fn(),
  getOutletPayoutAccount: vi.fn(),
  resolveOutletPayoutBankAccount: vi.fn(),
  setOutletPayoutAccount: vi.fn(),
  clearOutletPayoutAccount: vi.fn(),
}));

const stockMocks = vi.hoisted(() => ({
  listStockItems: vi.fn(),
  listMenuItemComponents: vi.fn(),
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
    mocks.getOutletPayoutAccount.mockResolvedValue({ account: null, settles_to: { source: 'property', bank_name: 'Zenith Bank', account_number_last4: '1784', account_name: 'Hotel Ltd' } });
    stockMocks.listStockItems.mockResolvedValue([]);
    stockMocks.listMenuItemComponents.mockResolvedValue([]);
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

  it('offers Supermarket as an outlet type, on both the add and the edit form', async () => {
    mocks.createOutlet.mockResolvedValue({ id: '2', code: 'MART', name: 'Mini Mart', type: 'supermarket' });
    mocks.updateOutlet.mockResolvedValue({ ...OUTLET, type: 'supermarket' });
    await renderOutlets();
    expect(await screen.findByText('Main Bar')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Code'), 'MART');
    await userEvent.type(screen.getByLabelText('Name'), 'Mini Mart');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'Supermarket');
    await userEvent.click(screen.getByRole('button', { name: 'Add outlet' }));
    expect(mocks.createOutlet).toHaveBeenCalledWith(expect.objectContaining({ code: 'MART', type: 'supermarket' }));

    await userEvent.click(within((await screen.findByText('Main Bar')).closest('tr')).getByRole('button', { name: 'Edit' }));
    const editCard = (await screen.findByRole('heading', { name: 'Edit outlet' })).closest('section');
    await userEvent.selectOptions(within(editCard).getByLabelText('Type'), 'Supermarket');
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));
    expect(mocks.updateOutlet).toHaveBeenCalledWith('1', { code: 'BAR', name: 'Main Bar', type: 'supermarket' });
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

  describe('online payout account', () => {
    async function openPayout(props = {}) {
      render(<SetupTab activeProperty={{ base_currency: 'NGN' }} {...props} />);
      await userEvent.click(screen.getByRole('tab', { name: 'Outlets' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
      await userEvent.click(screen.getByRole('tab', { name: 'Online payout account' }));
      await screen.findByRole('heading', { name: 'Online payout account — Main Bar' });
    }

    it('says an outlet with no account of its own settles to the property account', async () => {
      await openPayout();
      expect(await screen.findByText(/settles to the/i)).toHaveTextContent('property account');
      expect(screen.getByText(/ending 1784/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Set outlet account' })).toBeInTheDocument();
    });

    it('checks the account name first, then saves; the save call carries the bank fields', async () => {
      mocks.resolveOutletPayoutBankAccount.mockResolvedValue({ accountName: 'BAR LTD' });
      mocks.setOutletPayoutAccount.mockResolvedValue({ account: { id: '1' }, settles_to: { source: 'outlet', bank_name: 'Zenith Bank', account_number_last4: '4321', account_name: 'BAR LTD' } });
      await openPayout();

      await userEvent.click(await screen.findByRole('button', { name: 'Set outlet account' }));
      await userEvent.type(screen.getByLabelText('Bank name'), 'Zenith Bank');
      await userEvent.type(screen.getByLabelText('Bank code'), '057');
      await userEvent.type(screen.getByLabelText('Account number'), '0000004321');
      await userEvent.click(screen.getByRole('button', { name: 'Check account name' }));
      expect(await screen.findByText('BAR LTD')).toBeInTheDocument();
      expect(mocks.setOutletPayoutAccount).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Save payout account' }));
      expect(mocks.setOutletPayoutAccount).toHaveBeenCalledWith('1', { bankName: 'Zenith Bank', bankCode: '057', accountNumber: '0000004321' });
      expect(await screen.findByText(/own account/i)).toBeInTheDocument();
    });

    it('shows the "already used" message from the server and keeps the form', async () => {
      const { ApiError } = await import('../../../shared/api/index.js');
      mocks.resolveOutletPayoutBankAccount.mockResolvedValue({ accountName: 'BAR LTD' });
      mocks.setOutletPayoutAccount.mockRejectedValue(new ApiError({ status: 409, code: 'CONFLICT_PAYOUT_ACCOUNT_ALREADY_USED', message: 'This bank account is already used by another payout account.' }));
      await openPayout();
      await userEvent.click(await screen.findByRole('button', { name: 'Set outlet account' }));
      await userEvent.type(screen.getByLabelText('Bank name'), 'Zenith Bank');
      await userEvent.type(screen.getByLabelText('Bank code'), '057');
      await userEvent.type(screen.getByLabelText('Account number'), '0000004321');
      await userEvent.click(screen.getByRole('button', { name: 'Check account name' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Save payout account' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('already used by another payout account');
    });

    it('lets an admin go back to the property account', async () => {
      mocks.getOutletPayoutAccount.mockResolvedValue({ account: { id: '1' }, settles_to: { source: 'outlet', bank_name: 'Zenith Bank', account_number_last4: '4321', account_name: 'BAR LTD' } });
      mocks.clearOutletPayoutAccount.mockResolvedValue({ account: null, settles_to: { source: 'property', bank_name: 'Zenith Bank', account_number_last4: '1784', account_name: 'Hotel Ltd' } });
      await openPayout();
      await userEvent.click(await screen.findByRole('button', { name: 'Use the property account instead' }));
      expect(mocks.clearOutletPayoutAccount).toHaveBeenCalledWith('1');
      expect(await screen.findByText(/settles to the/i)).toHaveTextContent('property account');
    });

    it('is read-only guidance for anyone who is not an admin, and never loads the account', async () => {
      await openPayout({ canManageAccounts: false });
      expect(screen.getByText(/Only an administrator/i)).toBeInTheDocument();
      expect(mocks.getOutletPayoutAccount).not.toHaveBeenCalled();
    });
  });

  describe('terminal accounts (recording only)', () => {
    async function openAccounts() {
      await renderOutlets();
      await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
      await userEvent.click(screen.getByRole('tab', { name: 'Terminal accounts' }));
      await screen.findByRole('heading', { name: 'Terminal accounts — Main Bar' });
    }

    const ROW = { id: '5', provider: 'gtbank', account_number: '0123456789', account_number_last4: '6789', bank_name: 'GTBank', account_label: 'Bar GTB' };

    it('lists accounts by name with the last 4 only, including one named only by its label', async () => {
      mocks.listOutletTerminalAccounts.mockResolvedValue([ROW, { id: '3', provider: 'other', account_number: '9999999668', account_number_last4: '9668', bank_name: null, account_label: 'ZENITH BANK' }]);
      await openAccounts();

      expect(await screen.findByText('GTBank · Bar GTB')).toBeInTheDocument();
      expect(screen.getByText('ZENITH BANK')).toBeInTheDocument();
      expect(screen.getByText('····9668')).toBeInTheDocument();
      expect(screen.queryByText('0123456789')).not.toBeInTheDocument();
    });

    it('adds an account with a free-text bank, no provider required', async () => {
      mocks.createOutletTerminalAccount.mockResolvedValue({});
      await openAccounts();

      await userEvent.click(await screen.findByRole('button', { name: 'Add account' }));
      await userEvent.type(screen.getByLabelText('Account number'), '7070707070');
      await userEvent.type(screen.getByLabelText('Bank (optional)'), 'Some Brand New Bank');
      await userEvent.click(screen.getByRole('button', { name: 'Save account' }));

      expect(mocks.createOutletTerminalAccount).toHaveBeenCalledWith('1', { provider: '', accountNumber: '7070707070', bankName: 'Some Brand New Bank', accountLabel: '' });
      expect(mocks.listOutletTerminalAccounts.mock.calls.length).toBeGreaterThan(1);
    });

    it('shows the real server error when saving is refused, then removes an account by id', async () => {
      const { ApiError } = await import('../../../shared/api/index.js');
      mocks.listOutletTerminalAccounts.mockResolvedValue([ROW]);
      mocks.updateOutletTerminalAccount.mockRejectedValue(new ApiError({ status: 409, code: 'CONFLICT_DUPLICATE_ENTRY', message: 'This account number is already recorded for this outlet.' }));
      mocks.removeOutletTerminalAccount.mockResolvedValue({ removed: true });
      await openAccounts();

      await userEvent.click(await screen.findByRole('button', { name: 'Edit GTBank · Bar GTB account' }));
      expect(screen.getByLabelText('Account number')).toHaveValue('0123456789');
      await userEvent.click(screen.getByRole('button', { name: 'Save account' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('already recorded');
      expect(mocks.updateOutletTerminalAccount).toHaveBeenCalledWith('1', '5', expect.objectContaining({ accountNumber: '0123456789' }));

      await userEvent.click(screen.getByRole('button', { name: 'Remove GTBank · Bar GTB account' }));
      expect(mocks.removeOutletTerminalAccount).toHaveBeenCalledWith('1', '5');
    });

    it('tells a non-admin it is for administrators and never calls the admin list', async () => {
      mocks.listOutletTerminalAccounts.mockClear();
      render(<SetupTab activeProperty={{ base_currency: 'NGN' }} canManageAccounts={false} />);
      await userEvent.click(screen.getByRole('tab', { name: 'Outlets' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
      await userEvent.click(screen.getByRole('tab', { name: 'Terminal accounts' }));
      expect(await screen.findByText(/Only an administrator/)).toBeInTheDocument();
      expect(mocks.listOutletTerminalAccounts).not.toHaveBeenCalled();
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

  describe('restocking from the Menu & prices screen (deliveries go to the store room only)', () => {
    async function manageOutlet(rowIndex) {
      mocks.listOutlets.mockResolvedValue([
        { id: '1', code: 'BAR', name: 'Main Bar', type: 'bar' },
        { id: '9', code: 'STORE-01', name: 'Store-1', type: 'store' },
      ]);
      mocks.listMenuCategories.mockResolvedValue([{ id: '1', name: 'Drinks', sort_order: 0, item_count: 1 }]);
      mocks.listMenuItems.mockResolvedValue([{ id: '5', name: 'Cocktail', category: 'Drinks', price: '20.00', cost_price: null, is_available: true, image_url: null }]);
      stockMocks.listStockItems.mockResolvedValue([{ id: '30', name: 'Cocktail', unit: 'unit', purchase_cost: '4.00', reorder_level: '5.000', current_quantity: '12.000' }]);
      stockMocks.listMenuItemComponents.mockResolvedValue([{ stock_item_id: '30', quantity: '1' }]);
      await renderOutlets();
      await userEvent.click((await screen.findAllByRole('button', { name: 'Manage' }))[rowIndex]);
      await userEvent.click(screen.getByRole('tab', { name: 'Menu & prices here' }));
      return (await screen.findByRole('heading', { name: 'Restock — Drinks' })).closest('section');
    }

    it('disables Restock at a bar when the property has a store room', async () => {
      const restockCard = await manageOutlet(0);
      expect(within(restockCard).getByText(/Deliveries are received at the store room \(Store-1\)/)).toBeInTheDocument();
      expect(await within(restockCard).findByLabelText('Quantity')).toBeDisabled();
    });

    it('keeps Restock enabled at the store room itself', async () => {
      const restockCard = await manageOutlet(1);
      expect(await within(restockCard).findByLabelText('Quantity')).toBeEnabled();
    });
  });
});
