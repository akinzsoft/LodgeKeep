import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WaitlistTab } from '../WaitlistTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listWaitlist: vi.fn(),
  promoteWaitlist: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    reservationsApi: { listWaitlist: mocks.listWaitlist, promoteWaitlist: mocks.promoteWaitlist },
  };
});

describe('<WaitlistTab>', () => {
  beforeEach(() => {
    mocks.listWaitlist.mockReset();
    mocks.promoteWaitlist.mockReset();
  });

  it('shows the genuine empty state when there really is no one waitlisted', async () => {
    mocks.listWaitlist.mockResolvedValue([]);
    render(<WaitlistTab />);

    expect(await screen.findByText('No one is currently waitlisted.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('bug fix: a real fetch failure is visible, not masked as "No one is currently waitlisted"', async () => {
    mocks.listWaitlist.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'The waitlist could not be loaded right now.' }));
    render(<WaitlistTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The waitlist could not be loaded right now.');
  });

  it('lists a real waitlisted reservation and promotes it', async () => {
    mocks.listWaitlist.mockResolvedValue([
      { id: '26', confirmation_number: 'ABC123', arrival_date: '2026-09-20', departure_date: '2026-09-21', adults: 1 },
    ]);
    mocks.promoteWaitlist.mockResolvedValue({ id: '26', status: 'confirmed' });
    render(<WaitlistTab />);

    expect(await screen.findByText('ABC123')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Promote' }));

    expect(mocks.promoteWaitlist).toHaveBeenCalledWith('26');
  });

  it('bug fix: a real promote failure is visible even once the list is refetched as empty', async () => {
    mocks.listWaitlist.mockResolvedValueOnce([
      { id: '26', confirmation_number: 'ABC123', arrival_date: '2026-09-20', departure_date: '2026-09-21', adults: 1 },
    ]);
    mocks.promoteWaitlist.mockRejectedValue(
      new ApiError({ code: 'BUSINESS_RULE_OVERBOOKING_THRESHOLD_EXCEEDED', message: 'No sellable inventory left for this room type.' })
    );
    render(<WaitlistTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Promote' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No sellable inventory left');
  });
});
