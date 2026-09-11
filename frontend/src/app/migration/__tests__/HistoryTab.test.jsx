import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HistoryTab } from '../HistoryTab.jsx';

const mocks = vi.hoisted(() => ({ listImportRuns: vi.fn(), rollbackImportRun: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, migrationApi: { ...actual.migrationApi, listImportRuns: mocks.listImportRuns, rollbackImportRun: mocks.rollbackImportRun } };
});

const COMPLETED_RUN = { id: '1', entity_type: 'guests', status: 'completed', rows_total: 5, rows_created: 5, rows_skipped: 0, created_at: '2026-09-01' };
const COMMITTING_RUN = { id: '2', entity_type: 'reservations', status: 'committing', rows_total: 10, rows_created: null, rows_skipped: null, created_at: '2026-09-02' };
const PARTIAL_RUN = { id: '3', entity_type: 'companies', status: 'partially_rolled_back', rows_total: 4, rows_created: 4, rows_skipped: 0, created_at: '2026-09-03' };

describe('<HistoryTab>', () => {
  beforeEach(() => {
    mocks.listImportRuns.mockReset();
    mocks.rollbackImportRun.mockReset();
  });

  it('shows every run with a real status pill, never folding partially_rolled_back into "completed"', async () => {
    mocks.listImportRuns.mockResolvedValue([COMPLETED_RUN, PARTIAL_RUN]);
    render(<HistoryTab />);
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(await screen.findByText('Partially rolled back')).toBeInTheDocument();
  });

  it('rollback is only offered for a completed or partially_rolled_back run', async () => {
    mocks.listImportRuns.mockResolvedValue([COMPLETED_RUN, COMMITTING_RUN]);
    render(<HistoryTab />);
    const rows = await screen.findAllByRole('row');
    expect(within(rows[1]).getByRole('button', { name: /roll back/i })).toBeInTheDocument();
    expect(within(rows[2]).queryByRole('button', { name: /roll back/i })).not.toBeInTheDocument();
  });

  it('rollback requires a reason and reports refused rows honestly', async () => {
    mocks.listImportRuns.mockResolvedValue([COMPLETED_RUN]);
    mocks.rollbackImportRun.mockResolvedValue({
      importRunId: '1',
      status: 'partially_rolled_back',
      rowsRolledBack: 3,
      rowsRefused: [{ entityType: 'guest', entityId: '99', rowNumber: 2, reason: 'A reservation now references this guest.' }],
    });

    render(<HistoryTab />);
    await userEvent.click(await screen.findByRole('button', { name: /roll back/i }));

    const dialog = await screen.findByRole('alertdialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Roll back' });
    expect(confirmButton).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/reason/i), 'Wrong file uploaded');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));

    await waitFor(() => expect(mocks.rollbackImportRun).toHaveBeenCalledWith('1', 'Wrong file uploaded'));
    expect(await screen.findByText(/3 record\(s\) rolled back/)).toBeInTheDocument();
    expect(await screen.findByText(/A reservation now references this guest\./)).toBeInTheDocument();
  });

  it('calls onResume with the run id when Resume is clicked', async () => {
    mocks.listImportRuns.mockResolvedValue([COMPLETED_RUN]);
    const onResume = vi.fn();
    render(<HistoryTab onResume={onResume} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledWith('1');
  });

  it('an empty history shows an honest empty state, not a blank table', async () => {
    mocks.listImportRuns.mockResolvedValue([]);
    render(<HistoryTab />);
    expect(await screen.findByText(/no import runs yet/i)).toBeInTheDocument();
  });

  it('surfaces a real backend error without crashing the rest of the tab', async () => {
    mocks.listImportRuns.mockRejectedValue(new Error('boom'));
    render(<HistoryTab />);
    expect(await screen.findByText('Could not load import history.')).toBeInTheDocument();
  });

  it('disables rollback while offline', async () => {
    mocks.listImportRuns.mockResolvedValue([COMPLETED_RUN]);
    render(<HistoryTab isOffline />);
    expect(await screen.findByRole('button', { name: /roll back/i })).toBeDisabled();
  });
});
