import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiscrepanciesTab } from '../DiscrepanciesTab.jsx';

const mocks = vi.hoisted(() => ({
  listDiscrepancies: vi.fn(),
  resolveDiscrepancy: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    housekeepingApi: {
      listDiscrepancies: mocks.listDiscrepancies,
      resolveDiscrepancy: mocks.resolveDiscrepancy,
    },
  };
});

const OPEN = {
  id: '1',
  room_id: '5',
  business_date: '2027-01-01',
  front_desk_status: 'vacant',
  housekeeping_status: 'occupied',
  resolved_at: null,
};

describe('<DiscrepanciesTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listDiscrepancies.mockResolvedValue([OPEN]);
  });

  it('lists an open discrepancy with both reported values', async () => {
    render(<DiscrepanciesTab canManage />);
    expect(await screen.findByText('vacant')).toBeInTheDocument();
    expect(screen.getByText('occupied')).toBeInTheDocument();
    // "Open" also appears as the filter dropdown's own option text.
    expect(screen.getByText('Open', { selector: 'span' })).toBeInTheDocument();
  });

  it('a canManage viewer can resolve an open discrepancy with a reason', async () => {
    render(<DiscrepanciesTab canManage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    await userEvent.type(screen.getByLabelText(/reason/i), 'Confirmed with front desk.');
    await userEvent.click(screen.getByRole('button', { name: /confirm resolution/i }));

    expect(mocks.resolveDiscrepancy).toHaveBeenCalledWith('1', 'Confirmed with front desk.');
  });

  it('does not offer Resolve on an already-resolved row', async () => {
    mocks.listDiscrepancies.mockResolvedValue([{ ...OPEN, resolved_at: '2027-01-02T00:00:00Z' }]);
    render(<DiscrepanciesTab canManage />);
    await screen.findByText('vacant');
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): resolving a discrepancy is a supervisor
   * decision (`housekeeping.manage`-gated on the backend now). Reading the
   * list stays unchanged for everyone; only the action hides.
   */
  it('without canManage, the list still shows but Resolve never renders', async () => {
    render(<DiscrepanciesTab />);
    expect(await screen.findByText('vacant')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });
});
