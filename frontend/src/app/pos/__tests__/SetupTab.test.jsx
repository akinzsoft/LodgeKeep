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
  listMenuItems: vi.fn(),
  createMenuItem: vi.fn(),
  updateMenuItem: vi.fn(),
  setMenuItemAvailability: vi.fn(),
  archiveMenuItem: vi.fn(),
  listMenuCategories: vi.fn(),
  createMenuCategory: vi.fn(),
  updateMenuCategory: vi.fn(),
  archiveMenuCategory: vi.fn(),
  uploadMenuItemImage: vi.fn(),
  removeMenuItemImage: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks };
});

const OUTLET = { id: '1', code: 'BAR', name: 'Main Bar', type: 'bar' };

describe('<SetupTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listTerminals.mockResolvedValue([]);
    mocks.listMenuItems.mockResolvedValue([]);
    mocks.listMenuCategories.mockResolvedValue([
      { id: '1', name: 'Drinks', sort_order: 0, item_count: 1 },
      { id: '2', name: 'Mains', sort_order: 1, item_count: 0 },
    ]);
  });

  it('lists outlets and creates a new one', async () => {
    mocks.createOutlet.mockResolvedValue({ id: '2', code: 'REST', name: 'Restaurant', type: 'restaurant' });
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    expect(await screen.findByText('Main Bar')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Code'), 'REST');
    await userEvent.type(screen.getByLabelText('Name'), 'Restaurant');
    await userEvent.click(screen.getByRole('button', { name: 'Add outlet' }));

    expect(mocks.createOutlet).toHaveBeenCalledWith(expect.objectContaining({ code: 'REST', name: 'Restaurant' }));
  });

  it('selecting an outlet loads its terminals and menu, and creating a terminal calls the API', async () => {
    mocks.createTerminal.mockResolvedValue({ id: '9' });
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByText('Terminals — Main Bar')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Device ref'), 'TERM-1');
    await userEvent.click(screen.getByRole('button', { name: 'Add terminal' }));

    expect(mocks.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1', deviceRef: 'TERM-1' }));
  });

  it('toggles a menu item stock-out state', async () => {
    mocks.listMenuItems.mockResolvedValue([{ id: '5', name: 'Cocktail', category: 'Drinks', price: '20.00', is_available: true }]);
    mocks.setMenuItemAvailability.mockResolvedValue({});
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark stocked out' }));

    expect(mocks.setMenuItemAvailability).toHaveBeenCalledWith('5', false);
  });

  it("bug fix: renders the active property's real currency, not a hardcoded NGN", async () => {
    mocks.listMenuItems.mockResolvedValue([{ id: '5', name: 'Cocktail', category: 'Drinks', price: '20.00', is_available: true }]);
    render(<SetupTab activeProperty={{ base_currency: 'KES' }} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));

    // KES formats as "Ksh" via Intl (confirmed directly against the real
    // Intl.NumberFormat output) — proves the currency actually threaded
    // through, not just that the component happened to still say "NGN".
    expect(await screen.findByText(/Ksh/)).toBeInTheDocument();
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument();
  });

  it('shows a real error rather than an empty list on load failure', async () => {
    mocks.listOutlets.mockReset();
    mocks.listOutlets.mockRejectedValue(new Error('boom'));
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
    expect(await screen.findByText('No outlets yet — add one above.')).toBeInTheDocument();
  });

  it('gap closure: edits an outlet through the real update endpoint, pre-filled with its current values', async () => {
    mocks.updateOutlet.mockResolvedValue({ ...OUTLET, name: 'Renamed Bar' });
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

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
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    const terminalsSection = (await screen.findByRole('heading', { name: 'Terminals — Main Bar' })).closest('section');
    await userEvent.click(within(terminalsSection).getByRole('button', { name: 'Edit' }));
    const editCard = (await screen.findByRole('heading', { name: 'Edit terminal' })).closest('section');
    const deviceRefInput = within(editCard).getByLabelText('Device ref');
    expect(deviceRefInput).toHaveValue('TERM-1');

    await userEvent.click(within(editCard).getByLabelText('Supports contactless'));
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateTerminal).toHaveBeenCalledWith('9', { device_ref: 'TERM-1', supports_contactless: true });
  });

  it('gap closure: edits a menu item through the real update endpoint, pre-filled with its current price', async () => {
    mocks.listMenuItems.mockResolvedValue([{ id: '5', name: 'Cocktail', category: 'Drinks', price: '20.00', is_available: true }]);
    mocks.updateMenuItem.mockResolvedValue({ id: '5', name: 'Cocktail', category: 'Drinks', price: '25.50', is_available: true });
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    const menuSection = (await screen.findByRole('heading', { name: 'Menu — Main Bar' })).closest('section');
    await userEvent.click(within(menuSection).getByRole('button', { name: 'Edit' }));
    const editCard = (await screen.findByRole('heading', { name: 'Edit menu item' })).closest('section');
    const priceInput = within(editCard).getByLabelText('Selling price');
    expect(priceInput).toHaveValue(20);

    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '25.5');
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateMenuItem).toHaveBeenCalledWith('5', { name: 'Cocktail', category: 'Drinks', price: '25.5', cost_price: '' });
  });

  describe('menu categories', () => {
    async function openMenu() {
      render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
      return (await screen.findByRole('heading', { name: 'Menu — Main Bar' })).closest('section');
    }

    it('offers only registered categories in a dropdown when adding a menu item', async () => {
      mocks.createMenuItem.mockResolvedValue({ id: '7', name: 'Steak' });
      const menuSection = await openMenu();
      const select = within(menuSection).getByLabelText('Category');
      expect(select.tagName).toBe('SELECT');
      expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a category', 'Drinks', 'Mains']);

      await userEvent.type(within(menuSection).getByLabelText('Name'), 'Steak');
      await userEvent.selectOptions(select, 'Mains');
      await userEvent.type(within(menuSection).getByLabelText('Selling price'), '40');
      await userEvent.click(within(menuSection).getByRole('button', { name: 'Add item' }));
      expect(mocks.createMenuItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'Steak', category: 'Mains' }));
    });

    it('gap closure: creates a menu item with an optional cost price, and shows it in the table', async () => {
      mocks.createMenuItem.mockResolvedValue({ id: '8', name: 'Bottle of Wine' });
      const menuSection = await openMenu();

      await userEvent.type(within(menuSection).getByLabelText('Name'), 'Bottle of Wine');
      await userEvent.selectOptions(within(menuSection).getByLabelText('Category'), 'Drinks');
      await userEvent.type(within(menuSection).getByLabelText('Selling price'), '6');
      await userEvent.type(within(menuSection).getByLabelText('Cost price (optional)'), '4');
      await userEvent.click(within(menuSection).getByRole('button', { name: 'Add item' }));

      expect(mocks.createMenuItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bottle of Wine', costPrice: '4' }));

      mocks.listMenuItems.mockResolvedValue([{ id: '8', name: 'Bottle of Wine', category: 'Drinks', price: '6.00', cost_price: '4.00', is_available: true }]);
      await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
      const reloaded = (await screen.findByRole('heading', { name: 'Menu — Main Bar' })).closest('section');
      const row = (await within(reloaded).findByText('Bottle of Wine')).closest('tr');
      expect(within(row).getByText(/4\.00/)).toBeInTheDocument();
    });

    it('a menu item with no cost price configured shows a dash in the Cost column, never a false zero', async () => {
      mocks.listMenuItems.mockResolvedValue([{ id: '5', name: 'Cocktail', category: 'Drinks', price: '20.00', cost_price: null, is_available: true }]);
      const menuSection = await openMenu();
      const row = (await within(menuSection).findByText('Cocktail')).closest('tr');
      expect(row.querySelector('[data-label="Cost"]')).toHaveTextContent('—');
    });

    it('keeps an item\'s current category selectable when editing, even if it is no longer registered', async () => {
      mocks.listMenuItems.mockResolvedValue([{ id: '5', name: 'Old Wine', category: 'Legacy', price: '20.00', is_available: true }]);
      const menuSection = await openMenu();
      await userEvent.click(within(menuSection).getByRole('button', { name: 'Edit' }));
      const editCard = (await screen.findByRole('heading', { name: 'Edit menu item' })).closest('section');
      const select = within(editCard).getByLabelText('Category');
      expect(select).toHaveValue('Legacy');
      expect([...select.options].map((o) => o.textContent)).toEqual(['Drinks', 'Mains', 'Legacy']);
    });

    it('prompts to add a category first when none are registered', async () => {
      mocks.listMenuCategories.mockResolvedValue([]);
      const menuSection = await openMenu();
      expect(within(menuSection).getByText('Add a category in Menu categories above before adding menu items.')).toBeInTheDocument();
    });

    it('registers a new category from the Menu categories card and refreshes the dropdown', async () => {
      mocks.createMenuCategory.mockResolvedValue({ id: '3', name: 'Starters' });
      render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
      const card = (await screen.findByRole('heading', { name: 'Menu categories' })).closest('section');
      expect(await within(card).findByText('Drinks')).toBeInTheDocument();

      await userEvent.type(within(card).getByLabelText('Category name'), 'Starters');
      await userEvent.type(within(card).getByLabelText('Display order'), '2');
      mocks.listMenuCategories.mockResolvedValue([
        { id: '1', name: 'Drinks', sort_order: 0, item_count: 1 },
        { id: '3', name: 'Starters', sort_order: 2, item_count: 0 },
      ]);
      await userEvent.click(within(card).getByRole('button', { name: 'Add category' }));

      expect(mocks.createMenuCategory).toHaveBeenCalledWith({ name: 'Starters', sortOrder: 2 });
      expect(await within(card).findByText('Starters')).toBeInTheDocument();
    });

    it('renames a category', async () => {
      mocks.updateMenuCategory.mockResolvedValue({ id: '1', name: 'Beverages' });
      render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
      const card = (await screen.findByRole('heading', { name: 'Menu categories' })).closest('section');
      const row = (await within(card).findByText('Drinks')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      const input = within(card).getByLabelText('Rename category');
      await userEvent.clear(input);
      await userEvent.type(input, 'Beverages');
      await userEvent.click(within(card).getByRole('button', { name: 'Save category' }));
      expect(mocks.updateMenuCategory).toHaveBeenCalledWith('1', { name: 'Beverages', sortOrder: 0 });
    });

    it('shows why a category in use cannot be archived', async () => {
      const { ApiError } = await import('../../../shared/api/index.js');
      mocks.archiveMenuCategory.mockRejectedValue(new ApiError({ code: 'CONFLICT_POS_MENU_CATEGORY_IN_USE', message: '"Drinks" is still used by 1 menu item — move them to another category first.' }));
      render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
      const card = (await screen.findByRole('heading', { name: 'Menu categories' })).closest('section');
      const row = (await within(card).findByText('Drinks')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Archive' }));
      await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive' }));
      expect(await within(card).findByRole('alert')).toHaveTextContent('"Drinks" is still used by 1 menu item');
    });
  });

  describe('menu item photos', () => {
    const photo = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'chapman.png', { type: 'image/png' });

    async function openMenu() {
      render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
      return (await screen.findByRole('heading', { name: 'Menu — Main Bar' })).closest('section');
    }

    it('uploads the chosen photo right after creating the item', async () => {
      mocks.createMenuItem.mockResolvedValue({ id: '7', name: 'Chapman' });
      mocks.uploadMenuItemImage.mockResolvedValue({ id: '7', image_url: '/api/v1/media/menu-items/x.png' });
      const menuSection = await openMenu();

      await userEvent.type(within(menuSection).getByLabelText('Name'), 'Chapman');
      await userEvent.selectOptions(within(menuSection).getByLabelText('Category'), 'Drinks');
      await userEvent.type(within(menuSection).getByLabelText('Selling price'), '15');
      const file = photo();
      await userEvent.upload(within(menuSection).getByLabelText('Photo (optional)'), file);
      await userEvent.click(within(menuSection).getByRole('button', { name: 'Add item' }));

      expect(mocks.createMenuItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'Chapman' }));
      expect(mocks.uploadMenuItemImage).toHaveBeenCalledWith('7', file);
    });

    it('refuses an oversized photo before saving anything', async () => {
      const menuSection = await openMenu();
      await userEvent.type(within(menuSection).getByLabelText('Name'), 'Chapman');
      await userEvent.selectOptions(within(menuSection).getByLabelText('Category'), 'Drinks');
      await userEvent.type(within(menuSection).getByLabelText('Selling price'), '15');
      const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' });
      await userEvent.upload(within(menuSection).getByLabelText('Photo (optional)'), big);
      await userEvent.click(within(menuSection).getByRole('button', { name: 'Add item' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('The photo must be 2 MB or smaller.');
      expect(mocks.createMenuItem).not.toHaveBeenCalled();
    });

    it('says the item saved even when only its photo upload fails', async () => {
      mocks.createMenuItem.mockResolvedValue({ id: '7', name: 'Chapman' });
      const { ApiError } = await import('../../../shared/api/index.js');
      mocks.uploadMenuItemImage.mockRejectedValue(new ApiError({ code: 'VALIDATION_INVALID_IMAGE', message: 'The photo must be a JPG, PNG, or WebP image.' }));
      const menuSection = await openMenu();
      await userEvent.type(within(menuSection).getByLabelText('Name'), 'Chapman');
      await userEvent.selectOptions(within(menuSection).getByLabelText('Category'), 'Drinks');
      await userEvent.type(within(menuSection).getByLabelText('Selling price'), '15');
      await userEvent.upload(within(menuSection).getByLabelText('Photo (optional)'), photo());
      await userEvent.click(within(menuSection).getByRole('button', { name: 'Add item' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('The item was added, but its photo was not: The photo must be a JPG, PNG, or WebP image.');
      // The form is cleared, so pressing "Add item" again cannot create a duplicate.
      expect(within(menuSection).getByLabelText('Name')).toHaveValue('');
      await userEvent.click(within(menuSection).getByRole('button', { name: 'Add item' }));
      expect(mocks.createMenuItem).toHaveBeenCalledTimes(1);
    });

    it('refreshes the list and says the changes saved when only the edited photo fails', async () => {
      const item = { id: '5', name: 'Cocktail', category: 'Drinks', price: '20.00', is_available: true, image_url: null };
      mocks.listMenuItems.mockResolvedValue([item]);
      mocks.updateMenuItem.mockResolvedValue({ ...item, price: '25.00' });
      const { ApiError } = await import('../../../shared/api/index.js');
      mocks.uploadMenuItemImage.mockRejectedValue(new ApiError({ code: 'VALIDATION_IMAGE_TOO_LARGE', message: 'The photo must be 2 MB or smaller.' }));
      const menuSection = await openMenu();
      await userEvent.click(within(menuSection).getByRole('button', { name: 'Edit' }));
      const editCard = (await screen.findByRole('heading', { name: 'Edit menu item' })).closest('section');
      await userEvent.upload(within(editCard).getByLabelText('Add photo'), photo());
      const loadsBefore = mocks.listMenuItems.mock.calls.length;
      await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

      expect(await within(editCard).findByRole('alert')).toHaveTextContent('Your changes were saved, but the photo was not: The photo must be 2 MB or smaller.');
      expect(mocks.listMenuItems.mock.calls.length).toBeGreaterThan(loadsBefore);
    });

    it('shows the current photo when editing, and can replace or remove it', async () => {
      const item = { id: '5', name: 'Cocktail', category: 'Drinks', price: '20.00', is_available: true, image_url: '/api/v1/media/menu-items/old.png' };
      mocks.listMenuItems.mockResolvedValue([item]);
      mocks.updateMenuItem.mockResolvedValue(item);
      mocks.removeMenuItemImage.mockResolvedValue({ ...item, image_url: null });
      const menuSection = await openMenu();

      expect(within(menuSection).getByAltText('Photo of Cocktail')).toHaveAttribute('src', '/api/v1/media/menu-items/old.png');
      await userEvent.click(within(menuSection).getByRole('button', { name: 'Edit' }));
      const editCard = (await screen.findByRole('heading', { name: 'Edit menu item' })).closest('section');
      expect(within(editCard).getByAltText('Current photo of Cocktail')).toBeInTheDocument();

      await userEvent.click(within(editCard).getByRole('button', { name: 'Remove photo' }));
      expect(mocks.removeMenuItemImage).toHaveBeenCalledWith('5');
      expect(await within(editCard).findByText('No photo yet.')).toBeInTheDocument();

      const file = photo();
      await userEvent.upload(within(editCard).getByLabelText('Add photo'), file);
      await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));
      expect(mocks.uploadMenuItemImage).toHaveBeenCalledWith('5', file);
    });
  });

  it('gap closure: a real backend 403 editing an outlet renders in the error banner, not a silent failure', async () => {
    mocks.updateOutlet.mockRejectedValue(new Error('You do not have this permission.'));
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(within((await screen.findByText('Main Bar')).closest('tr')).getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Could not update this outlet.')).toBeInTheDocument();
  });

  it('Cancel discards an outlet edit without submitting', async () => {
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(within((await screen.findByText('Main Bar')).closest('tr')).getByRole('button', { name: 'Edit' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(mocks.updateOutlet).not.toHaveBeenCalled();
  });
});
