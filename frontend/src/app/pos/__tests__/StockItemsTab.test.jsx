import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockItemsTab } from '../StockItemsTab.jsx';
import { ApiError } from '../../../shared/api/index.js';
import { selectWhenLoaded } from './selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
  createStockItem: vi.fn(),
  updateStockItem: vi.fn(),
  archiveStockItem: vi.fn(),
  recordGoodsReceived: vi.fn(),
  listStockItemCategories: vi.fn(),
  createStockItemCategory: vi.fn(),
  updateStockItemCategory: vi.fn(),
  archiveStockItemCategory: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets },
    stockApi: {
      listStockItems: mocks.listStockItems,
      createStockItem: mocks.createStockItem,
      updateStockItem: mocks.updateStockItem,
      archiveStockItem: mocks.archiveStockItem,
      recordGoodsReceived: mocks.recordGoodsReceived,
      listStockItemCategories: mocks.listStockItemCategories,
      createStockItemCategory: mocks.createStockItemCategory,
      updateStockItemCategory: mocks.updateStockItemCategory,
      archiveStockItemCategory: mocks.archiveStockItemCategory,
    },
  };
});

function outlet(overrides) {
  return { id: '1', name: 'Main Bar', ...overrides };
}

/** Defaults into the "Beverages" section — the one category `beforeEach` always registers — so most tests need no override at all. */
function item(overrides) {
  return {
    id: '9',
    outlet_id: '1',
    name: 'Vodka',
    unit: 'ml',
    category: 'Beverages',
    current_quantity: '100.000',
    reorder_level: '20.000',
    purchase_cost: '5.00',
    supplier: 'Acme Beverages',
    ...overrides,
  };
}

/**
 * The whole category block — the DataTable/Card's own <section> PLUS any
 * open Add/Edit/Receive panel for it, which render as siblings after it
 * inside the same wrapping <div> (see `StockItemsTab.jsx`'s own
 * `.categorySection` comment for why a <div>, not a <section>, is the
 * right scoping target). Async — the block only exists once BOTH the
 * categories and items fetches (two independent async effects) resolve
 * AND `name` is the currently-selected category (the screen shows exactly
 * one section's own block at a time — see `selectCategory` below).
 */
async function categoryBlock(name) {
  return (await screen.findByRole('heading', { name })).closest('div');
}

/**
 * Clicks a category's own row in the "Stock categories" list at the top of
 * the screen — its name is a real clickable button once row-selection is
 * on (always, on this screen) — to make it the one section shown below.
 * Works identically for a real category, "Uncategorized", or an
 * archived-but-still-referenced category's own pseudo-row, since all three
 * render as an identically-named button in that same list.
 */
async function selectCategory(name) {
  await userEvent.click(await screen.findByRole('button', { name }));
}

