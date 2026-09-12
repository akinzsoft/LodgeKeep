import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockTakesTab } from '../StockTakesTab.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listStockItems: vi.fn(),
  listStockTakes: vi.fn(),
  getStockTake: vi.fn(),
  openStockTake: vi.fn(),
  recordStockTakeCount: vi.fn(),
  completeStockTake: vi.fn(),
  cancelStockTake: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { listOutlets: mocks.listOutlets },
    stockApi: {
      listStockItems: mocks.listStockItems,
      listStockTakes: mocks.listStockTakes,
      getStockTake: mocks.getStockTake,
      openStockTake: mocks.openStockTake,
      recordStockTakeCount: mocks.recordStockTakeCount,
      completeStockTake: mocks.completeStockTake,
      cancelStockTake: mocks.cancelStockTake,
    },
  };
});

const OUTLET = { id: '1', name: 'Main Bar' };
const STOCK_ITEM = { id: '20', name: 'Vodka', unit: 'ml' };

function openTakeRow(overrides) {
  return { id: '5', outlet_id: '1', status: 'open', opened_at: '2027-01-01 08:00:00', ...overrides };
}

describe('<StockTakesTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listStockItems.mockResolvedValue([STOCK_ITEM]);
    mocks.listStockTakes.mockResolvedValue([]);
  });

  it('opens a new stock take and shows a genuinely blind count-entry form — no Theoretical or Variance anywhere while open', async () => {
    mocks.openStockTake.mockResolvedValue(openTakeRow());
    mocks.getStockTake.mockResolvedValue({ stockTake: openTakeRow(), lines: [] });
    render(<StockTakesTab />);

    await userEvent.selectOptions(await screen.findByLabelText('Outlet'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Open stock take' }));

    expect(await screen.findByText('Vodka')).toBeInTheDocument();
    expect(screen.getByLabelText('Counted quantity for Vodka')).toBeInTheDocument();
    expect(screen.queryByText('Theoretical')).not.toBeInTheDocument();
    expect(screen.queryByText('Variance')).not.toBeInTheDocument();
  });

  it('saving a count calls the real endpoint and still never reveals theoretical/variance', async () => {
    mocks.listStockTakes.mockResolvedValue([openTakeRow()]);
    mocks.getStockTake.mockResolvedValue({ stockTake: openTakeRow(), lines: [] });
    mocks.recordStockTakeCount.mockResolvedValue({ id: '100', stock_take_id: '5', stock_item_id: '20', counted_quantity: '95.000', theoretical_quantity: null, variance: null });
    render(<StockTakesTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByText('Vodka');

    await userEvent.type(screen.getByLabelText('Counted quantity for Vodka'), '95');
    await userEvent.click(screen.getByRole('button', { name: 'Save count' }));

    expect(mocks.recordStockTakeCount).toHaveBeenCalledWith('5', '20', '95');
    expect(screen.queryByText('Theoretical')).not.toBeInTheDocument();
    expect(screen.queryByText('Variance')).not.toBeInTheDocument();
  });

  it('completing requires going through the ConfirmDialog, then reveals the real theoretical quantity and variance for the first time', async () => {
    mocks.listStockTakes.mockResolvedValue([openTakeRow()]);
    mocks.getStockTake.mockResolvedValue({ stockTake: openTakeRow(), lines: [{ id: '100', stock_item_id: '20', counted_quantity: '95.000', theoretical_quantity: null, variance: null }] });
    mocks.completeStockTake.mockResolvedValue({
      stockTake: openTakeRow({ status: 'completed' }),
      lines: [{ id: '100', stock_item_id: '20', counted_quantity: '95.000', theoretical_quantity: '100.000', variance: '-5.000' }],
    });
    render(<StockTakesTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByText('Vodka');
    expect(screen.queryByText('Theoretical')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Complete stock take' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('cannot be undone');
    expect(mocks.completeStockTake).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Complete' }));

    expect(mocks.completeStockTake).toHaveBeenCalledWith('5');
    expect(await screen.findByText('Theoretical')).toBeInTheDocument();
    expect(screen.getByText('Variance')).toBeInTheDocument();
    expect(screen.getByText('-5.000 ml')).toBeInTheDocument();
    expect(screen.getByText('100.000 ml')).toBeInTheDocument();
    // The live count-entry input is gone — this is now a read-only result.
    expect(screen.queryByLabelText('Counted quantity for Vodka')).not.toBeInTheDocument();
  });

  it('cancelling requires a real reason via the ConfirmDialog', async () => {
    mocks.listStockTakes.mockResolvedValue([openTakeRow()]);
    mocks.getStockTake.mockResolvedValue({ stockTake: openTakeRow(), lines: [] });
    mocks.cancelStockTake.mockResolvedValue(openTakeRow({ status: 'cancelled', cancel_reason: 'Started by mistake' }));
    render(<StockTakesTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByText('Vodka');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel stock take' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Cancel stock take' });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(within(dialog).getByRole('textbox'), 'Started by mistake');
    await userEvent.click(confirmButton);

    expect(mocks.cancelStockTake).toHaveBeenCalledWith('5', 'Started by mistake');
    expect(await screen.findByText(/Cancelled — Started by mistake/)).toBeInTheDocument();
  });

  it('viewing an already-completed stock take shows the read-only result directly, with no live counting UI at all', async () => {
    mocks.listStockTakes.mockResolvedValue([openTakeRow({ id: '6', status: 'completed' })]);
    mocks.getStockTake.mockResolvedValue({
      stockTake: openTakeRow({ id: '6', status: 'completed' }),
      lines: [{ id: '200', stock_item_id: '20', counted_quantity: '95.000', theoretical_quantity: '100.000', variance: '-5.000' }],
    });
    render(<StockTakesTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'View' }));

    expect(await screen.findByText('Theoretical')).toBeInTheDocument();
    expect(screen.queryByLabelText('Counted quantity for Vodka')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete stock take' })).not.toBeInTheDocument();
  });

  it('shows a real backend error when completion is rejected, without silently switching to the result view', async () => {
    mocks.listStockTakes.mockResolvedValue([openTakeRow()]);
    mocks.getStockTake.mockResolvedValue({ stockTake: openTakeRow(), lines: [] });
    mocks.completeStockTake.mockRejectedValue(new ApiError({ code: 'CONFLICT_STOCK_TAKE_ALREADY_COMPLETED', message: 'Stock take 5 has already been completed.' }));
    render(<StockTakesTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByText('Vodka');

    await userEvent.click(screen.getByRole('button', { name: 'Complete stock take' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Complete' }));

    expect(await screen.findByText('Stock take 5 has already been completed.')).toBeInTheDocument();
    expect(screen.getByLabelText('Counted quantity for Vodka')).toBeInTheDocument();
  });

  it('disables opening, counting, completing, and cancelling while offline', async () => {
    mocks.listStockTakes.mockResolvedValue([openTakeRow()]);
    mocks.getStockTake.mockResolvedValue({ stockTake: openTakeRow(), lines: [] });
    render(<StockTakesTab isOffline />);

    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByText('Vodka');

    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open stock take' })).toBeDisabled();
    expect(screen.getByLabelText('Counted quantity for Vodka')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Complete stock take' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel stock take' })).toBeDisabled();
  });
});
