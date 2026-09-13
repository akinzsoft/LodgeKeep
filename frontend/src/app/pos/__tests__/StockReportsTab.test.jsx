import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockReportsTab } from '../StockReportsTab.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
  getCostOfSales: vi.fn(),
  getStockVariance: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets },
    stockApi: { listStockItems: mocks.listStockItems, getCostOfSales: mocks.getCostOfSales, getStockVariance: mocks.getStockVariance },
  };
});

describe('<StockReportsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([{ id: '1', name: 'Main Bar' }]);
    mocks.listStockItems.mockResolvedValue([{ id: '20', name: 'Vodka (bottle)' }]);
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

    await userEvent.selectOptions(await screen.findByLabelText('Outlet'), '1');
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
});
