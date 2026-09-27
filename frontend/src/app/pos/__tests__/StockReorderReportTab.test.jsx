import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockReorderReportTab } from '../StockReorderReportTab.jsx';
import { selectWhenLoaded } from './selectWhenLoaded.js';
import { quantityShortfall } from '../stockFormat.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets },
    stockApi: { listStockItems: mocks.listStockItems },
  };
});

function item(overrides) {
  return { id: '1', outlet_id: '1', name: 'Vodka', unit: 'bottle', category: 'Spirits', current_quantity: '2.000', reorder_level: '5.000', supplier: 'Acme', purchase_cost: '4000.00', ...overrides };
}

const ITEMS = [
  item({ id: '1', name: 'Vodka', current_quantity: '2.000' }),
  item({ id: '2', name: 'Rice', outlet_id: '3', category: null, unit: 'bag', current_quantity: '0.000', reorder_level: '3.000', supplier: null, purchase_cost: null }),
  item({ id: '3', name: 'Beer', current_quantity: '5.000', reorder_level: '5.000' }),
];

const renderTab = () => render(<StockReorderReportTab activeProperty={{ base_currency: 'NGN' }} />);

describe('<StockReorderReportTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([
      { id: '1', name: 'Main Bar' },
      { id: '3', name: 'Supermarket' },
    ]);
    mocks.listStockItems.mockResolvedValue(ITEMS);
  });

  it('lists the low-stock items from the backend, out of stock first, with how much to reorder', async () => {
    renderTab();
    const table = (await screen.findByRole('heading', { name: 'Reorder report' })).closest('section');
    await within(table).findByText('Rice');
    expect(mocks.listStockItems).toHaveBeenCalledWith({ outletId: undefined, lowStockOnly: true });

    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[1].textContent)).toEqual(['Rice', 'Beer', 'Vodka']);

    const rice = rows[0];
    expect(within(rice).getByText('Out of stock')).toBeInTheDocument();
    expect(within(rice).getByText('Supermarket')).toBeInTheDocument();
    expect(within(rice).getByText('Uncategorized')).toBeInTheDocument();
    expect(within(rice).getByText('3.000 bag', { selector: 'td:nth-child(7)' })).toBeInTheDocument();

    const vodka = rows[2];
    expect(within(vodka).getByText('Low stock')).toBeInTheDocument();
    expect(within(vodka).getByText('3.000 bottle')).toBeInTheDocument(); // 5 − 2
    expect(within(vodka).getByText(/4,000\.00/)).toBeInTheDocument();

    // At exactly the reorder level counts as low, with nothing more to reach it.
    expect(within(rows[1]).getByText('0.000 bottle')).toBeInTheDocument();
    expect(screen.getByText(/1 out of stock, 2 low stock/)).toBeInTheDocument();
  });

  it('narrows to out of stock or low stock only', async () => {
    renderTab();
    await screen.findByText('Rice');
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'out');
    expect(screen.getByText('Rice')).toBeInTheDocument();
    expect(screen.queryByText('Vodka')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Show'), 'low');
    expect(screen.queryByText('Rice')).not.toBeInTheDocument();
    expect(screen.getByText('Vodka')).toBeInTheDocument();
  });

  it('reloads for one outlet when the outlet filter changes', async () => {
    renderTab();
    await screen.findByText('Rice');
    mocks.listStockItems.mockResolvedValue([ITEMS[1]]);
    await selectWhenLoaded('Outlet', 'Supermarket');
    expect(mocks.listStockItems).toHaveBeenLastCalledWith({ outletId: '3', lowStockOnly: true });
    expect(await screen.findByText('Rice')).toBeInTheDocument();
    expect(screen.queryByText('Vodka')).not.toBeInTheDocument();
  });

  it('says so when nothing needs reordering, and shows a real load error', async () => {
    mocks.listStockItems.mockResolvedValue([]);
    const { unmount } = renderTab();
    expect(await screen.findByText(/Nothing to reorder/)).toBeInTheDocument();
    unmount();

    const { ApiError } = await vi.importActual('../../../shared/api/index.js');
    mocks.listStockItems.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission.', status: 403 }));
    renderTab();
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission.');
  });
});

describe('quantityShortfall', () => {
  it('is the exact amount back up to the reorder level, never negative', () => {
    expect(quantityShortfall('5.000', '2.000')).toBe('3.000');
    expect(quantityShortfall('3.000', '-1.250')).toBe('4.250');
    expect(quantityShortfall('1.100', '0.001')).toBe('1.099');
    expect(quantityShortfall('5.000', '7.000')).toBe('0.000');
  });
});
