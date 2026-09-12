import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockGoodsReceivedTab } from '../StockGoodsReceivedTab.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
  recordGoodsReceived: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets },
    stockApi: { listStockItems: mocks.listStockItems, recordGoodsReceived: mocks.recordGoodsReceived },
  };
});

const OUTLET = { id: '1', name: 'Main Bar' };
const STOCK_ITEMS = [
  { id: '20', name: 'Vodka', unit: 'ml' },
  { id: '21', name: 'Tonic water', unit: 'ml' },
];

async function selectOutlet() {
  render(<StockGoodsReceivedTab />);
  await userEvent.selectOptions(await screen.findByLabelText('Outlet'), '1');
  await screen.findByText('New delivery');
}

describe('<StockGoodsReceivedTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listStockItems.mockResolvedValue(STOCK_ITEMS);
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
    await userEvent.selectOptions(screen.getByLabelText('Stock item'), '20');
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

    await userEvent.selectOptions(screen.getByLabelText('Stock item'), '20');
    await userEvent.type(screen.getByLabelText('Quantity'), '10');
    await userEvent.type(screen.getByLabelText('Unit cost'), '6.50');
    expect(screen.getByRole('button', { name: 'Record delivery' })).toBeEnabled();
  });

  it('shows a real backend error when the delivery is rejected', async () => {
    mocks.recordGoodsReceived.mockRejectedValue(new Error('boom'));
    await selectOutlet();

    await userEvent.selectOptions(screen.getByLabelText('Stock item'), '20');
    await userEvent.type(screen.getByLabelText('Quantity'), '10');
    await userEvent.type(screen.getByLabelText('Unit cost'), '6.50');
    await userEvent.click(screen.getByRole('button', { name: 'Record delivery' }));

    expect(await screen.findByText('Could not record this delivery.')).toBeInTheDocument();
  });

  it('disables the whole delivery flow while offline, matching ShiftsTab.jsx\'s own precedent of disabling the entire mutating form, not just its submit button', async () => {
    render(<StockGoodsReceivedTab isOffline />);
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();
    // The outlet picker itself is part of the mutating "new delivery" flow
    // here (unlike a pure read-side filter) — disabled outright, so there
    // is nothing left to expose a half-working form for.
    expect(screen.getByLabelText('Outlet')).toBeDisabled();
  });
});
