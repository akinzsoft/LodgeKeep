import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockRecipesTab } from '../StockRecipesTab.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listMenuItems: vi.fn(),
  listStockItems: vi.fn(),
  listMenuItemComponents: vi.fn(),
  upsertMenuItemComponents: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets, listMenuItems: mocks.listMenuItems },
    stockApi: { listStockItems: mocks.listStockItems, listMenuItemComponents: mocks.listMenuItemComponents, upsertMenuItemComponents: mocks.upsertMenuItemComponents },
  };
});

const OUTLET = { id: '1', name: 'Main Bar' };
const MENU_ITEM = { id: '10', name: 'Vodka Tonic' };
const STOCK_ITEMS = [
  { id: '20', name: 'Vodka', unit: 'ml' },
  { id: '21', name: 'Tonic water', unit: 'ml' },
];

async function selectOutletAndMenuItem() {
  render(<StockRecipesTab />);
  await userEvent.selectOptions(await screen.findByLabelText('Outlet'), '1');
  await userEvent.selectOptions(await screen.findByLabelText('Menu item'), '10');
}

describe('<StockRecipesTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listMenuItems.mockResolvedValue([MENU_ITEM]);
    mocks.listStockItems.mockResolvedValue(STOCK_ITEMS);
  });

  it('lists the real recipe once an outlet and menu item are selected', async () => {
    mocks.listMenuItemComponents.mockResolvedValue([{ stock_item_id: '20', quantity: '25.000' }]);
    await selectOutletAndMenuItem();

    expect(await screen.findByText('Vodka')).toBeInTheDocument();
    expect(screen.getByText('25.000 ml')).toBeInTheDocument();
    // Already-added items are never offered again in the add-row picker.
    expect(screen.queryByRole('option', { name: 'Vodka (ml)' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Tonic water (ml)' })).toBeInTheDocument();
  });

  it('shows a real backend error when the recipe fails to load', async () => {
    mocks.listMenuItemComponents.mockRejectedValue(new Error('boom'));
    await selectOutletAndMenuItem();
    expect(await screen.findByText('Could not load this recipe.')).toBeInTheDocument();
  });

  it('adding a row and saving sends the real full replace-all payload', async () => {
    mocks.listMenuItemComponents.mockResolvedValue([]);
    mocks.upsertMenuItemComponents.mockResolvedValue([{ stock_item_id: '21', quantity: '10.000' }]);
    await selectOutletAndMenuItem();
    await screen.findByText('No recipe components yet — add one below. This menu item\'s stock is never affected by a sale until it has at least one.');

    await userEvent.selectOptions(screen.getByLabelText('Add stock item'), '21');
    await userEvent.type(screen.getByLabelText('Quantity'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Add to recipe' }));
    expect(await screen.findByText('Tonic water')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }));
    expect(mocks.upsertMenuItemComponents).toHaveBeenCalledWith('10', [{ stockItemId: '21', quantity: '10' }]);
    expect(await screen.findByText('Recipe saved.')).toBeInTheDocument();
  });

  it('removing a row before saving drops it from the payload', async () => {
    mocks.listMenuItemComponents.mockResolvedValue([
      { stock_item_id: '20', quantity: '25.000' },
      { stock_item_id: '21', quantity: '5.000' },
    ]);
    mocks.upsertMenuItemComponents.mockResolvedValue([{ stock_item_id: '21', quantity: '5.000' }]);
    await selectOutletAndMenuItem();
    await screen.findByText('Vodka');

    const vodkaRow = screen.getByText('Vodka').closest('tr');
    await userEvent.click(within(vodkaRow).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Vodka')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }));
    expect(mocks.upsertMenuItemComponents).toHaveBeenCalledWith('10', [{ stockItemId: '21', quantity: '5.000' }]);
  });

  it('disables recipe controls while offline', async () => {
    mocks.listMenuItemComponents.mockResolvedValue([{ stock_item_id: '20', quantity: '25.000' }]);
    render(<StockRecipesTab isOffline />);
    await userEvent.selectOptions(await screen.findByLabelText('Outlet'), '1');
    await userEvent.selectOptions(await screen.findByLabelText('Menu item'), '10');
    await screen.findByText('Vodka');

    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save recipe' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });
});
