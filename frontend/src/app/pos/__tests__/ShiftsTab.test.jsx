import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShiftsTab } from '../ShiftsTab.jsx';
import { ApiError } from '../../../shared/api/index.js';
import { selectWhenLoaded } from './selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listTerminals: vi.fn(),
  listShifts: vi.fn(),
  openShift: vi.fn(),
  closeShift: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks };
});

describe('<ShiftsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listTerminals.mockResolvedValue([{ id: '1', device_ref: 'BAR-TERM-1' }]);
    mocks.listShifts.mockResolvedValue([]);
  });

  it('opens a shift', async () => {
    mocks.openShift.mockResolvedValue({ id: '9' });
    render(<ShiftsTab />);

    await selectWhenLoaded('Terminal', 'BAR-TERM-1');
    await userEvent.type(screen.getByLabelText('Opening float'), '100');
    await userEvent.click(screen.getByRole('button', { name: 'Open shift' }));

    expect(mocks.openShift).toHaveBeenCalledWith(expect.objectContaining({ terminalId: '1', openingFloat: '100' }));
  });

  it('blind-closes a shift: the count is submitted before expected/variance ever appear', async () => {
    mocks.listShifts.mockResolvedValue([{ id: '5', opened_at: '2027-01-01', opening_float: '100.00', currency: 'NGN', closed_at: null }]);
    mocks.closeShift.mockResolvedValue({ counted_cash: '119.50', expected_cash: '121.50', variance: '-2.00', currency: 'NGN' });
    render(<ShiftsTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Close (blind count)' }));
    expect(screen.queryByText(/121\.50/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Counted cash'), '119.50');
    await userEvent.click(screen.getByRole('button', { name: 'Submit count' }));

    expect(mocks.closeShift).toHaveBeenCalledWith('5', '119.5', expect.any(String));
    expect(await screen.findByText(/121\.50/)).toBeInTheDocument();
    const varianceLabels = screen.getAllByText('Variance');
    const resultLabel = varianceLabels.find((el) => el.nextElementSibling?.textContent?.match(/2\.00/));
    expect(resultLabel).toBeDefined();
  });

  it('disables opening and closing while offline', async () => {
    mocks.listShifts.mockResolvedValue([{ id: '5', opened_at: '2027-01-01', opening_float: '100.00', currency: 'NGN', closed_at: null }]);
    render(<ShiftsTab isOffline />);
    expect(await screen.findByRole('button', { name: 'Open shift' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close (blind count)' })).toBeDisabled();
  });

  const openShiftRow = { id: '5', terminal_id: '1', terminal_device_ref: 'BAR-TERM-1', opened_at: '2027-01-01T09:00:00Z', opening_float: '100.00', currency: 'NGN', closed_at: null };

  it('shows each shift\'s terminal, operator, and full cash-up figures once closed', async () => {
    mocks.listShifts.mockResolvedValue([
      {
        id: '4',
        terminal_id: '1',
        terminal_device_ref: 'BAR-TERM-1',
        opened_by_first_name: 'Ada',
        opened_by_last_name: 'Obi',
        opened_at: '2027-01-01T09:00:00Z',
        closed_at: '2027-01-01T17:00:00Z',
        opening_float: '100.00',
        counted_cash: '119.50',
        expected_cash: '121.50',
        variance: '-2.00',
        currency: 'NGN',
      },
    ]);
    render(<ShiftsTab />);

    expect(await screen.findByText('Ada Obi')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'BAR-TERM-1' })).toBeInTheDocument();
    expect(screen.getByText(/119\.50/)).toBeInTheDocument();
    expect(screen.getByText(/121\.50/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close (blind count)' })).not.toBeInTheDocument();
  });

  it('does not offer a terminal that already has an open shift', async () => {
    mocks.listTerminals.mockResolvedValue([
      { id: '1', device_ref: 'BAR-TERM-1' },
      { id: '2', device_ref: 'POOL-TERM-1' },
    ]);
    mocks.listShifts.mockResolvedValue([openShiftRow]);
    render(<ShiftsTab />);

    expect(await screen.findByRole('option', { name: 'POOL-TERM-1' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'BAR-TERM-1' })).not.toBeInTheDocument();
  });

  it('sends one close request however many times Submit is pressed while it is in flight', async () => {
    mocks.listShifts.mockResolvedValue([openShiftRow]);
    let resolveClose;
    mocks.closeShift.mockImplementation(() => new Promise((resolve) => { resolveClose = resolve; }));
    render(<ShiftsTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Close (blind count)' }));
    await userEvent.type(screen.getByLabelText('Counted cash'), '100');
    const form = screen.getByLabelText('Counted cash').closest('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mocks.closeShift).toHaveBeenCalledTimes(1);

    resolveClose({ counted_cash: '100.00', expected_cash: '100.00', variance: '0.00', currency: 'NGN' });
    expect(await screen.findByText('Cash-up result')).toBeInTheDocument();
  });

  it('retries the same count under the same idempotency key, and a corrected count under a new one', async () => {
    mocks.listShifts.mockResolvedValue([openShiftRow]);
    mocks.closeShift.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'));
    render(<ShiftsTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Close (blind count)' }));
    await userEvent.type(screen.getByLabelText('Counted cash'), '100');
    await userEvent.click(screen.getByRole('button', { name: 'Submit count' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not close this shift.');
    // The form and the count survive a failed attempt.
    expect(screen.getByLabelText('Counted cash')).toHaveValue(100);

    await userEvent.click(screen.getByRole('button', { name: 'Submit count' }));
    await waitFor(() => expect(mocks.closeShift).toHaveBeenCalledTimes(2));
    const [firstKey, secondKey] = mocks.closeShift.mock.calls.map((call) => call[2]);
    expect(secondKey).toBe(firstKey);

    await userEvent.type(screen.getByLabelText('Counted cash'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Submit count' }));
    await waitFor(() => expect(mocks.closeShift).toHaveBeenCalledTimes(3));
    expect(mocks.closeShift.mock.calls[2][1]).toBe('1005');
    expect(mocks.closeShift.mock.calls[2][2]).not.toBe(firstKey);
  });

  it('never carries a typed count over after Cancel', async () => {
    mocks.listShifts.mockResolvedValue([openShiftRow]);
    render(<ShiftsTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Close (blind count)' }));
    await userEvent.type(screen.getByLabelText('Counted cash'), '250');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close (blind count)' }));

    expect(screen.getByLabelText('Counted cash')).toHaveValue(null);
  });

  it('drops the close form and refreshes when the shift was already closed elsewhere', async () => {
    mocks.listShifts.mockResolvedValue([openShiftRow]);
    mocks.closeShift.mockRejectedValue(new ApiError({ code: 'CONFLICT_POS_SHIFT_ALREADY_CLOSED', message: 'Shift 5 is already closed.', status: 409 }));
    render(<ShiftsTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Close (blind count)' }));
    await userEvent.type(screen.getByLabelText('Counted cash'), '100');
    await userEvent.click(screen.getByRole('button', { name: 'Submit count' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Shift 5 is already closed.');
    expect(screen.queryByLabelText('Counted cash')).not.toBeInTheDocument();
    expect(mocks.listShifts).toHaveBeenCalledTimes(2);
  });

  it('disables submitting a count if connectivity drops while the close form is open', async () => {
    mocks.listShifts.mockResolvedValue([openShiftRow]);
    const { rerender } = render(<ShiftsTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Close (blind count)' }));
    rerender(<ShiftsTab isOffline />);

    expect(screen.getByRole('button', { name: 'Submit count' })).toBeDisabled();
    expect(screen.getByLabelText('Counted cash')).toBeDisabled();
  });
});
