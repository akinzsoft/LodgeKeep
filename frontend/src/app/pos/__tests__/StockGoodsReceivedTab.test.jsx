import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockGoodsReceivedTab } from '../StockGoodsReceivedTab.jsx';
import { selectWhenLoaded } from './selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
  recordGoodsReceived: vi.fn(),
  listStockMovements: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets },
    stockApi: { listStockItems: mocks.listStockItems, recordGoodsReceived: mocks.recordGoodsReceived, listStockMovements: mocks.listStockMovements },
  };
});

const OUTLET = { id: '1', name: 'Main Bar' };
const STOCK_ITEMS = [
  { id: '20', name: 'Vodka', unit: 'ml' },
  { id: '21', name: 'Tonic water', unit: 'ml' },
];

async function selectOutlet() {
  render(<StockGoodsReceivedTab activeProperty={{ base_currency: 'NGN' }} />);
  await selectWhenLoaded('Outlet', '1');
  await screen.findByText('New delivery');
}

describe('<StockGoodsReceivedTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listStockItems.mockResolvedValue(STOCK_ITEMS);
    mocks.listStockMovements.mockResolvedValue([]);
  });

  it('shows the delivery form with the real outlet stock items once an outlet is selected', async () => {
    await selectOutlet();
    expect(screen.getByRole('option', { name: 'Vodka (ml)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Tonic water (ml)' })).toBeInTheDocument();
  });

  it('records a real delivery and shows the real result, including the new cost and quantity', async () => {
    mocks.recordGoodsReceived.mockResolvedValue({
      outletId: '1',
      reference: 'DN-1',
      count: 1,
      items: [{ id: '20', name: 'Vodka', unit: 'ml', current_quantity: '110.000', purchase_cost: '6.50' }],
    });
    mocks.listStockItems.mockResolvedValue(STOCK_ITEMS);
    await selectOutlet();

    await userEvent.type(screen.getByLabelText('Reference (optional)'), 'DN-1');
    await selectWhenLoaded('Stock item', '20');
    await userEvent.type(screen.getByLabelText('Quantity'), '10');
    await userEvent.type(screen.getByLabelText('Unit cost'), '6.50');
    await userEvent.click(screen.getByRole('button', { name: 'Record delivery' }));

    expect(mocks.recordGoodsReceived).toHaveBeenCalledWith({
      outletId: '1',
      reference: 'DN-1',
      // A real, native <input type="number"> quirk, not a component bug —
      // jsdom (matching real browsers) normalizes "6.50" typed into a
      // number field down to "6.5" on read.
      lines: [{ stockItemId: '20', quantity: '10', unitCost: '6.5' }],
    });
    expect(await screen.findByText(/reference "DN-1"/)).toBeInTheDocument();
    expect(screen.getByText('110.000 ml')).toBeInTheDocument();
    expect(screen.getByText(/6\.50/)).toBeInTheDocument();
  });

  it("bug fix: renders the active property's real currency, not a hardcoded NGN", async () => {
    mocks.recordGoodsReceived.mockResolvedValue({
      outletId: '1',
      reference: 'DN-1',
      count: 1,
      items: [{ id: '20', name: 'Vodka', unit: 'ml', current_quantity: '110.000', purchase_cost: '6.50' }],
    });
    render(<StockGoodsReceivedTab activeProperty={{ base_currency: 'KES' }} />);
    await selectWhenLoaded('Outlet', '1');
    await selectWhenLoaded('Stock item', '20');
    await userEvent.type(screen.getByLabelText('Quantity'), '10');
    await userEvent.type(screen.getByLabelText('Unit cost'), '6.50');
    await userEvent.click(screen.getByRole('button', { name: 'Record delivery' }));

    // KES formats as "Ksh" via Intl (confirmed directly against the real
    // Intl.NumberFormat output) — proves the currency actually threaded
    // through, not just that the component happened to still say "NGN".
    expect(await screen.findByText(/Ksh/)).toBeInTheDocument();
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument();
  });

  it('adding another line, then removing the only line, leaves exactly one fresh empty line — never zero', async () => {
    await selectOutlet();
    expect(screen.getAllByLabelText('Stock item')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Add another line' }));
    expect(screen.getAllByLabelText('Stock item')).toHaveLength(2);

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove line' })[0]);
    expect(screen.getAllByLabelText('Stock item')).toHaveLength(1);

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove line' })[0]);
    expect(screen.getAllByLabelText('Stock item')).toHaveLength(1);
    expect(screen.getAllByLabelText('Stock item')[0]).toHaveValue('');
  });

  it('the submit button is disabled until at least one complete line exists', async () => {
    await selectOutlet();
    expect(screen.getByRole('button', { name: 'Record delivery' })).toBeDisabled();

    await selectWhenLoaded('Stock item', '20');
    await userEvent.type(screen.getByLabelText('Quantity'), '10');
    await userEvent.type(screen.getByLabelText('Unit cost'), '6.50');
    expect(screen.getByRole('button', { name: 'Record delivery' })).toBeEnabled();
  });

  it('shows a real backend error when the delivery is rejected', async () => {
    mocks.recordGoodsReceived.mockRejectedValue(new Error('boom'));
    await selectOutlet();

    await selectWhenLoaded('Stock item', '20');
    await userEvent.type(screen.getByLabelText('Quantity'), '10');
    await userEvent.type(screen.getByLabelText('Unit cost'), '6.50');
    await userEvent.click(screen.getByRole('button', { name: 'Record delivery' }));

    expect(await screen.findByText('Could not record this delivery.')).toBeInTheDocument();
  });

  it('disables the whole delivery flow while offline, matching ShiftsTab.jsx\'s own precedent of disabling the entire mutating form, not just its submit button', async () => {
    render(<StockGoodsReceivedTab activeProperty={{ base_currency: 'NGN' }} isOffline />);
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();
    // The outlet picker itself is part of the mutating "new delivery" flow
    // here (unlike a pure read-side filter) — disabled outright, so there
    // is nothing left to expose a half-working form for.
    expect(screen.getByLabelText('Outlet')).toBeDisabled();
  });

  describe('gap closure: the form no longer hides itself until an outlet is picked', () => {
    it('the delivery form is visible with no outlet selected — only the Stock item select is disabled', async () => {
      render(<StockGoodsReceivedTab activeProperty={{ base_currency: 'NGN' }} />);
      await screen.findByText('New delivery');

      expect(screen.getByLabelText('Stock item')).toBeDisabled();
      expect(screen.getByLabelText('Quantity')).toBeEnabled();
      expect(screen.getByLabelText('Unit cost')).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Record delivery' })).toBeDisabled();
      // No "Recent deliveries" table until an outlet is chosen — there is
      // nothing yet to scope it to.
      expect(screen.queryByText('Recent deliveries')).not.toBeInTheDocument();
    });

    it('picking an outlet enables the Stock item select and loads its real recent deliveries', async () => {
      mocks.listStockMovements.mockResolvedValue([
        { id: '1', business_date: '2027-01-05', stock_item_name: 'Vodka', stock_item_unit: 'ml', quantity: '10.000', unit_cost: '6.50', reference: 'DN-1' },
      ]);
      await selectOutlet();

      expect(screen.getByLabelText('Stock item')).toBeEnabled();
      expect(mocks.listStockMovements).toHaveBeenCalledWith({ outletId: '1', type: 'received', limit: 20 });
      expect(await screen.findByText('Recent deliveries')).toBeInTheDocument();
      expect(screen.getByText('Vodka')).toBeInTheDocument();
      expect(screen.getByText('DN-1')).toBeInTheDocument();
    });

    it('an outlet with no prior deliveries shows an honest empty state, not a broken table', async () => {
      mocks.listStockMovements.mockResolvedValue([]);
      await selectOutlet();

      expect(await screen.findByText('No deliveries recorded yet for this outlet.')).toBeInTheDocument();
    });

    it('recording a delivery refreshes the recent-deliveries list so a submission never just vanishes', async () => {
      mocks.listStockMovements.mockResolvedValueOnce([]);
      mocks.recordGoodsReceived.mockResolvedValue({
        outletId: '1',
        reference: 'DN-2',
        count: 1,
        items: [{ id: '20', name: 'Vodka', unit: 'ml', current_quantity: '110.000', purchase_cost: '6.50' }],
      });
      await selectOutlet();
      await screen.findByText('No deliveries recorded yet for this outlet.');

      mocks.listStockMovements.mockResolvedValueOnce([
        { id: '2', business_date: '2027-01-06', stock_item_name: 'Vodka', stock_item_unit: 'ml', quantity: '10.000', unit_cost: '6.50', reference: 'DN-2' },
      ]);
      await selectWhenLoaded('Stock item', '20');
      await userEvent.type(screen.getByLabelText('Quantity'), '10');
      await userEvent.type(screen.getByLabelText('Unit cost'), '6.50');
      await userEvent.click(screen.getByRole('button', { name: 'Record delivery' }));

      await screen.findByText(/reference "DN-2"/);
      expect(mocks.listStockMovements).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('No deliveries recorded yet for this outlet.')).not.toBeInTheDocument();
    });
  });
});
