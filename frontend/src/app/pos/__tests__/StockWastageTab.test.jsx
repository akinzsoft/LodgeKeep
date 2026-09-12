import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockWastageTab } from '../StockWastageTab.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
  recordWastage: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets },
    stockApi: { listStockItems: mocks.listStockItems, recordWastage: mocks.recordWastage },
  };
});

const OUTLET = { id: '1', name: 'Main Bar' };
const STOCK_ITEM = { id: '20', name: 'Vodka', unit: 'ml' };

async function selectOutletAndItem() {
  render(<StockWastageTab />);
  await userEvent.selectOptions(await screen.findByLabelText('Outlet'), '1');
  await userEvent.selectOptions(await screen.findByLabelText('Stock item'), '20');
}

describe('<StockWastageTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listStockItems.mockResolvedValue([STOCK_ITEM]);
  });

  it('shows a real backend error when stock items fail to load for the selected outlet', async () => {
    mocks.listStockItems.mockRejectedValue(new Error('boom'));
    render(<StockWastageTab />);
    await userEvent.selectOptions(await screen.findByLabelText('Outlet'), '1');
    expect(await screen.findByText('Could not load stock items for this outlet.')).toBeInTheDocument();
  });

  it('a blank reason is rejected client-side before any request is made', async () => {
    await selectOutletAndItem();
    await userEvent.type(screen.getByLabelText('Quantity lost'), '2.5');
    // Reason left blank.
    await userEvent.click(screen.getByRole('button', { name: 'Record wastage' }));

    expect(await screen.findByText('A reason is required to record wastage.')).toBeInTheDocument();
    expect(mocks.recordWastage).not.toHaveBeenCalled();
  });

  it('a whitespace-only reason is also rejected client-side', async () => {
    await selectOutletAndItem();
    await userEvent.type(screen.getByLabelText('Quantity lost'), '2.5');
    await userEvent.type(screen.getByLabelText('Reason'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Record wastage' }));

    expect(await screen.findByText('A reason is required to record wastage.')).toBeInTheDocument();
    expect(mocks.recordWastage).not.toHaveBeenCalled();
  });

  it('a real reason submits the real wastage record and shows the resulting quantity on hand', async () => {
    mocks.recordWastage.mockResolvedValue({ id: '20', name: 'Vodka', unit: 'ml', current_quantity: '97.500' });
    await selectOutletAndItem();

    await userEvent.type(screen.getByLabelText('Quantity lost'), '2.5');
    await userEvent.type(screen.getByLabelText('Reason'), 'Bottle dropped and broke');
    await userEvent.click(screen.getByRole('button', { name: 'Record wastage' }));

    expect(mocks.recordWastage).toHaveBeenCalledWith('20', { quantity: '2.5', reason: 'Bottle dropped and broke' });
    expect(await screen.findByText(/is now at 97\.500 ml on hand/)).toBeInTheDocument();
  });

  it('shows a real backend error when wastage is rejected', async () => {
    mocks.recordWastage.mockRejectedValue(new ApiError({ code: 'STOCK_ITEM_NOT_FOUND', message: 'The specified stock item does not exist.' }));
    await selectOutletAndItem();

    await userEvent.type(screen.getByLabelText('Quantity lost'), '2.5');
    await userEvent.type(screen.getByLabelText('Reason'), 'Bottle dropped and broke');
    await userEvent.click(screen.getByRole('button', { name: 'Record wastage' }));

    expect(await screen.findByText('The specified stock item does not exist.')).toBeInTheDocument();
  });

  it('disables the form while offline', async () => {
    render(<StockWastageTab isOffline />);
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(screen.getByLabelText('Outlet')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Record wastage' })).toBeDisabled();
  });
});
