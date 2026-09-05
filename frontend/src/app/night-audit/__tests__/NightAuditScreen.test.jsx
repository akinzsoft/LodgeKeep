import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NightAuditScreen } from '../NightAuditScreen.jsx';

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  runNightAudit: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, nightAuditApi: mocks };
});

describe('<NightAuditScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRuns.mockResolvedValue([]);
  });

  it('shows an empty run history by default', async () => {
    render(<NightAuditScreen />);
    expect(await screen.findByText(/has not run for this property yet/i)).toBeInTheDocument();
  });

  it('lists prior runs with a status pill', async () => {
    mocks.listRuns.mockResolvedValue([{ id: '1', business_date: '2027-01-01', status: 'COMPLETED', started_at: '2027-01-02T00:00:00Z', completed_at: '2027-01-02T00:01:00Z' }]);
    render(<NightAuditScreen />);
    expect(await screen.findByText('2027-01-01')).toBeInTheDocument();
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
  });

  it('requires confirmation before running, then shows the result', async () => {
    mocks.runNightAudit.mockResolvedValue({
      data: { business_date: '2027-01-01', room_revenue: '500.00', occupancy_pct: '75.00' },
      meta: { nextBusinessDate: '2027-01-02', exceptions: [] },
    });
    render(<NightAuditScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run night audit' }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(mocks.runNightAudit).not.toHaveBeenCalled();

    // Two buttons now share this name: the trigger behind the dialog, and
    // the dialog's own confirm button — the confirm button is the second.
    await userEvent.click(screen.getAllByRole('button', { name: 'Run night audit' })[1]);

    expect(mocks.runNightAudit).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('2027-01-02')).toBeInTheDocument();
  });

  it('surfaces an error when the run fails', async () => {
    mocks.runNightAudit.mockRejectedValue(new Error('Blocked'));
    render(<NightAuditScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run night audit' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Run night audit' })[1]);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('disables the run button while offline', async () => {
    render(<NightAuditScreen isOffline />);
    expect(await screen.findByText(/night audit cannot run until connectivity returns/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run night audit' })).toBeDisabled();
  });
});
