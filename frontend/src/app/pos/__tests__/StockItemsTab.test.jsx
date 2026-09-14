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

function item(overrides) {
  return {
    id: '9',
    name: 'Vodka',
    unit: 'ml',
    current_quantity: '100.000',
    reorder_level: '20.000',
    purchase_cost: '5.00',
    supplier: 'Acme Beverages',
    ...overrides,
  };
}

describe('<StockItemsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([outlet()]);
    mocks.listStockItemCategories.mockResolvedValue([{ id: '1', name: 'Beverages', sort_order: 0, item_count: 0 }]);
  });

  it('lists real stock items with quantity+unit and cost, never running quantity through the money formatter', async () => {
    mocks.listStockItems.mockResolvedValue([item()]);
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

    expect(await screen.findByText('Vodka')).toBeInTheDocument();
    expect(screen.getByText('100.000 ml')).toBeInTheDocument();
    expect(screen.getByText('20.000 ml')).toBeInTheDocument();
    expect(screen.getByText(/5\.00/)).toBeInTheDocument();
    expect(screen.getByText('Acme Beverages')).toBeInTheDocument();
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

  it('the outlet filter and low-stock toggle stay reachable even when the list is genuinely empty — never hidden inside the state-gated table', async () => {
    mocks.listStockItems.mockResolvedValue([]);
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);

    await screen.findByText('No stock items match this filter.');
    expect(screen.getByLabelText('Filter by outlet')).toBeInTheDocument();
    expect(screen.getByLabelText('Low stock only')).toBeInTheDocument();
  });

  it('low-stock filtering calls the real endpoint with low_stock requested', async () => {
    mocks.listStockItems.mockResolvedValue([]);
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    await waitFor(() => expect(mocks.listStockItems).toHaveBeenCalledWith({ outletId: undefined, lowStockOnly: false }));

    await userEvent.click(screen.getByLabelText('Low stock only'));
    await waitFor(() => expect(mocks.listStockItems).toHaveBeenCalledWith({ outletId: undefined, lowStockOnly: true }));
  });

  it('creates a stock item with the real form payload', async () => {
    mocks.listStockItems.mockResolvedValue([]);
    mocks.createStockItem.mockResolvedValue(item());
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    await screen.findByText('New stock item');

    await selectWhenLoaded('Outlet', '1');
    await userEvent.type(screen.getByLabelText('Name'), 'Vodka');
    await userEvent.type(screen.getByLabelText('Unit'), 'ml');
    await userEvent.type(screen.getByLabelText('Reorder level (optional)'), '20');
    await userEvent.click(screen.getByRole('button', { name: 'Add stock item' }));

    expect(mocks.createStockItem).toHaveBeenCalledWith(
      expect.objectContaining({ outletId: '1', name: 'Vodka', unit: 'ml', reorderLevel: '20' })
    );
  });

  it('editing prefills the real values and never shows an editable cost field — cost is read-only', async () => {
    mocks.listStockItems.mockResolvedValue([item()]);
    mocks.updateStockItem.mockResolvedValue(item({ name: 'Premium Vodka' }));
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    const row = (await screen.findByText('Vodka')).closest('tr');

    // Scoped to the item's own row — the Stock categories card below
    // renders its own "Edit"/"Archive" buttons per category row too.
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const editCard = screen.getByRole('heading', { name: 'Edit — Vodka' }).closest('section');

    // The read-only cost note is present, but there is no input to edit it.
    expect(within(editCard).getByText(/set automatically by the most recent goods-received delivery/)).toBeInTheDocument();
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

  it('archiving requires going through the ConfirmDialog before calling the real endpoint', async () => {
    mocks.listStockItems.mockResolvedValue([item()]);
    mocks.archiveStockItem.mockResolvedValue(item({ status: 'archived' }));
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    const row = (await screen.findByText('Vodka')).closest('tr');

    // Scoped to the item's own row — see the previous test's own comment.
    await userEvent.click(within(row).getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Vodka');
    expect(mocks.archiveStockItem).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(mocks.archiveStockItem).toHaveBeenCalledWith('9'));
  });

  it('disables every mutating control while offline', async () => {
    mocks.listStockItems.mockResolvedValue([item()]);
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} isOffline />);
    const row = (await screen.findByText('Vodka')).closest('tr');

    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add stock item' })).toBeDisabled();
    // Scoped to the item's own row — see the earlier tests' own comment.
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Archive' })).toBeDisabled();
  });

  it('a create attempt without pos.stock_manage surfaces the real backend 403 — no client-side check ever hides the button itself', async () => {
    mocks.listStockItems.mockResolvedValue([]);
    mocks.createStockItem.mockRejectedValue(
      new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission to perform this action.' })
    );
    render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
    await screen.findByText('New stock item');

    // The control is fully visible and clickable regardless of the real role.
    const addButton = screen.getByRole('button', { name: 'Add stock item' });
    expect(addButton).toBeEnabled();

    await selectWhenLoaded('Outlet', '1');
    await userEvent.type(screen.getByLabelText('Name'), 'Vodka');
    await userEvent.type(screen.getByLabelText('Unit'), 'ml');
    await userEvent.click(addButton);

    expect(await screen.findByText('You do not have permission to perform this action.')).toBeInTheDocument();
  });

  // Gap closure: registered stock categories (StockCategoriesCard, mirroring
  // SetupTab.jsx's own Menu categories mechanism).
  describe('categories (gap closure)', () => {
    it('offers the registered categories on the create form, including "No category"', async () => {
      mocks.listStockItems.mockResolvedValue([]);
      mocks.listStockItemCategories.mockResolvedValue([
        { id: '1', name: 'Beverages', sort_order: 0, item_count: 1 },
        { id: '2', name: 'Cleaning supplies', sort_order: 1, item_count: 0 },
      ]);
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      await screen.findByText('New stock item');

      const select = await screen.findByLabelText('Category (optional)');
      expect([...select.options].map((o) => o.textContent)).toEqual(['No category', 'Beverages', 'Cleaning supplies']);
    });

    it('creates a stock item with the selected category', async () => {
      mocks.listStockItems.mockResolvedValue([]);
      mocks.createStockItem.mockResolvedValue(item());
      render(<StockItemsTab activeProperty={{ base_currency: 'NGN' }} />);
      await screen.findByText('New stock item');

      await selectWhenLoaded('Outlet', '1');
      await userEvent.type(screen.getByLabelText('Name'), 'Vodka');
      await userEvent.type(screen.getByLabelText('Unit'), 'ml');
      await selectWhenLoaded('Category (optional)', 'Beverages');
      await userEvent.click(screen.getByRole('button', { name: 'Add stock item' }));

      expect(mocks.createStockItem).toHaveBeenCalledWith(expect.objectContaining({ category: 'Beverages' }));
    });

    it('registers a new category from the Stock categories card and refreshes the dropdown', async () => {
      mocks.listStockItems.mockResolvedValue([]);
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
    });

    it('shows why a category still in use cannot be archived', async () => {
      mocks.listStockItems.mockResolvedValue([]);
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
