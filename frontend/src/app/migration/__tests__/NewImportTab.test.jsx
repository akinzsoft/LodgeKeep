import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewImportTab } from '../NewImportTab.jsx';

const mocks = vi.hoisted(() => ({
  uploadImport: vi.fn(),
  getImportRun: vi.fn(),
  runDryRun: vi.fn(),
  resolveDuplicate: vi.fn(),
  commitImportRun: vi.fn(),
  listProperties: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    migrationApi: {
      ...actual.migrationApi,
      uploadImport: mocks.uploadImport,
      getImportRun: mocks.getImportRun,
      runDryRun: mocks.runDryRun,
      resolveDuplicate: mocks.resolveDuplicate,
      commitImportRun: mocks.commitImportRun,
    },
    setupApi: { ...actual.setupApi, listProperties: mocks.listProperties },
  };
});

/** Mirrors DataMigrationScreen's own screen-level activeRunId state, so this tab can be tested as a controlled component the way it's actually used. */
function Harness({ isOffline = false, initialRunId = null }) {
  const [activeRunId, setActiveRunId] = useState(initialRunId);
  return <NewImportTab isOffline={isOffline} activeRunId={activeRunId} onRunChange={setActiveRunId} />;
}

const UPLOADED_RUN = {
  id: '1',
  entity_type: 'guests',
  status: 'uploaded',
  rows_total: null,
  rows_created: null,
  rows_skipped: null,
  failed_reason: null,
};

const DRY_RUN_CLEAN = { ...UPLOADED_RUN, status: 'dry_run_complete', rows_total: 3, rows_created: 3, rows_skipped: 0 };

describe('<NewImportTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listProperties.mockResolvedValue([{ id: '1', name: 'Alpha Hotels — Main' }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the property picker only appears for property-required entity types', async () => {
    render(<Harness />);
    expect(screen.queryByLabelText(/property/i)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/entity type/i), 'reservations');
    expect(await screen.findByLabelText(/property/i)).toBeInTheDocument();
  });

  it('uploading a file creates a run and immediately runs the dry run', async () => {
    mocks.uploadImport.mockResolvedValue(UPLOADED_RUN);
    mocks.runDryRun.mockResolvedValue({ run: DRY_RUN_CLEAN, errors: [] });

    render(<Harness />);
    const file = new File(['first_name,last_name\nJane,Doe\n'], 'guests.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText(/csv file/i), file);
    await userEvent.click(screen.getByRole('button', { name: /upload & run dry run/i }));

    await waitFor(() => expect(mocks.uploadImport).toHaveBeenCalledWith({ entityType: 'guests', propertyId: undefined, file }));
    await waitFor(() => expect(mocks.runDryRun).toHaveBeenCalledWith('1'));
    expect(await screen.findByText('Will create')).toBeInTheDocument();
  });

  it('nothing is written until commit — the dry-run preview says so, and blocking errors render in a table', async () => {
    mocks.getImportRun.mockResolvedValue({
      run: { ...DRY_RUN_CLEAN, rows_created: 2, rows_skipped: 1 },
      errors: [{ id: '1', row_number: 4, column_name: 'email', severity: 'error', message: 'Missing required field', resolution: null }],
    });
    render(<Harness initialRunId="1" />);
    expect(await screen.findByText(/nothing has been written yet/i)).toBeInTheDocument();
    expect(screen.getByText('Missing required field')).toBeInTheDocument();
  });

  it('commit is disabled until every duplicate candidate is resolved, then enabled', async () => {
    mocks.getImportRun.mockResolvedValue({
      run: DRY_RUN_CLEAN,
      errors: [
        {
          id: '1',
          row_number: 2,
          column_name: null,
          severity: 'duplicate_candidate',
          message: 'Matches 1 existing guest(s) on email (id: 42).',
          resolution: null,
          resolved_guest_id: null,
        },
      ],
    });
    render(<Harness initialRunId="1" />);

    const commitButton = await screen.findByRole('button', { name: /commit import/i });
    expect(commitButton).toBeDisabled();
    expect(await screen.findByText(/still need a duplicate decision/i)).toBeInTheDocument();

    mocks.resolveDuplicate.mockResolvedValue({ id: '1', row_number: 2, resolution: 'use_existing', resolved_guest_id: '42' });
    mocks.getImportRun.mockResolvedValueOnce({
      run: DRY_RUN_CLEAN,
      errors: [
        {
          id: '1',
          row_number: 2,
          column_name: null,
          severity: 'duplicate_candidate',
          message: 'Matches 1 existing guest(s) on email (id: 42).',
          resolution: null,
          resolved_guest_id: null,
        },
      ],
    });

    await userEvent.selectOptions(screen.getByLabelText(/decision/i), 'use_existing');
    await userEvent.click(screen.getByRole('button', { name: /save decision/i }));
    await waitFor(() => expect(mocks.resolveDuplicate).toHaveBeenCalledWith('1', 2, 'use_existing', '42'));
  });

  it('committing opens a confirm dialog stating the consequence, then calls commit', async () => {
    mocks.getImportRun.mockResolvedValue({ run: DRY_RUN_CLEAN, errors: [] });
    mocks.commitImportRun.mockResolvedValue({ ...DRY_RUN_CLEAN, status: 'committing' });

    render(<Harness initialRunId="1" />);
    await userEvent.click(await screen.findByRole('button', { name: /commit import/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/rolled back afterward from history/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /commit import/i }));

    await waitFor(() => expect(mocks.commitImportRun).toHaveBeenCalledWith('1'));
    expect(await screen.findByText('committing')).toBeInTheDocument();
  });

  it('polls while committing and shows the completed summary once the job finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.getImportRun
      .mockResolvedValueOnce({ run: { ...DRY_RUN_CLEAN, status: 'committing' }, errors: [] })
      .mockResolvedValueOnce({ run: { ...DRY_RUN_CLEAN, status: 'completed' }, errors: [] });

    render(<Harness initialRunId="1" />);
    expect(await screen.findByText(/importing rows now/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(mocks.getImportRun).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/see the history tab to roll this run back/i)).toBeInTheDocument();
  });

  it('a failed run shows its own failure reason', async () => {
    mocks.getImportRun.mockResolvedValue({ run: { ...DRY_RUN_CLEAN, status: 'failed', failed_reason: 'Could not read the file' }, errors: [] });
    render(<Harness initialRunId="1" />);
    expect(await screen.findByText('Could not read the file')).toBeInTheDocument();
  });

  it('"Start a new import" clears the run and returns to the upload form', async () => {
    mocks.getImportRun.mockResolvedValue({ run: DRY_RUN_CLEAN, errors: [] });
    render(<Harness initialRunId="1" />);
    // Wait for the real, fully-loaded view (not the loading-state's own
    // identically-labelled button) before clicking, or userEvent may click
    // a DOM node React has already replaced once the mocked fetch resolves.
    expect(await screen.findByText(/import run #1/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /start a new import/i }));
    expect(await screen.findByRole('button', { name: /upload & run dry run/i })).toBeInTheDocument();
  });

  it('disables the upload button while offline', async () => {
    render(<Harness isOffline />);
    const file = new File(['a'], 'guests.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText(/csv file/i), file);
    expect(screen.getByRole('button', { name: /upload & run dry run/i })).toBeDisabled();
  });
});
