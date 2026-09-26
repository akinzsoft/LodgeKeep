import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockReportsTab } from '../StockReportsTab.jsx';
import { selectWhenLoaded } from './selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
  getCostOfSales: vi.fn(),
  getStockVariance: vi.fn(),
  getCostOfSalesMargin: vi.fn(),
  getStockOverview: vi.fn(),
  listStockMovements: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets },
    stockApi: {
      listStockItems: mocks.listStockItems,
      getCostOfSales: mocks.getCostOfSales,
      getStockVariance: mocks.getStockVariance,
      getCostOfSalesMargin: mocks.getCostOfSalesMargin,
      getStockOverview: mocks.getStockOverview,
      listStockMovements: mocks.listStockMovements,
    },
  };
});

const EMPTY_OVERVIEW = { totals: { itemCount: 0, soldCost: '0.00', wastageCost: '0.00' }, byCategory: [], items: [] };
const EMPTY_MARGIN = { byMenuItem: [], byCategory: [], totals: { revenue: '0.00', cost: '0.00', margin: '0.00', itemsWithUnknownCost: 0 } };

describe('<StockReportsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([{ id: '1', name: 'Main Bar' }]);
    mocks.listStockItems.mockResolvedValue([{ id: '20', name: 'Vodka (bottle)' }]);
    mocks.getCostOfSalesMargin.mockResolvedValue(EMPTY_MARGIN);
    mocks.getStockOverview.mockResolvedValue(EMPTY_OVERVIEW);
    mocks.listStockMovements.mockResolvedValue([]);
  });

  it('the date-range/outlet toolbar stays reachable before any report has ever run — never hidden inside a state-gated table', async () => {
    render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);
    expect(await screen.findByLabelText('Outlet')).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run reports' })).toBeEnabled();
    expect(screen.getAllByText('Choose a date range and run the reports.').length).toBeGreaterThan(0);
  });

  it('running the reports shows the real cost-of-sales and variance figures', async () => {
    mocks.getCostOfSales.mockResolvedValue({
      dateFrom: '2027-06-01',
      dateTo: '2027-06-01',
      outletId: null,
      totalCost: '100.00',
      byDay: [{ date: '2027-06-01', cost: '100.00' }],
      byItem: [{ stockItemId: '20', cost: '100.00' }],
    });
    mocks.getStockVariance.mockResolvedValue({
      dateFrom: '2027-06-01',
      dateTo: '2027-06-01',
      outletId: null,
      lines: [],
      summaryByItem: [{ stockItemId: '20', totalVariance: '-2.000' }],
    });
    render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

    expect(await screen.findByText(/Total cost of sales/)).toBeInTheDocument();
    expect(mocks.getCostOfSales).toHaveBeenCalledWith({ dateFrom: expect.any(String), dateTo: expect.any(String), outletId: undefined });
    const byItemTable = screen.getByRole('heading', { name: 'Cost of sales — by stock item' }).closest('section');
    expect(await within(byItemTable).findByText('Vodka (bottle)')).toBeInTheDocument();
    const varianceTable = screen.getByRole('heading', { name: 'Stock variance — every completed stock take in range' }).closest('section');
    expect(within(varianceTable).getByText('Vodka (bottle)')).toBeInTheDocument();
    expect(within(varianceTable).getByText('-2.000')).toBeInTheDocument();
  });

  it('bug fix: a stock item no longer in the catalogue (archived) still renders as a labelled #id, never a raw bare number', async () => {
    mocks.listStockItems.mockResolvedValue([]); // the reporting id resolves to nothing
    mocks.getCostOfSales.mockResolvedValue({ totalCost: '100.00', byDay: [], byItem: [{ stockItemId: '99', cost: '100.00' }] });
    mocks.getStockVariance.mockResolvedValue({ lines: [], summaryByItem: [] });
    render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

    expect(await screen.findByText('#99')).toBeInTheDocument();
  });

  it("bug fix: renders the active property's real currency, not a hardcoded NGN", async () => {
    mocks.getCostOfSales.mockResolvedValue({ totalCost: '100.00', byDay: [{ date: '2027-06-01', cost: '100.00' }], byItem: [] });
    mocks.getStockVariance.mockResolvedValue({ lines: [], summaryByItem: [] });
    render(<StockReportsTab activeProperty={{ base_currency: 'KES' }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

    // KES formats as "Ksh" via Intl (confirmed directly against the real
    // Intl.NumberFormat output) — proves the currency actually threaded
    // through, not just that the component happened to still say "NGN".
    // Two real matches here (the "Total cost of sales" line and the
    // by-day table row), so findAllByText — not findByText — is correct.
    expect((await screen.findAllByText(/Ksh/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument();
  });

  it('running the reports for a specific outlet passes the real outlet id through', async () => {
    mocks.getCostOfSales.mockResolvedValue({ totalCost: '0.00', byDay: [], byItem: [] });
    mocks.getStockVariance.mockResolvedValue({ lines: [], summaryByItem: [] });
    render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);

    await selectWhenLoaded('Outlet', '1');
    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

    expect(mocks.getCostOfSales).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1' }));
    expect(mocks.getStockVariance).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1' }));
  });

  it('shows a real backend error when the reports fail to load', async () => {
    mocks.getCostOfSales.mockRejectedValue(new Error('boom'));
    mocks.getStockVariance.mockResolvedValue({ lines: [], summaryByItem: [] });
    render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
    expect(await screen.findByText('Could not load these reports.')).toBeInTheDocument();
  });

  // Gap closure: cost-of-sales MARGIN — revenue, cost, and margin per menu
  // item, rolled up by category.
  describe('margin report (gap closure)', () => {
    beforeEach(() => {
      mocks.getCostOfSales.mockResolvedValue({ totalCost: '0.00', byDay: [], byItem: [] });
      mocks.getStockVariance.mockResolvedValue({ lines: [], summaryByItem: [] });
    });

    it('shows revenue, cost, and margin per menu item, and rolled up by category', async () => {
      mocks.getCostOfSalesMargin.mockResolvedValue({
        byMenuItem: [
          { menuItemId: '1', name: 'Bottle of Wine', category: 'Drinks', quantity: 2, revenue: '12.00', cost: '8.00', costSource: 'recipe', margin: '4.00', marginPct: 33.33 },
        ],
        byCategory: [{ category: 'Drinks', revenue: '12.00', cost: '8.00', margin: '4.00' }],
        totals: { revenue: '12.00', cost: '8.00', margin: '4.00', itemsWithUnknownCost: 0 },
      });
      render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);

      await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

      expect(await screen.findByText(/Total revenue/)).toBeInTheDocument();
      const byItem = screen.getByRole('heading', { name: 'Cost-of-sales margin — by menu item' }).closest('section');
      expect(within(byItem).getByText('Bottle of Wine')).toBeInTheDocument();
      expect(within(byItem).getByText('33.3%')).toBeInTheDocument();
      const byCategory = screen.getByRole('heading', { name: 'Cost-of-sales margin — by menu category' }).closest('section');
      expect(within(byCategory).getByText('Drinks')).toBeInTheDocument();
    });

    it('renders a genuinely unknown cost as "Unknown", never a false zero, and notes how many items are excluded', async () => {
      mocks.getCostOfSalesMargin.mockResolvedValue({
        byMenuItem: [{ menuItemId: '2', name: 'Mystery Item', category: 'Drinks', quantity: 1, revenue: '15.00', cost: null, costSource: 'unknown', margin: null, marginPct: null }],
        byCategory: [{ category: 'Drinks', revenue: '15.00', cost: null, margin: null }],
        totals: { revenue: '15.00', cost: '0.00', margin: '0.00', itemsWithUnknownCost: 1 },
      });
      render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);

      await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

      const byItem = await screen.findByRole('heading', { name: 'Cost-of-sales margin — by menu item' });
      const section = byItem.closest('section');
      expect(within(section).getAllByText('Unknown').length).toBeGreaterThan(0);
      expect(await screen.findByText(/1 item with no recipe or cost price configured/)).toBeInTheDocument();
    });

    it('an empty range shows the empty state, not an error', async () => {
      render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);
      await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));
      expect(await screen.findAllByText('Choose a date range and run the reports.')).not.toHaveLength(0);
    });
  });
  describe('every category and item, and the movement history (gap closure)', () => {
    const OVERVIEW = {
      totals: { itemCount: 3, soldCost: '60.00', wastageCost: '10.00' },
      byCategory: [
        { category: 'Spirits', registered: true, itemCount: 2, lowStockCount: 1, soldCost: '60.00', wastageCost: '10.00' },
        { category: 'Empty shelf', registered: true, itemCount: 0, lowStockCount: 0, soldCost: '0.00', wastageCost: '0.00' },
        { category: null, registered: null, itemCount: 1, lowStockCount: 0, soldCost: '0.00', wastageCost: '0.00' },
      ],
      items: [
        { stockItemId: '20', name: 'Gin', unit: 'ml', category: 'Spirits', currentQuantity: '80.000', soldQty: '20.000', soldCost: '40.00', receivedQty: '100.000', wastageQty: '5.000', wastageCost: '10.00', adjustmentQty: '0.000' },
        { stockItemId: '21', name: 'Rum', unit: 'ml', category: 'Spirits', currentQuantity: '50.000', soldQty: '10.000', soldCost: '20.00', receivedQty: '0.000', wastageQty: '0.000', wastageCost: '0.00', adjustmentQty: '0.000' },
        { stockItemId: '22', name: 'Never sold ice', unit: 'kg', category: null, currentQuantity: '4.000', soldQty: '0.000', soldCost: '0.00', receivedQty: '0.000', wastageQty: '0.000', wastageCost: '0.00', adjustmentQty: '0.000' },
      ],
    };

    beforeEach(() => {
      mocks.getCostOfSales.mockResolvedValue({ totalCost: '0.00', byDay: [], byItem: [] });
      mocks.getStockVariance.mockResolvedValue({ lines: [], summaryByItem: [] });
      mocks.getStockOverview.mockResolvedValue(OVERVIEW);
    });

    it('shows every category (even an empty one and Uncategorized) and every item — including one that never sold', async () => {
      render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);
      await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

      const byCategory = (await screen.findByRole('heading', { name: 'Stock categories — summary' })).closest('section');
      expect(within(byCategory).getByText('Spirits')).toBeInTheDocument();
      expect(within(byCategory).getByText('Empty shelf')).toBeInTheDocument();
      expect(within(byCategory).getByText('Uncategorized')).toBeInTheDocument();

      const items = screen.getByRole('heading', { name: 'Every stock item — by stock category' }).closest('section');
      expect(within(items).getByText('Gin')).toBeInTheDocument();
      expect(within(items).getByText('Never sold ice')).toBeInTheDocument();
      expect(screen.getByText(/3 active stock items — cost of sales/)).toBeInTheDocument();
      expect(mocks.getStockOverview).toHaveBeenCalledWith({ dateFrom: expect.any(String), dateTo: expect.any(String), outletId: undefined });
    });

    it('with an outlet chosen, lists its movement history — a Register sale is labelled as one', async () => {
      mocks.listStockMovements.mockResolvedValue([
        { id: '5', business_date: '2027-06-01', type: 'sold', quantity: '-1.000', stock_item_name: 'Gin', stock_item_unit: 'ml', stock_item_category: 'Spirits' },
        { id: '4', business_date: '2027-06-01', type: 'received', quantity: '100.000', stock_item_name: 'Gin', stock_item_unit: 'ml', stock_item_category: null },
      ]);
      render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);
      await selectWhenLoaded('Outlet', '1');
      await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

      const table = (await screen.findByRole('heading', { name: 'Stock movements — including Register sales' })).closest('section');
      expect(within(table).getByText('Register sale')).toBeInTheDocument();
      expect(within(table).getByText('Received')).toBeInTheDocument();
      expect(within(table).getByText('Spirits')).toBeInTheDocument();
      expect(within(table).getByText('Uncategorized')).toBeInTheDocument();
      expect(mocks.listStockMovements).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1' }));
    });

    it('without an outlet, asks for one instead of showing (or fetching) movement history', async () => {
      render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);
      await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

      expect(await screen.findByText(/Choose an outlet and run the reports to also see its stock movement history/)).toBeInTheDocument();
      expect(mocks.listStockMovements).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: 'Stock movements — including Register sales' })).not.toBeInTheDocument();
    });

    it('the existing cost-of-sales and variance tables now show each item\'s category', async () => {
      mocks.listStockItems.mockResolvedValue([{ id: '20', name: 'Gin', category: 'Spirits' }]);
      mocks.getCostOfSales.mockResolvedValue({ totalCost: '5.00', byDay: [], byItem: [{ stockItemId: '20', cost: '5.00' }] });
      render(<StockReportsTab activeProperty={{ base_currency: 'NGN' }} />);
      await userEvent.click(screen.getByRole('button', { name: 'Run reports' }));

      const table = (await screen.findByRole('heading', { name: 'Cost of sales — by stock item' })).closest('section');
      expect(await within(table).findByText('Spirits')).toBeInTheDocument();
    });
  });
});
