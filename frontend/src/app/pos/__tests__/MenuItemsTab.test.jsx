import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MenuItemsTab } from '../MenuItemsTab.jsx';
import { ApiError } from '../../../shared/api/index.js';
import { selectWhenLoaded } from './selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listMenuCategories: vi.fn(),
  createMenuCategory: vi.fn(),
  updateMenuCategory: vi.fn(),
  archiveMenuCategory: vi.fn(),
  listMenuItems: vi.fn(),
  createMenuItem: vi.fn(),
  updateMenuItem: vi.fn(),
  uploadMenuItemImage: vi.fn(),
  removeMenuItemImage: vi.fn(),
  setMenuItemAvailability: vi.fn(),
}));

const stockMocks = vi.hoisted(() => ({
  listStockItems: vi.fn(),
  createStockItem: vi.fn(),
  recordGoodsReceived: vi.fn(),
  listMenuItemComponents: vi.fn(),
  upsertMenuItemComponents: vi.fn(),
  updateStockItem: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks, stockApi: stockMocks };
});

const CATEGORY = { id: '1', name: 'Drinks', sort_order: 0, item_count: 0 };

function menuItem(overrides) {
  return { id: '5', name: 'Cocktail', category: 'Drinks', price: '20.00', cost_price: null, is_available: true, image_url: null, ...overrides };
}

function stockItem(overrides) {
  return { id: '30', name: 'Cocktail', unit: 'unit', purchase_cost: '4.00', supplier: 'Acme Beverages', reorder_level: '5.000', current_quantity: '12.000', ...overrides };
}

/** Every menu item resolves to "not linked" (zero recipe components) unless overridden. */
function mockNoLinks() {
  stockMocks.listMenuItemComponents.mockResolvedValue([]);
}

/**
 * Scoped to the Items DataTable's own <section> (Card), NOT the wrapping
 * div — that div also contains the Restock card as a permanent sibling,
 * whose own item picker renders a linked item's name a second time (as an
 * <option>), so scoping this loosely enough to include it makes a plain
 * `getByText(itemName)` ambiguous the moment an item has a real link.
 */
async function categoryHeading(name) {
  return (await screen.findByRole('heading', { name })).closest('section');
}

async function selectCategory(name) {
  await userEvent.click(await screen.findByRole('button', { name }));
}

