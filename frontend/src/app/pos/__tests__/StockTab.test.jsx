import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockTab } from '../StockTab.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listMenuItems: vi.fn(),
}));

const stockMocks = vi.hoisted(() => ({
  listStockItems: vi.fn(),
  listStockTakes: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks, stockApi: stockMocks };
});

describe('<StockTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    Object.values(stockMocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([]);
    mocks.listMenuItems.mockResolvedValue([]);
    stockMocks.listStockItems.mockResolvedValue([]);
    stockMocks.listStockTakes.mockResolvedValue([]);
  });

  it('defaults to Stock items and switches between all six inner tabs, none hidden by any client-side permission check', async () => {
    render(<StockTab />);
    expect(screen.getByRole('tab', { name: 'Stock items', selected: true })).toBeInTheDocument();
    expect(await screen.findByText('New stock item')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Recipes' }));
    expect(await screen.findByLabelText('Outlet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Goods received' }));
    expect(screen.getByLabelText('Outlet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Stock takes' }));
    expect(await screen.findByText('Open a new stock take')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Wastage' }));
    expect(await screen.findByRole('heading', { name: 'Record wastage' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Reports' }));
    expect(await screen.findByRole('button', { name: 'Run reports' })).toBeInTheDocument();
  });

  it('threads isOffline down to every mutating inner tab', async () => {
    stockMocks.listStockItems.mockResolvedValue([{ id: '1', name: 'Vodka', unit: 'ml', current_quantity: '0.000', reorder_level: '0.000', purchase_cost: '0.00', supplier: null }]);
    render(<StockTab isOffline />);
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Wastage' }));
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();
  });
});
