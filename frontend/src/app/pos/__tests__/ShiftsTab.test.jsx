import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShiftsTab } from '../ShiftsTab.jsx';

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

    await userEvent.selectOptions(await screen.findByLabelText('Terminal'), 'BAR-TERM-1');
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

    expect(mocks.closeShift).toHaveBeenCalledWith('5', '119.5');
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
});