describe('<StockItemsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([outlet()]);
    mocks.listStockItemCategories.mockResolvedValue([{ id: '1', name: 'Beverages', sort_order: 0, item_count: 0 }]);
    mocks.listStockItems.mockResolvedValue([]);
  });

  describe('single-category selection', () => {
    it('auto-selects the first category on load, with no click needed', async () => {
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      expect(await screen.findByRole('heading', { name: 'Beverages' })).toBeInTheDocument();
      // Only the selected section's own items card is shown — no other
      // category's card exists in the document at the same time.
      expect(screen.queryByRole('heading', { name: 'Uncategorized' })).not.toBeInTheDocument();
    });

    it('clicking a different category in the list swaps which section shows below it', async () => {
      mocks.listStockItemCategories.mockResolvedValue([
        { id: '1', name: 'Beverages', sort_order: 0, item_count: 0 },
        { id: '2', name: 'Cleaning supplies', sort_order: 1, item_count: 0 },
      ]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      await screen.findByRole('heading', { name: 'Beverages' });

      await selectCategory('Cleaning supplies');

      expect(screen.getByRole('heading', { name: 'Cleaning supplies' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Beverages' })).not.toBeInTheDocument();
    });

    it('the selected category row is visibly highlighted in the list, and only that one', async () => {
      mocks.listStockItemCategories.mockResolvedValue([
        { id: '1', name: 'Beverages', sort_order: 0, item_count: 0 },
        { id: '2', name: 'Cleaning supplies', sort_order: 1, item_count: 0 },
      ]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const beveragesRow = (await screen.findByRole('button', { name: 'Beverages' })).closest('tr');
      const cleaningRow = screen.getByRole('button', { name: 'Cleaning supplies' }).closest('tr');
      // The default-selection effect applies the class in a re-render
      // AFTER the row itself first appears — poll rather than assert
      // immediately.
      await waitFor(() => expect(beveragesRow.className).toMatch(/selectedRow/));
      expect(cleaningRow.className).not.toMatch(/selectedRow/);

      await selectCategory('Cleaning supplies');

      await waitFor(() => expect(cleaningRow.className).toMatch(/selectedRow/));
      expect(beveragesRow.className).not.toMatch(/selectedRow/);
    });

    it('"Uncategorized" is a selectable row in the very same categories list, right alongside the real categories', async () => {
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const card = (await screen.findByRole('heading', { name: 'Stock categories' })).closest('section');
      // Present as a row from the very first render — never conditional on
      // whether it currently holds any items.
      const uncategorizedButton = within(card).getByRole('button', { name: 'Uncategorized' });
      // Unlike a real category's row, it carries no Edit/Archive of its own.
      expect(uncategorizedButton.closest('tr').textContent).not.toMatch(/Edit|Archive/);

      await userEvent.click(uncategorizedButton);
      expect(await screen.findByRole('heading', { name: 'Uncategorized' })).toBeInTheDocument();
    });
  });

  it('lists real stock items grouped under their own category section, with quantity+unit and cost, never running quantity through the money formatter', async () => {
    mocks.listStockItems.mockResolvedValue([item()]);
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

    const section = await categoryBlock('Beverages');
    expect(within(section).getByText('Vodka')).toBeInTheDocument();
    expect(within(section).getByText('100.000 ml')).toBeInTheDocument();
    expect(within(section).getByText('20.000 ml')).toBeInTheDocument();
    expect(within(section).getByText(/5\.00/)).toBeInTheDocument();
    expect(within(section).getByText('Acme Beverages')).toBeInTheDocument();
  });

  it("bug fix: renders the active property's real currency, not a hardcoded NGN", async () => {
    mocks.listStockItems.mockResolvedValue([item()]);
    render(<StockItemsTab activeProperty={{ base_currency: 'KES' }} />);

    // KES formats as "Ksh" via Intl (confirmed directly against the real
    // Intl.NumberFormat output) — proves the currency actually threaded
    // through, not just that the component happened to still say "NGN".
    expect(await screen.findByText(/Ksh/)).toBeInTheDocument();
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument();
  });

  it('shows a real backend error when the list fails to load', async () => {
    mocks.listStockItems.mockRejectedValue(new Error('boom'));
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    expect(await screen.findByText('Could not load stock items.')).toBeInTheDocument();
  });

  it('the outlet filter, low-stock toggle, and the selected category\'s own "Add item" action stay reachable even when the list is genuinely empty — never hidden inside a state-gated table', async () => {
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

    await screen.findByText('No items yet — add the first one below.');
    expect(screen.getByLabelText('Filter by outlet')).toBeInTheDocument();
    expect(screen.getByLabelText('Low stock only')).toBeInTheDocument();
    // The default-selected category (Beverages) has it...
    expect(within(await categoryBlock('Beverages')).getByRole('button', { name: 'Add item' })).toBeInTheDocument();
    // ...and switching to the other always-empty section (Uncategorized)
    // still has it too, even though it held nothing on the previous click.
    await selectCategory('Uncategorized');
    expect(within(await categoryBlock('Uncategorized')).getByRole('button', { name: 'Add item' })).toBeInTheDocument();
  });

  it('low-stock filtering calls the real endpoint with low_stock requested', async () => {
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    await waitFor(() => expect(mocks.listStockItems).toHaveBeenCalledWith({ outletId: undefined, lowStockOnly: false }));

    await userEvent.click(screen.getByLabelText('Low stock only'));
    await waitFor(() => expect(mocks.listStockItems).toHaveBeenCalledWith({ outletId: undefined, lowStockOnly: true }));
  });

  describe('creating an item directly inside a category — the category is implied, never a dropdown to pick from', () => {
    it('opens the add form under the clicked category, with no category field anywhere on it, and creates the item pre-filled to that category', async () => {
      mocks.createStockItem.mockResolvedValue(item());
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

      await userEvent.click(within(await categoryBlock('Beverages')).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — Beverages' }).closest('section');
      expect(within(addCard).queryByLabelText(/category/i)).not.toBeInTheDocument();

      await selectWhenLoaded('Outlet', '1');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Vodka');
      await userEvent.type(within(addCard).getByLabelText('Unit'), 'ml');
      await userEvent.type(within(addCard).getByLabelText('Reorder level (optional)'), '20');
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      expect(mocks.createStockItem).toHaveBeenCalledWith(
        expect.objectContaining({ outletId: '1', name: 'Vodka', unit: 'ml', category: 'Beverages', reorderLevel: '20' })
      );
    });

    it('adding from the Uncategorized section creates the item with no category at all — still no dropdown', async () => {
      mocks.createStockItem.mockResolvedValue(item({ category: null }));
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      await selectCategory('Uncategorized');

      await userEvent.click(within(await categoryBlock('Uncategorized')).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — Uncategorized' }).closest('section');
      expect(within(addCard).queryByLabelText(/category/i)).not.toBeInTheDocument();

      await selectWhenLoaded('Outlet', '1');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Ice');
      await userEvent.type(within(addCard).getByLabelText('Unit'), 'kg');
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      expect(mocks.createStockItem).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1', name: 'Ice', unit: 'kg' }));
      expect(mocks.createStockItem.mock.calls[0][0].category).toBeUndefined();
    });

    it('the add panel closes on Cancel without submitting', async () => {
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      await userEvent.click(within(await categoryBlock('Beverages')).getByRole('button', { name: 'Add item' }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('heading', { name: 'Add item — Beverages' })).not.toBeInTheDocument();
      expect(within(await categoryBlock('Beverages')).getByRole('button', { name: 'Add item' })).toBeInTheDocument();
      expect(mocks.createStockItem).not.toHaveBeenCalled();
    });

    /**
     * Bug fix, user-reported: with three real categories present, an item
     * added from the second or third category's own "+ Add item" button
     * silently landed in the first one instead — a symptom no earlier test
     * here could have caught, since every prior test in this describe block
     * only ever registered exactly one real category. Each button was
     * always correctly wired to its own section (`openAdd(section)` closes
     * over that iteration's own `section`, and `handleAddSubmit` re-reads
     * the category from the CURRENT section matching `activePanel.sectionKey`
     * — never a stale/shared reference), so the actual defect was the CSS
     * fix below this block: with no visual boundary around a category's own
     * block, the trigger button for one category sat in the same
     * undifferentiated gap as the boundary before the next category's own
     * card, making it easy to click the wrong one. These tests lock in the
     * correct ROUTING regardless; the containment test right after locks in
     * the visual fix.
     */
    it('adding from the second of three categories sends that category, not the first', async () => {
      mocks.listStockItemCategories.mockResolvedValue([
        { id: '1', name: 'FRUITS', sort_order: 0, item_count: 0 },
        { id: '2', name: 'SOUP', sort_order: 1, item_count: 0 },
        { id: '3', name: 'DRINKS', sort_order: 2, item_count: 0 },
      ]);
      mocks.createStockItem.mockResolvedValue(item({ category: 'SOUP' }));
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      await selectCategory('SOUP');

      await userEvent.click(within(await categoryBlock('SOUP')).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — SOUP' }).closest('section');

      await selectWhenLoaded('Outlet', '1');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Chicken Broth');
      await userEvent.type(within(addCard).getByLabelText('Unit'), 'l');
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      expect(mocks.createStockItem).toHaveBeenCalledWith(expect.objectContaining({ category: 'SOUP' }));
    });

    it('adding from the third of three categories sends that category, not the first', async () => {
      mocks.listStockItemCategories.mockResolvedValue([
        { id: '1', name: 'FRUITS', sort_order: 0, item_count: 0 },
        { id: '2', name: 'SOUP', sort_order: 1, item_count: 0 },
        { id: '3', name: 'DRINKS', sort_order: 2, item_count: 0 },
      ]);
      mocks.createStockItem.mockResolvedValue(item({ category: 'DRINKS' }));
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      await selectCategory('DRINKS');

      await userEvent.click(within(await categoryBlock('DRINKS')).getByRole('button', { name: 'Add item' }));
      const addCard = screen.getByRole('heading', { name: 'Add item — DRINKS' }).closest('section');

      await selectWhenLoaded('Outlet', '1');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Cola');
      await userEvent.type(within(addCard).getByLabelText('Unit'), 'bottle');
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      expect(mocks.createStockItem).toHaveBeenCalledWith(expect.objectContaining({ category: 'DRINKS' }));
    });

    it("the selected category's own \"Add item\" trigger renders INSIDE that category's own bordered card (as DataTable's `footer`), whether it currently holds items or not — the original bug this locks in was the button landing in the wrong category entirely, which single-section selection now makes structurally impossible (only one category's card exists at a time)", async () => {
      mocks.listStockItemCategories.mockResolvedValue([
        { id: '1', name: 'FRUITS', sort_order: 0, item_count: 0 },
        { id: '2', name: 'SOUP', sort_order: 1, item_count: 0 },
      ]);
      mocks.listStockItems.mockResolvedValue([item({ category: 'FRUITS' })]); // FRUITS non-empty, SOUP empty
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

      // FRUITS (default-selected, non-empty/success state) — the button
      // sits inside the same <section> (Card) as the table, via
      // DataTable's `footer` slot.
      const fruitsCard = (await screen.findByRole('heading', { name: 'FRUITS' })).closest('section');
      expect(within(fruitsCard).getByRole('button', { name: 'Add item' })).toBeInTheDocument();

      // SOUP (empty state, once selected) — the same button, now via
      // `emptyAction`, still inside the same <section>, directly under
      // "add the first one below".
      await selectCategory('SOUP');
      const soupCard = screen.getByRole('heading', { name: 'SOUP' }).closest('section');
      expect(within(soupCard).getByText('No items yet — add the first one below.')).toBeInTheDocument();
      expect(within(soupCard).getByRole('button', { name: 'Add item' })).toBeInTheDocument();
    });
  });

  describe('a category with zero items', () => {
    it('still shows as its own section, empty, with its own working "Add item" action', async () => {
      mocks.listStockItemCategories.mockResolvedValue([
        { id: '1', name: 'Beverages', sort_order: 0, item_count: 0 },
        { id: '2', name: 'Cleaning supplies', sort_order: 1, item_count: 0 },
      ]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      await selectCategory('Cleaning supplies');

      const section = await categoryBlock('Cleaning supplies');
      expect(within(section).getByText('No items yet — add the first one below.')).toBeInTheDocument();
      expect(within(section).getByRole('button', { name: 'Add item' })).toBeEnabled();
    });
  });

  describe('items with no category', () => {
    it('render under a permanent "Uncategorized" section, reachable even though the default-selected category renders correctly empty first', async () => {
      mocks.listStockItems.mockResolvedValue([item({ id: '10', name: 'Ice', category: null })]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

      // Beverages (default-selected) correctly renders empty — the one
      // stock item that exists is Uncategorized, not in it.
      expect(within(await categoryBlock('Beverages')).getByText('No items yet — add the first one below.')).toBeInTheDocument();

      await selectCategory('Uncategorized');
      expect(within(await categoryBlock('Uncategorized')).getByText('Ice')).toBeInTheDocument();
    });

    it('the "Uncategorized" row itself never disappears from the categories list, even with zero uncategorized items', async () => {
      mocks.listStockItems.mockResolvedValue([item()]); // categorized item only
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const card = (await screen.findByRole('heading', { name: 'Stock categories' })).closest('section');
      expect(within(card).getByRole('button', { name: 'Uncategorized' })).toBeInTheDocument();
    });
  });

  it('an item whose own category has since been archived still renders, under a clearly-labelled section with no "Add item" action', async () => {
    mocks.listStockItemCategories.mockResolvedValue([{ id: '1', name: 'Beverages', sort_order: 0, item_count: 0 }]);
    mocks.listStockItems.mockResolvedValue([item({ category: 'Discontinued Line' })]);
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    await selectCategory('Discontinued Line (archived category)');

    const section = await categoryBlock('Discontinued Line (archived category)');
    expect(within(section).getByText('Vodka')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument();
  });

  describe('the "Receive" quick action — records a real goods-received movement, never a direct edit of current_quantity', () => {
    it('submits the exact same recordGoodsReceived shape the bulk Goods received tab uses, with a single-line array', async () => {
      mocks.listStockItems.mockResolvedValue([item()]);
      mocks.recordGoodsReceived.mockResolvedValue({ outletId: '1', count: 1, items: [item({ current_quantity: '110.000' })] });
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const row = (await screen.findByText('Vodka')).closest('tr');

      await userEvent.click(within(row).getByRole('button', { name: 'Receive' }));
      const receiveCard = screen.getByRole('heading', { name: 'Receive stock — Vodka' }).closest('section');

      await userEvent.type(within(receiveCard).getByLabelText('Quantity'), '10');
      await userEvent.type(within(receiveCard).getByLabelText('Unit cost'), '5.00');
      await userEvent.type(within(receiveCard).getByLabelText('Reference (optional)'), 'DN-77');
      // The screen reloads the real list after a successful receive — give
      // it the genuinely updated quantity to fetch, the same way every
      // other post-mutation reload test in this file does.
      mocks.listStockItems.mockResolvedValue([item({ current_quantity: '110.000' })]);
      await userEvent.click(within(receiveCard).getByRole('button', { name: 'Receive stock' }));

      expect(mocks.recordGoodsReceived).toHaveBeenCalledWith({
        outletId: '1',
        reference: 'DN-77',
        // A real, native <input type="number"> quirk (matching
        // `StockGoodsReceivedTab.test.jsx`'s own documented behavior):
        // jsdom normalizes "5.00" typed into a number field down to "5".
        lines: [{ stockItemId: '9', quantity: '10', unitCost: '5' }],
      });
      expect(await screen.findByText('110.000 ml')).toBeInTheDocument();
    });

    it('surfaces a real backend error and never closes the panel on failure', async () => {
      mocks.listStockItems.mockResolvedValue([item()]);
      mocks.recordGoodsReceived.mockRejectedValue(new ApiError({ code: 'VALIDATION_STOCK_ITEM_OUTLET_MISMATCH', message: 'The stock item does not belong to the specified outlet.' }));
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const row = (await screen.findByText('Vodka')).closest('tr');

      await userEvent.click(within(row).getByRole('button', { name: 'Receive' }));
      const receiveCard = screen.getByRole('heading', { name: 'Receive stock — Vodka' }).closest('section');
      await userEvent.type(within(receiveCard).getByLabelText('Quantity'), '10');
      await userEvent.type(within(receiveCard).getByLabelText('Unit cost'), '5');
      await userEvent.click(within(receiveCard).getByRole('button', { name: 'Receive stock' }));

      expect(await within(receiveCard).findByText('The stock item does not belong to the specified outlet.')).toBeInTheDocument();
    });

    it('Cancel closes the receive panel without submitting', async () => {
      mocks.listStockItems.mockResolvedValue([item()]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const row = (await screen.findByText('Vodka')).closest('tr');

      await userEvent.click(within(row).getByRole('button', { name: 'Receive' }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('heading', { name: 'Receive stock — Vodka' })).not.toBeInTheDocument();
      expect(mocks.recordGoodsReceived).not.toHaveBeenCalled();
    });
  });

  describe('the two-tier stock indicator', () => {
    it('shows no pill at all for an item comfortably above its reorder level', async () => {
      mocks.listStockItems.mockResolvedValue([item({ current_quantity: '100.000', reorder_level: '20.000' })]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      await screen.findByText('Vodka');

      expect(screen.queryByText('Low stock')).not.toBeInTheDocument();
      expect(screen.queryByText('Out of stock')).not.toBeInTheDocument();
    });

    it('the boundary itself counts as low stock: on-hand exactly equal to the reorder level shows the warning pill', async () => {
      mocks.listStockItems.mockResolvedValue([item({ current_quantity: '20.000', reorder_level: '20.000' })]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

      expect(await screen.findByText('Low stock')).toBeInTheDocument();
      expect(screen.queryByText('Out of stock')).not.toBeInTheDocument();
    });

    it('shows a "Low stock" warning pill once on-hand is at or below the reorder level, but still above zero', async () => {
      mocks.listStockItems.mockResolvedValue([item({ current_quantity: '15.000', reorder_level: '20.000' })]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

      expect(await screen.findByText('Low stock')).toBeInTheDocument();
      expect(screen.queryByText('Out of stock')).not.toBeInTheDocument();
      // The real number is always shown too — never colour/a pill alone.
      expect(screen.getByText('15.000 ml')).toBeInTheDocument();
    });

    it('shows an "Out of stock" danger pill, not "Low stock", once on-hand is at or below zero', async () => {
      mocks.listStockItems.mockResolvedValue([item({ current_quantity: '0.000', reorder_level: '20.000' })]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

      expect(await screen.findByText('Out of stock')).toBeInTheDocument();
      expect(screen.queryByText('Low stock')).not.toBeInTheDocument();
    });

    it('a genuinely negative on-hand quantity (a real, tolerated race elsewhere in this module) still reads as "Out of stock", not a crash', async () => {
      mocks.listStockItems.mockResolvedValue([item({ current_quantity: '-5.000', reorder_level: '20.000' })]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      expect(await screen.findByText('Out of stock')).toBeInTheDocument();
    });
  });

  describe('code-review fixes: an open panel never submits or displays stale data', () => {
    it('renaming a category while its own Add panel is still open submits the NEW name, not the one frozen when the panel opened', async () => {
      mocks.createStockItem.mockResolvedValue(item());
      mocks.updateStockItemCategory.mockResolvedValue({ id: '1', name: 'Drinks' });
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

      await userEvent.click(within(await categoryBlock('Beverages')).getByRole('button', { name: 'Add item' }));
      screen.getByRole('heading', { name: 'Add item — Beverages' });

      // Rename the category via the Stock categories card, WITHOUT closing
      // the Add panel that's still open underneath it.
      const categoriesCard = screen.getByRole('heading', { name: 'Stock categories' }).closest('section');
      await userEvent.click(within(categoriesCard).getByRole('button', { name: 'Edit' }));
      const renameInput = within(categoriesCard).getByLabelText('Rename category');
      await userEvent.clear(renameInput);
      await userEvent.type(renameInput, 'Drinks');
      mocks.listStockItemCategories.mockResolvedValue([{ id: '1', name: 'Drinks', sort_order: 0, item_count: 0 }]);
      await userEvent.click(within(categoriesCard).getByRole('button', { name: 'Save category' }));

      // The Add panel's own heading follows the rename...
      const addCard = (await screen.findByRole('heading', { name: 'Add item — Drinks' })).closest('section');

      await selectWhenLoaded('Outlet', '1');
      await userEvent.type(within(addCard).getByLabelText('Name'), 'Vodka');
      await userEvent.type(within(addCard).getByLabelText('Unit'), 'ml');
      await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

      // ...and so does what actually gets submitted — never the stale
      // "Beverages" name frozen at the moment the panel was first opened.
      expect(mocks.createStockItem).toHaveBeenCalledWith(expect.objectContaining({ category: 'Drinks' }));
    });

    it('changing the outlet filter closes any open Edit/Receive panel rather than leaving it pointing at a now-hidden item', async () => {
      mocks.listStockItems.mockResolvedValue([item()]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const row = (await screen.findByText('Vodka')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      expect(screen.getByRole('heading', { name: 'Edit — Vodka' })).toBeInTheDocument();

      await userEvent.selectOptions(screen.getByLabelText('Filter by outlet'), '1');

      expect(screen.queryByRole('heading', { name: 'Edit — Vodka' })).not.toBeInTheDocument();
    });

    it('the read-only cost/on-hand hints on an open Edit panel refresh from a background reload rather than staying frozen', async () => {
      mocks.listStockItems.mockResolvedValue([item({ current_quantity: '100.000', purchase_cost: '5.00' })]);
      mocks.createStockItemCategory.mockResolvedValue({ id: '2', name: 'Wine' });
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const row = (await screen.findByText('Vodka')).closest('tr');
      await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
      const editCard = screen.getByRole('heading', { name: 'Edit — Vodka' }).closest('section');
      expect(within(editCard).getByText(/100\.000 ml/)).toBeInTheDocument();

      // A totally unrelated action elsewhere on the same screen
      // (registering a new category) triggers a real background reload of
      // items too (`handleCategoriesChanged`) — the delivery this
      // represents genuinely happened server-side in the meantime.
      mocks.listStockItems.mockResolvedValue([item({ current_quantity: '90.000', purchase_cost: '5.00' })]);
      const categoriesCard = screen.getByRole('heading', { name: 'Stock categories' }).closest('section');
      await userEvent.type(within(categoriesCard).getByLabelText('Category name'), 'Wine');
      await userEvent.click(within(categoriesCard).getByRole('button', { name: 'Add category' }));

      expect(await within(editCard).findByText(/90\.000 ml/)).toBeInTheDocument();
    });
  });

  it('editing prefills the real values and never shows an editable cost field — cost is read-only', async () => {
    mocks.listStockItems.mockResolvedValue([item()]);
    mocks.updateStockItem.mockResolvedValue(item({ name: 'Premium Vodka' }));
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    const row = (await screen.findByText('Vodka')).closest('tr');

    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const editCard = screen.getByRole('heading', { name: 'Edit — Vodka' }).closest('section');

    // The read-only cost note is present, but there is no input to edit it.
    expect(within(editCard).getByText(/set automatically by the most recent goods-received delivery/)).toBeInTheDocument();
    expect(within(editCard).getByText(/quantity only changes through a recorded event/)).toBeInTheDocument();
    expect(within(editCard).getByText('Receive', { selector: 'strong' })).toBeInTheDocument();
    expect(within(editCard).queryByLabelText(/cost/i)).not.toBeInTheDocument();

    const nameInput = within(editCard).getByLabelText('Name');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Premium Vodka');
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateStockItem).toHaveBeenCalledWith(
      '9',
      expect.objectContaining({ name: 'Premium Vodka', unit: 'ml', reorderLevel: '20.000' })
    );
    expect(mocks.updateStockItem.mock.calls[0][1]).not.toHaveProperty('purchase_cost');
    expect(mocks.updateStockItem.mock.calls[0][1]).not.toHaveProperty('purchaseCost');
  });

  it('editing can still move an item to a different registered category via its own dropdown — unlike creation, this is a normal choice among existing categories', async () => {
    mocks.listStockItemCategories.mockResolvedValue([
      { id: '1', name: 'Beverages', sort_order: 0, item_count: 1 },
      { id: '2', name: 'Cleaning supplies', sort_order: 1, item_count: 0 },
    ]);
    mocks.listStockItems.mockResolvedValue([item()]);
    mocks.updateStockItem.mockResolvedValue(item({ category: 'Cleaning supplies' }));
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    const row = (await screen.findByText('Vodka')).closest('tr');

    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const editCard = screen.getByRole('heading', { name: 'Edit — Vodka' }).closest('section');
    await selectWhenLoaded('Category', 'Cleaning supplies');
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateStockItem).toHaveBeenCalledWith('9', expect.objectContaining({ category: 'Cleaning supplies' }));
  });

  it('archiving requires going through the ConfirmDialog before calling the real endpoint', async () => {
    mocks.listStockItems.mockResolvedValue([item()]);
    mocks.archiveStockItem.mockResolvedValue(item({ status: 'archived' }));
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    const row = (await screen.findByText('Vodka')).closest('tr');

    await userEvent.click(within(row).getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Vodka');
    expect(mocks.archiveStockItem).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(mocks.archiveStockItem).toHaveBeenCalledWith('9'));
  });

  it('disables every mutating control while offline, including the new per-row Receive action', async () => {
    mocks.listStockItems.mockResolvedValue([item()]);
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} isOffline />);
    const row = (await screen.findByText('Vodka')).closest('tr');

    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(within(await categoryBlock('Beverages')).getByRole('button', { name: 'Add item' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Receive' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Archive' })).toBeDisabled();
  });

  it('a create attempt without pos.stock_manage surfaces the real backend 403 — no client-side check ever hides the button itself', async () => {
    mocks.createStockItem.mockRejectedValue(
      new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission to perform this action.' })
    );
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

    // The control is fully visible and clickable regardless of the real role.
    const addToggle = within(await categoryBlock('Beverages')).getByRole('button', { name: 'Add item' });
    expect(addToggle).toBeEnabled();
    await userEvent.click(addToggle);

    const addCard = screen.getByRole('heading', { name: 'Add item — Beverages' }).closest('section');
    await selectWhenLoaded('Outlet', '1');
    await userEvent.type(within(addCard).getByLabelText('Name'), 'Vodka');
    await userEvent.type(within(addCard).getByLabelText('Unit'), 'ml');
    await userEvent.click(within(addCard).getByRole('button', { name: 'Add item' }));

    expect(await within(addCard).findByText('You do not have permission to perform this action.')).toBeInTheDocument();
  });

  // Gap closure: registered stock categories (StockCategoriesCard, mirroring
  // SetupTab.jsx's own Menu categories mechanism) — unchanged component,
  // just relocated to the top of the redesigned screen.
  describe('categories (gap closure)', () => {
    it('registers a new category from the Stock categories card, and selecting its new row shows it as its own new, empty section', async () => {
      mocks.createStockItemCategory.mockResolvedValue({ id: '3', name: 'Wine' });
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const card = (await screen.findByRole('heading', { name: 'Stock categories' })).closest('section');

      await userEvent.type(within(card).getByLabelText('Category name'), 'Wine');
      mocks.listStockItemCategories.mockResolvedValue([
        { id: '1', name: 'Beverages', sort_order: 0, item_count: 0 },
        { id: '3', name: 'Wine', sort_order: 0, item_count: 0 },
      ]);
      await userEvent.click(within(card).getByRole('button', { name: 'Add category' }));

      expect(mocks.createStockItemCategory).toHaveBeenCalledWith({ name: 'Wine', sortOrder: undefined });
      expect(await within(card).findByText('Wine')).toBeInTheDocument();
      // Creating it doesn't itself switch the selection away from
      // Beverages — clicking its new row is the real payoff: "create a
      // category, then see it as its own section with nothing built for it".
      await selectCategory('Wine');
      const wineSection = await screen.findByRole('heading', { name: 'Wine' });
      expect(within(wineSection.closest('div')).getByText('No items yet — add the first one below.')).toBeInTheDocument();
      expect(within(wineSection.closest('div')).getByRole('button', { name: 'Add item' })).toBeInTheDocument();
    });

    it('shows why a category still in use cannot be archived', async () => {
      mocks.archiveStockItemCategory.mockRejectedValue(
        new ApiError({ code: 'CONFLICT_STOCK_CATEGORY_IN_USE', message: '"Beverages" is still used by 1 stock item — move them to another category first.' })
      );
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      const card = (await screen.findByRole('heading', { name: 'Stock categories' })).closest('section');

      await userEvent.click(within(card).getByRole('button', { name: 'Archive' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));

      expect(await within(card).findByText(/still used by 1 stock item/)).toBeInTheDocument();
    });
  });
});
