import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataMigrationScreen } from '../DataMigrationScreen.jsx';

const mocks = vi.hoisted(() => ({
  listImportRuns: vi.fn(),
  getImportRun: vi.fn(),
  downloadTemplate: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    migrationApi: {
      ...actual.migrationApi,
      listImportRuns: mocks.listImportRuns,
      getImportRun: mocks.getImportRun,
      downloadTemplate: mocks.downloadTemplate,
    },
  };
});

const RUN = { id: '7', entity_type: 'guests', status: 'completed', rows_total: 3, rows_created: 3, rows_skipped: 0, created_at: '2026-09-01' };

describe('<DataMigrationScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listImportRuns.mockResolvedValue([RUN]);
    mocks.getImportRun.mockResolvedValue({ run: RUN, errors: [] });
  });

  it('defaults to the Templates tab', async () => {
    render(<DataMigrationScreen />);
    expect(await screen.findByRole('tab', { name: 'Templates' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /guest profiles/i })).toBeInTheDocument();
  });

  it('switches tabs on click', async () => {
    render(<DataMigrationScreen />);
    await userEvent.click(screen.getByRole('tab', { name: 'New Import' }));
    expect(screen.getByRole('tab', { name: 'New Import' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('button', { name: /upload & run dry run/i })).toBeInTheDocument();
  });

  it('clicking Resume on a History row switches to New Import with that run loaded', async () => {
    render(<DataMigrationScreen />);
    await userEvent.click(screen.getByRole('tab', { name: 'History' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));

    expect(screen.getByRole('tab', { name: 'New Import' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/import run #7/i)).toBeInTheDocument();
    expect(mocks.getImportRun).toHaveBeenCalledWith('7');
  });
});
