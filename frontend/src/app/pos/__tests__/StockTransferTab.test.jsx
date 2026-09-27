import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockTransferTab } from '../StockTransferTab.jsx';
import { ApiError } from '../../../shared/api/index.js';
import { selectWhenLoaded } from './selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
  transferStock: vi.fn(),
  listTransfers: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets },
    stockApi: { listStockItems: mocks.listStockItems, transferStock: mocks.transferStock, listTransfers: mocks.listTransfers },
  };
});

const STORE = { id: '1', name: 'Main Store', type: 'store' };
const BAR = { id: '2', name: 'Main Bar', type: 'bar' };
const LAGER = { id: '20', name: 'Lager', unit: 'bottle', current_quantity: '12.000' };

async function chooseRoute() {
  render(<StockTransferTab />);
  await selectWhenLoaded('From', '1');
  await selectWhenLoaded('To', '2');
  await selectWhenLoaded('Stock item', '20');
}

describe('<StockTransferTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([STORE, BAR]);
    mocks.listStockItems.mockResolvedValue([LAGER]);
    mocks.listTransfers.mockResolvedValue([]);
  });

  it('offers every outlet, stores included, on both sides — and not the source as its own destination', async () => {
    render(<StockTransferTab />);
    await selectWhenLoaded('From', '1');
    expect(within(screen.getByLabelText('From')).getByRole('option', { name: 'Main Store (store)' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('To')).getByRole('option', { name: 'Main Store (store)' })).toBeDisabled();
    expect(within(screen.getByLabelText('To')).getByRole('option', { name: 'Main Bar' })).toBeEnabled();
  });

  it('lists what the source outlet holds, with its on-hand quantity', async () => {
    await chooseRoute();
    expect(mocks.listStockItems).toHaveBeenCalledWith({ outletId: '1' });
    expect(screen.getByText('12.000 bottle on hand at Main Store')).toBeInTheDocument();
  });

  it('warns and will not submit a quantity above what the source holds', async () => {
    await chooseRoute();
    await userEvent.type(screen.getByLabelText('Quantity'), '12.001');
    expect(screen.getByRole('alert')).toHaveTextContent('Only 12.000 bottle of Lager is on hand at Main Store');
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Quantity'));
    await userEvent.type(screen.getByLabelText('Quantity'), '12');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeEnabled();
  });

  it('submits the transfer and shows both outlets\' new quantities', async () => {
    mocks.transferStock.mockResolvedValue({
      reference: 'TRF-1',
      quantity: '5',
      stockItem: { id: '20', name: 'Lager', unit: 'bottle' },
      from: { outletId: '1', outletName: 'Main Store', newQuantity: '7.000' },
      to: { outletId: '2', outletName: 'Main Bar', newQuantity: '5.000' },
    });
    await chooseRoute();
    await userEvent.type(screen.getByLabelText('Quantity'), '5');
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'Friday restock');
    await userEvent.click(screen.getByRole('button', { name: 'Transfer' }));

    expect(mocks.transferStock).toHaveBeenCalledWith({ stockItemId: '20', fromOutletId: '1', toOutletId: '2', quantity: '5', note: 'Friday restock' });
    expect(await screen.findByText(/Moved 5 bottle of Lager from Main Store \(now 7.000 bottle\) to Main Bar \(now 5.000 bottle\)/)).toBeInTheDocument();
    expect(mocks.listStockItems).toHaveBeenCalledTimes(2); // refreshed after the transfer
  });

  it('shows the server\'s own refusal', async () => {
    mocks.transferStock.mockRejectedValue(new ApiError({ status: 422, code: 'BUSINESS_RULE_INSUFFICIENT_STOCK_FOR_TRANSFER', message: 'Only 3.000 bottle of "Lager" is on hand at this outlet.' }));
    await chooseRoute();
    await userEvent.type(screen.getByLabelText('Quantity'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByText('Only 3.000 bottle of "Lager" is on hand at this outlet.')).toBeInTheDocument();
  });

  it.each(['0', '-1', '1.2345', 'abc'])('will not submit quantity %p', async (value) => {
    await chooseRoute();
    await userEvent.type(screen.getByLabelText('Quantity'), value);
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeDisabled();
  });

  it('lists recent transfers with both outlets', async () => {
    mocks.listTransfers.mockResolvedValue([
      { reference: 'TRF-9', businessDate: '2027-06-01', stockItemName: 'Lager', unit: 'bottle', quantity: '4.000', from: { outletName: 'Main Store' }, to: { outletName: 'Main Bar' }, note: null },
    ]);
    render(<StockTransferTab />);
    const row = (await screen.findByText('4.000 bottle')).closest('tr');
    expect(row).toHaveTextContent('Main Store');
    expect(row).toHaveTextContent('Main Bar');
  });

  it('an older history response arriving late never replaces the chosen outlet\'s history', async () => {
    let resolveAll;
    mocks.listTransfers.mockImplementation(({ outletId } = {}) => {
      if (!outletId) return new Promise((resolve) => (resolveAll = resolve));
      return Promise.resolve([{ reference: 'TRF-STORE', businessDate: '2027-06-01', stockItemName: 'Lager', unit: 'bottle', quantity: '2.000', from: { outletName: 'Main Store' }, to: { outletName: 'Main Bar' }, note: 'store only' }]);
    });
    render(<StockTransferTab />);
    await selectWhenLoaded('From', '1');
    expect(await screen.findByText('store only')).toBeInTheDocument();

    resolveAll([{ reference: 'TRF-OTHER', businessDate: '2027-06-01', stockItemName: 'Gin', unit: 'ml', quantity: '9.000', from: { outletName: 'Poolside' }, to: { outletName: 'Main Bar' }, note: 'somewhere else' }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('somewhere else')).not.toBeInTheDocument();
    expect(screen.getByText('store only')).toBeInTheDocument();
  });

  it('disables everything while offline', async () => {
    render(<StockTransferTab isOffline />);
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeDisabled();
  });
});
