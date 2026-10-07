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
  listTransfers: vi.fn(),
  listTransferRequests: vi.fn(),
  getMyRequestOutlets: vi.fn(),
  getCostCheck: vi.fn(),
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
    stockMocks.getCostCheck.mockResolvedValue({ rows: [] });
    stockMocks.listStockTakes.mockResolvedValue([]);
    stockMocks.listTransfers.mockResolvedValue([]);
    stockMocks.listTransferRequests.mockResolvedValue([]);
    stockMocks.getMyRequestOutlets.mockResolvedValue({ restricted: false, outletIds: null });
  });

  it('defaults to Stock items and, with no permissions given, switches between all nine inner tabs', async () => {
    render(<StockTab activeProperty={{ base_currency: 'NGN' }} />);
    expect(screen.getByRole('tab', { name: 'Stock items', selected: true })).toBeInTheDocument();
    // Stock is managed one outlet at a time; with no outlet yet, Stock items says where to add one.
    expect(await screen.findByText(/Add an outlet under POS → Setup first/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Recipes' }));
    expect(await screen.findByLabelText('Outlet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Goods received' }));
    expect(screen.getByLabelText('Outlet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Stock takes' }));
    expect(await screen.findByText('Open a new stock take')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Wastage' }));
    expect(await screen.findByRole('heading', { name: 'Record wastage' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Requests' }));
    expect(await screen.findByRole('heading', { name: 'Request stock' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Transfer' }));
    expect(await screen.findByRole('heading', { name: 'Transfer stock' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Reorder report' }));
    expect(await screen.findByRole('heading', { name: 'Reorder report' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Reports' }));
    expect(await screen.findByRole('button', { name: 'Run reports' })).toBeInTheDocument();
  });

  it('shows only the tabs the role can use — a Storekeeper sees stock, requests, transfer, wastage and reorder', async () => {
    render(<StockTab activeProperty={{ base_currency: 'NGN' }} permissions={new Set(['pos.stock_view', 'pos.stock_transfer'])} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Stock items', 'Requests', 'Transfer', 'Wastage', 'Reorder report']);
  });

  it('a POS operator who can request stock gets Requests but no Transfer tab', async () => {
    render(<StockTab activeProperty={{ base_currency: 'NGN' }} permissions={new Set(['pos.operate', 'pos.stock_view', 'pos.stock_request'])} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Stock items', 'Requests', 'Wastage', 'Reorder report']);
  });

  it('a role with neither request key gets no Requests tab', async () => {
    render(<StockTab activeProperty={{ base_currency: 'NGN' }} permissions={new Set(['pos.stock_view'])} />);
    expect(screen.queryByRole('tab', { name: 'Requests' })).not.toBeInTheDocument();
  });

  it('a POS operator (view only) gets no Transfer tab', async () => {
    render(<StockTab activeProperty={{ base_currency: 'NGN' }} permissions={new Set(['pos.operate', 'pos.stock_view'])} />);
    expect(screen.queryByRole('tab', { name: 'Transfer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Goods received' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Stock items', selected: true })).toBeInTheDocument();
  });

  it('threads isOffline down to every mutating inner tab', async () => {
    stockMocks.listStockItems.mockResolvedValue([{ id: '1', name: 'Vodka', unit: 'ml', current_quantity: '0.000', reorder_level: '0.000', purchase_cost: '0.00', supplier: null }]);
    render(<StockTab activeProperty={{ base_currency: 'NGN' }} isOffline />);
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Wastage' }));
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();
  });
});
