import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OutOfOrderTab } from '../OutOfOrderTab.jsx';

const mocks = vi.hoisted(() => ({
  listOutOfOrderPeriods: vi.fn(),
  createOutOfOrderPeriod: vi.fn(),
  closeOutOfOrderPeriod: vi.fn(),
  listRooms: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    housekeepingApi: {
      listOutOfOrderPeriods: mocks.listOutOfOrderPeriods,
      createOutOfOrderPeriod: mocks.createOutOfOrderPeriod,
      closeOutOfOrderPeriod: mocks.closeOutOfOrderPeriod,
    },
    setupApi: { listRooms: mocks.listRooms },
  };
});

const PERIOD = { id: '7', room_id: '2', type: 'ooo', reason: 'Leak', start_date: '2026-09-01', end_date: '2026-09-30' };

describe('<OutOfOrderTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutOfOrderPeriods.mockResolvedValue([PERIOD]);
    mocks.listRooms.mockResolvedValue([]);
    mocks.closeOutOfOrderPeriod.mockResolvedValue({ ...PERIOD, end_date: '2026-09-10' });
  });

  it("bug fix: \"Close now\" uses the property's own business date, not the browser's wall-clock today", async () => {
    render(<OutOfOrderTab activeProperty={{ current_business_date: '2026-09-10' }} canManage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Close now' }));

    expect(mocks.closeOutOfOrderPeriod).toHaveBeenCalledWith('7', '2026-09-10');
  });

  it('falls back to wall-clock today when the property has no business date configured yet', async () => {
    const today = new Date().toISOString().slice(0, 10);
    render(<OutOfOrderTab activeProperty={{ current_business_date: null }} canManage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Close now' }));

    expect(mocks.closeOutOfOrderPeriod).toHaveBeenCalledWith('7', today);
  });

  it('lists real out-of-order periods', async () => {
    render(<OutOfOrderTab activeProperty={{ current_business_date: '2026-09-10' }} canManage />);
    expect(await screen.findByText('Leak')).toBeInTheDocument();
  });

  it('shows the real backend error on a failed close', async () => {
    mocks.closeOutOfOrderPeriod.mockRejectedValue(new Error('boom'));
    render(<OutOfOrderTab activeProperty={{ current_business_date: '2026-09-10' }} canManage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Close now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not close this period.');
  });

  /**
   * Gap closure (user-reported): pulling a room out of/back into sellable
   * inventory is a supervisor decision — without `canManage`, neither the
   * schedule form nor "Close now" should render at all.
   */
  describe('without canManage (a plain housekeeper)', () => {
    it('does not render "Close now", the schedule form, or fetch the room picker', async () => {
      render(<OutOfOrderTab activeProperty={{ current_business_date: '2026-09-10' }} />);
      await screen.findByText('Leak');

      expect(screen.queryByRole('button', { name: 'Close now' })).not.toBeInTheDocument();
      expect(screen.queryByText('Schedule an out-of-order period')).not.toBeInTheDocument();
      expect(mocks.listRooms).not.toHaveBeenCalled();
    });
  });
});