describe('<MenuItemsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    Object.values(stockMocks).forEach((fn) => fn.mockReset());
    mocks.listMenuCategories.mockResolvedValue([CATEGORY]);
    mocks.listMenuItems.mockResolvedValue([]);
    stockMocks.listStockItems.mockResolvedValue([]);
    mockNoLinks();
  });

  function renderTab(props = {}) {
    return render(<MenuItemsTab activeProperty={{ base_currency: 'NGN' }} outletId="1" outletName="Main Bar" {...props} />);
  }

  describe('single-category selection', () => {
    it('auto-selects the first category on load', async () => {
      renderTab();
      expect(await screen.findByRole('heading', { name: /^Items — Drinks/ })).toBeInTheDocument();
    });

    it('clicking a different category swaps which section shows', async () => {
      mocks.listMenuCategories.mockResolvedValue([CATEGORY, { id: '2', name: 'Mains', sort_order: 1, item_count: 0 }]);
      renderTab();
      await screen.findByRole('heading', { name: /^Items — Drinks/ });

      await selectCategory('Mains');

      expect(screen.getByRole('heading', { name: /^Items — Mains/ })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /^Items — Drinks/ })).not.toBeInTheDocument();
    });

    it('the selected category row is visibly highlighted', async () => {
      mocks.listMenuCategories.mockResolvedValue([CATEGORY, { id: '2', name: 'Mains', sort_order: 1, item_count: 0 }]);
      renderTab();
      const drinksRow = (await screen.findByRole('button', { name: 'Drinks' })).closest('tr');
      await waitFor(() => expect(drinksRow.className).toMatch(/selectedRow/));
    });
  });

  it('lists a real item under its category, with a real linked stock item showing on-hand/reorder/cost/supplier', async () => {
    mocks.listMenuItems.mockResolvedValue([menuItem()]);
    stockMocks.listStockItems.mockResolvedValue([stockItem()]);
    stockMocks.listMenuItemComponents.mockResolvedValue([{ stock_item_id: '30', quantity: '1' }]);
    renderTab();

    const section = await categoryHeading(/^Items — Drinks/);
    expect(within(section).getByText('Cocktail')).toBeInTheDocument();
    expect(within(section).getByText(/12\.000 unit/)).toBeInTheDocument();
    expect(within(section).getByText(/5\.000 unit/)).toBeInTheDocument();
    expect(within(section).getByText('Acme Beverages')).toBeInTheDocument();
  });

  it('an item with no linked stock item shows "Not tracked", never a false zero', async () => {
    mocks.listMenuItems.mockResolvedValue([menuItem()]);
    renderTab();
    const section = await categoryHeading(/^Items — Drinks/);
    expect(within(section).getByText('Not tracked')).toBeInTheDocument();
    const row = (await within(section).findByText('Cocktail')).closest('tr');
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('a compound recipe (more than one component) shows "Compound recipe", not adopted as a simple link', async () => {
    mocks.listMenuItems.mockResolvedValue([menuItem()]);
    stockMocks.listMenuItemComponents.mockResolvedValue([
      { stock_item_id: '30', quantity: '1' },
      { stock_item_id: '31', quantity: '2' },
    ]);
    renderTab();
    expect(await screen.findByText('Compound recipe')).toBeInTheDocument();
  });

  describe('creating an item', () => {
    it('with no inventory fields creates only a sellable menu item — no stock item, no recipe', async () => {
      mocks.createMenuItem.mockResolvedValue(menuItem({ id: '7', name: 'Soda' }));
      renderTab();

      await userEvent.click(within(await categoryHeading(/^Items — Drinks/)).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — Drinks' }).closest('section');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Soda');
      await userEvent.type(within(addCard).getByLabelText('Selling price'), '5');
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      await waitFor(() => expect(mocks.createMenuItem).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1', name: 'Soda', category: 'Drinks', price: '5' })));
      expect(stockMocks.createStockItem).not.toHaveBeenCalled();
      expect(stockMocks.upsertMenuItemComponents).not.toHaveBeenCalled();
    });

    it('with inventory fields filled in creates the menu item, the stock item, records the initial delivery, and links a 1-quantity recipe — in that order', async () => {
      mocks.createMenuItem.mockResolvedValue(menuItem({ id: '7', name: 'Soda' }));
      stockMocks.createStockItem.mockResolvedValue(stockItem({ id: '40', name: 'Soda' }));
      renderTab();

      await userEvent.click(within(await categoryHeading(/^Items — Drinks/)).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — Drinks' }).closest('section');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Soda');
      await userEvent.type(within(addCard).getByLabelText('Selling price'), '5');
      await userEvent.type(within(addCard).getByLabelText('Qty supplied (optional)'), '24');
      await userEvent.type(within(addCard).getByLabelText('Reorder level (optional)'), '6');
      await userEvent.type(within(addCard).getByLabelText('Unit cost (optional)'), '2');
      await userEvent.type(within(addCard).getByLabelText('Supplier name (optional)'), 'Cola Co');
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      await waitFor(() => expect(stockMocks.upsertMenuItemComponents).toHaveBeenCalled());

      expect(mocks.createMenuItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'Soda', price: '5', costPrice: '2' }));
      expect(stockMocks.createStockItem).toHaveBeenCalledWith(
        expect.objectContaining({ outletId: '1', name: 'Soda', unit: 'unit', purchaseCost: '2', supplier: 'Cola Co', reorderLevel: '6' })
      );
      expect(stockMocks.recordGoodsReceived).toHaveBeenCalledWith(
        expect.objectContaining({ outletId: '1', reference: 'Initial stock', lines: [{ stockItemId: '40', quantity: '24', unitCost: '2' }] })
      );
      expect(stockMocks.upsertMenuItemComponents).toHaveBeenCalledWith('7', [{ stockItemId: '40', quantity: '1' }]);

      // Order matters: the menu item exists before the stock item is even requested.
      const menuCallOrder = mocks.createMenuItem.mock.invocationCallOrder[0];
      const stockCallOrder = stockMocks.createStockItem.mock.invocationCallOrder[0];
      expect(menuCallOrder).toBeLessThan(stockCallOrder);
    });

    it('rejects Qty supplied without a Unit cost before making any API call', async () => {
      renderTab();
      await userEvent.click(within(await categoryHeading(/^Items — Drinks/)).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — Drinks' }).closest('section');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Soda');
      await userEvent.type(within(addCard).getByLabelText('Selling price'), '5');
      await userEvent.type(within(addCard).getByLabelText('Qty supplied (optional)'), '24');
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      expect(await within(addCard).findByText('Unit cost is required to record the quantity supplied.')).toBeInTheDocument();
      expect(mocks.createMenuItem).not.toHaveBeenCalled();
    });

    it('a failed inventory setup step still leaves the item sellable, with an honest partial-failure message', async () => {
      mocks.createMenuItem.mockResolvedValue(menuItem({ id: '7', name: 'Soda' }));
      stockMocks.createStockItem.mockRejectedValue(new ApiError({ code: 'VALIDATION_DUPLICATE_NAME', message: 'A stock item with this name already exists.' }));
      renderTab();

      await userEvent.click(within(await categoryHeading(/^Items — Drinks/)).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — Drinks' }).closest('section');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Soda');
      await userEvent.type(within(addCard).getByLabelText('Selling price'), '5');
      await userEvent.type(within(addCard).getByLabelText('Reorder level (optional)'), '6');
      mocks.listMenuItems.mockResolvedValue([menuItem({ id: '7', name: 'Soda' })]);
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      expect(await within(addCard).findByText(/was added and is sellable in the Register, but inventory tracking could not be set up/)).toBeInTheDocument();
      // The reloaded item shows in the Items table itself, a sibling of
      // this still-open Add form, not inside the form.
      expect(await screen.findByText('Soda')).toBeInTheDocument();
    });

    it('says the item saved even when only its photo upload fails', async () => {
      mocks.createMenuItem.mockResolvedValue(menuItem({ id: '7', name: 'Chapman' }));
      mocks.uploadMenuItemImage.mockRejectedValue(new ApiError({ code: 'VALIDATION_INVALID_IMAGE', message: 'The photo must be a JPG, PNG, or WebP image.' }));
      renderTab();

      await userEvent.click(within(await categoryHeading(/^Items — Drinks/)).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — Drinks' }).closest('section');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Chapman');
      await userEvent.type(within(addCard).getByLabelText('Selling price'), '15');
      const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'chapman.png', { type: 'image/png' });
      await userEvent.upload(within(addCard).getByLabelText('Item image (optional)'), file);
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      expect(await within(addCard).findByText(/its photo was not/)).toBeInTheDocument();
      // The form is cleared, so pressing "Add item" again cannot create a duplicate.
      expect(within(addCard).getByLabelText('Name')).toHaveValue('');
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));
      expect(mocks.createMenuItem).toHaveBeenCalledTimes(1);
    });

    it('refuses an oversized photo before saving anything', async () => {
      renderTab();
      await userEvent.click(within(await categoryHeading(/^Items — Drinks/)).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — Drinks' }).closest('section');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Chapman');
      await userEvent.type(within(addCard).getByLabelText('Selling price'), '15');
      const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' });
      await userEvent.upload(within(addCard).getByLabelText('Item image (optional)'), big);
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      expect(await screen.findByText('The photo must be 2 MB or smaller.')).toBeInTheDocument();
      expect(mocks.createMenuItem).not.toHaveBeenCalled();
    });
  });

  describe('editing an item', () => {
    it('pre-fills the menu item fields, and the linked stock item\'s own reorder level/supplier, saving both', async () => {
      mocks.listMenuItems.mockResolvedValue([menuItem()]);
      stockMocks.listStockItems.mockResolvedValue([stockItem()]);
      stockMocks.listMenuItemComponents.mockResolvedValue([{ stock_item_id: '30', quantity: '1' }]);
      mocks.updateMenuItem.mockResolvedValue(menuItem({ price: '22.00' }));
      renderTab();

      const row = (await within(await categoryHeading(/^Items — Drinks/)).findByText('Cocktail')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      const editCard = screen.getByRole('heading', { name: 'Edit — Cocktail' }).closest('section');

      expect(within(editCard).getByLabelText('Selling price')).toHaveValue(20);
      expect(within(editCard).getByLabelText('Reorder level')).toHaveValue(5);
      expect(within(editCard).getByLabelText('Supplier name')).toHaveValue('Acme Beverages');

      const priceInput = within(editCard).getByLabelText('Selling price');
      await userEvent.clear(priceInput);
      await userEvent.type(priceInput, '22');
      await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(mocks.updateMenuItem).toHaveBeenCalledWith('5', expect.objectContaining({ price: '22' })));
      expect(stockMocks.updateStockItem).toHaveBeenCalledWith('30', { supplier: 'Acme Beverages', reorderLevel: '5.000' });
    });

    it('an item with no linked stock item has no reorder level/supplier fields to edit', async () => {
      mocks.listMenuItems.mockResolvedValue([menuItem()]);
      renderTab();
      const row = (await screen.findByText('Cocktail')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      const editCard = screen.getByRole('heading', { name: 'Edit — Cocktail' }).closest('section');

      expect(within(editCard).queryByLabelText('Reorder level')).not.toBeInTheDocument();
      expect(within(editCard).queryByLabelText('Supplier name')).not.toBeInTheDocument();
      expect(stockMocks.updateStockItem).not.toHaveBeenCalled();
    });

    it('keeps an item\'s current category selectable when editing, even if it is no longer registered', async () => {
      mocks.listMenuItems.mockResolvedValue([menuItem({ category: 'Legacy' })]);
      renderTab();
      // "Legacy" isn't a registered category, so this item lands in its
      // own defensive "archived category" section — not the default-
      // selected "Drinks" — matching `StockItemsTab.jsx`'s own identical
      // precedent for this edge case.
      await selectCategory('Legacy (archived category)');
      const row = (await screen.findByText('Cocktail')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      const editCard = screen.getByRole('heading', { name: 'Edit — Cocktail' }).closest('section');
      const select = within(editCard).getByLabelText('Category');
      expect(select).toHaveValue('Legacy');
      expect([...select.options].map((o) => o.textContent)).toEqual(['Drinks', 'Legacy']);
    });
  });

  describe('setting cost prices for every item', () => {
    it('keeps the cost-price table out of the way until asked for, then edits and saves an untracked item\'s cost price and reloads', async () => {
      mocks.listMenuItems.mockResolvedValue([menuItem({ id: '5', name: 'Plain snack' })]);
      mocks.updateMenuItem.mockResolvedValue({});
      renderTab();
      await screen.findByText('Plain snack');
      expect(screen.queryByRole('heading', { name: 'Cost prices' })).not.toBeInTheDocument();

      await userEvent.click(await screen.findByRole('button', { name: 'Set cost prices for all items' }));
      expect(await screen.findByRole('heading', { name: 'Cost prices' })).toBeInTheDocument();

      await userEvent.type(screen.getByLabelText('Cost price for Plain snack'), '6');
      const callsBefore = mocks.listMenuItems.mock.calls.length;
      await userEvent.click(screen.getByRole('button', { name: 'Save 1 cost price' }));

      await waitFor(() => expect(mocks.updateMenuItem).toHaveBeenCalledWith('5', { cost_price: '6' }));
      await waitFor(() => expect(mocks.listMenuItems.mock.calls.length).toBeGreaterThan(callsBefore));

      await userEvent.click(screen.getByRole('button', { name: 'Hide cost prices' }));
      expect(screen.queryByRole('heading', { name: 'Cost prices' })).not.toBeInTheDocument();
    });

    it('does not offer a cost-price input to an item that is sold from stock — its stock cost is used', async () => {
      mocks.listMenuItems.mockResolvedValue([menuItem({ id: '5', name: 'Bottled beer' })]);
      stockMocks.listMenuItemComponents.mockResolvedValue([{ stock_item_id: '30', quantity: '1.000' }]);
      stockMocks.listStockItems.mockResolvedValue([stockItem({ id: '30', name: 'Bottled beer' })]);
      renderTab();
      await userEvent.click(await screen.findByRole('button', { name: 'Set cost prices for all items' }));

      await screen.findByRole('heading', { name: 'Cost prices' });
      expect(screen.queryByLabelText('Cost price for Bottled beer')).not.toBeInTheDocument();
      expect(screen.getByText('From stock')).toBeInTheDocument();
    });
  });

  it('toggles a menu item stock-out state', async () => {
    mocks.listMenuItems.mockResolvedValue([menuItem()]);
    mocks.setMenuItemAvailability.mockResolvedValue({});
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Mark stocked out' }));
    expect(mocks.setMenuItemAvailability).toHaveBeenCalledWith('5', false);
  });

  describe('restock', () => {
    it('shows a message instead of a form when nothing in the category is stock-tracked', async () => {
      mocks.listMenuItems.mockResolvedValue([menuItem()]);
      renderTab();
      const restockCard = (await screen.findByRole('heading', { name: 'Restock — Drinks' })).closest('section');
      expect(within(restockCard).getByText(/No stock-tracked items in this category yet/)).toBeInTheDocument();
    });

    it('offers only linked items, and records a real delivery against the correct stock item', async () => {
      mocks.listMenuItems.mockResolvedValue([menuItem(), menuItem({ id: '6', name: 'Mocktail', category: 'Drinks' })]);
      stockMocks.listStockItems.mockResolvedValue([stockItem()]);
      stockMocks.listMenuItemComponents.mockImplementation((menuItemId) =>
        Promise.resolve(menuItemId === '5' ? [{ stock_item_id: '30', quantity: '1' }] : [])
      );
      stockMocks.recordGoodsReceived.mockResolvedValue({});
      renderTab();

      const restockCard = (await screen.findByRole('heading', { name: 'Restock — Drinks' })).closest('section');
      const select = await within(restockCard).findByLabelText('Item');
      expect([...select.options].map((o) => o.textContent)).toEqual(['Select an item', 'Cocktail']);

      await selectWhenLoaded('Item', 'Cocktail');
      await userEvent.type(within(restockCard).getByLabelText('Quantity'), '10');
      await userEvent.type(within(restockCard).getByLabelText('Unit cost'), '4.5');
      await userEvent.type(within(restockCard).getByLabelText('Reference (optional)'), 'DN-1');
      await userEvent.click(within(restockCard).getByRole('button', { name: 'Record stock' }));

      await waitFor(() =>
        expect(stockMocks.recordGoodsReceived).toHaveBeenCalledWith({
          outletId: '1',
          reference: 'DN-1',
          lines: [{ stockItemId: '30', quantity: '10', unitCost: '4.5' }],
        })
      );
      expect(await within(restockCard).findByText('Stock recorded.')).toBeInTheDocument();
    });

    it('surfaces a real backend error without losing the form', async () => {
      mocks.listMenuItems.mockResolvedValue([menuItem()]);
      stockMocks.listStockItems.mockResolvedValue([stockItem()]);
      stockMocks.listMenuItemComponents.mockResolvedValue([{ stock_item_id: '30', quantity: '1' }]);
      stockMocks.recordGoodsReceived.mockRejectedValue(new ApiError({ code: 'VALIDATION_INVALID_AMOUNT', message: 'Quantity must be positive.' }));
      renderTab();

      const restockCard = (await screen.findByRole('heading', { name: 'Restock — Drinks' })).closest('section');
      await selectWhenLoaded('Item', 'Cocktail');
      await userEvent.type(within(restockCard).getByLabelText('Quantity'), '10');
      await userEvent.type(within(restockCard).getByLabelText('Unit cost'), '4.5');
      await userEvent.click(within(restockCard).getByRole('button', { name: 'Record stock' }));

      expect(await within(restockCard).findByText('Quantity must be positive.')).toBeInTheDocument();
    });
  });

  describe('menu categories', () => {
    it('registers a new category from the Menu categories card', async () => {
      mocks.createMenuCategory.mockResolvedValue({ id: '3', name: 'Starters' });
      renderTab();
      const card = (await screen.findByRole('heading', { name: 'Menu categories' })).closest('section');

      await userEvent.type(within(card).getByLabelText('Category name'), 'Starters');
      mocks.listMenuCategories.mockResolvedValue([CATEGORY, { id: '3', name: 'Starters', sort_order: 0, item_count: 0 }]);
      await userEvent.click(within(card).getByRole('button', { name: 'Add category' }));

      expect(mocks.createMenuCategory).toHaveBeenCalledWith({ name: 'Starters', sortOrder: undefined });
      expect(await within(card).findByText('Starters')).toBeInTheDocument();
    });

    it('shows why a category still in use cannot be archived', async () => {
      mocks.archiveMenuCategory.mockRejectedValue(
        new ApiError({ code: 'CONFLICT_POS_MENU_CATEGORY_IN_USE', message: '"Drinks" is still used by 1 menu item — move them to another category first.' })
      );
      renderTab();
      const card = (await screen.findByRole('heading', { name: 'Menu categories' })).closest('section');
      await userEvent.click(within(card).getByRole('button', { name: 'Archive' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));

      expect(await within(card).findByText(/still used by 1 menu item/)).toBeInTheDocument();
    });
  });

  it('disables every mutating control while offline', async () => {
    mocks.listMenuItems.mockResolvedValue([menuItem()]);
    renderTab({ isOffline: true });
    const row = (await screen.findByText('Cocktail')).closest('tr');

    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Mark stocked out' })).toBeDisabled();
  });

  it('a create attempt without pos.manage surfaces the real backend 403 — no client-side check hides the button', async () => {
    mocks.createMenuItem.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission to perform this action.' }));
    renderTab();

    const addToggle = within(await categoryHeading(/^Items — Drinks/)).getByRole('button', { name: 'Add item' });
    expect(addToggle).toBeEnabled();
    await userEvent.click(addToggle);
    const addCard = screen.getByRole('heading', { name: 'Add item — Drinks' }).closest('section');
    await userEvent.type(within(addCard).getByLabelText('Name'), 'Soda');
    await userEvent.type(within(addCard).getByLabelText('Selling price'), '5');
    await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

    expect(await within(addCard).findByText('You do not have permission to perform this action.')).toBeInTheDocument();
  });
});
