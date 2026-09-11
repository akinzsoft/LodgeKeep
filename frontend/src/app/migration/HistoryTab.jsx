import { useEffect, useState } from 'react';
import { DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { migrationApi, ApiError } from '../../shared/api/index.js';
import formStyles from './MigrationForm.module.css';

const ROLLBACKABLE_STATUSES = new Set(['completed', 'partially_rolled_back']);

/** DESIGN_SYSTEM.md §1: status is always a filled pill with a text label, never colour alone. `partially_rolled_back` renders honestly as its own distinct status — never folded into "completed." */
const RUN_STATUS = {
  uploaded: { tone: 'neutral', label: 'Uploaded' },
  dry_run_complete: { tone: 'warning', label: 'Dry run complete' },
  committing: { tone: 'warning', label: 'Committing' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'danger', label: 'Failed' },
  rolled_back: { tone: 'neutral', label: 'Rolled back' },
  partially_rolled_back: { tone: 'warning', label: 'Partially rolled back' },
};

/**
 * HistoryTab — PRODUCT_REQUIREMENTS.md §3.20: "every run listed with its
 * id, date, operator, counts, and a roll back action. Assume the first
 * attempt will be wrong." Rollback is `ConfirmDialog`-gated with a required
 * reason (DESIGN_SYSTEM.md §2's money/irreversible-action rule — deleting
 * real imported records is exactly that class of action), and its own
 * result — including any rows the backend genuinely refused to reverse
 * because real activity has since landed against them — is shown inline,
 * never silently dropped.
 */
export function HistoryTab({ isOffline = false, onResume }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [rollingBackId, setRollingBackId] = useState(null);
  const [rollbackTarget, setRollbackTarget] = useState(null);
  const [rollbackError, setRollbackError] = useState(null);
  const [lastRollbackResult, setLastRollbackResult] = useState(null);

  async function reload() {
    setError(null);
    try {
      setRuns(await migrationApi.listImportRuns());
    } catch (caught) {
      setRuns([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load import history.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  async function handleRollback(reason) {
    const run = rollbackTarget;
    setRollingBackId(run.id);
    setRollbackTarget(null);
    setRollbackError(null);
    try {
      const result = await migrationApi.rollbackImportRun(run.id, reason);
      setLastRollbackResult({ runId: run.id, ...result });
      await reload();
    } catch (caught) {
      setRollbackError(caught instanceof ApiError ? caught.message : 'Could not roll back this import.');
    } finally {
      setRollingBackId(null);
    }
  }

  return (
    <div>
      {rollbackError && (
        <p role="alert" className={formStyles.errorBanner}>
          {rollbackError}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Rollback is disabled until connectivity returns.</p>}

      {lastRollbackResult && (
        <div className={formStyles.hint}>
          <p>
            Run #{lastRollbackResult.runId}: {lastRollbackResult.rowsRolledBack} record(s) rolled back.
            {lastRollbackResult.rowsRefused.length > 0 &&
              ` ${lastRollbackResult.rowsRefused.length} record(s) could not be rolled back:`}
          </p>
          {lastRollbackResult.rowsRefused.length > 0 && (
            <ul>
              {lastRollbackResult.rowsRefused.map((refused, index) => (
                <li key={`${refused.entityType}-${refused.entityId}-${index}`}>
                  Row {refused.rowNumber} ({refused.entityType} #{refused.entityId}): {refused.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <DataTable
        title="Import runs"
        state={runs === null ? 'loading' : error ? 'error' : runs.length === 0 ? 'empty' : 'success'}
        emptyMessage="No import runs yet — start one from the New Import tab."
        errorMessage={error}
        columns={[
          { key: 'id', label: 'Run' },
          { key: 'entity_type', label: 'Entity' },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={(RUN_STATUS[row.status] ?? {}).tone ?? 'neutral'} label={(RUN_STATUS[row.status] ?? {}).label ?? row.status} /> },
          { key: 'rows_total', label: 'Total', render: (row) => row.rows_total ?? '—' },
          { key: 'rows_created', label: 'Created', render: (row) => row.rows_created ?? '—' },
          { key: 'rows_skipped', label: 'Skipped', render: (row) => row.rows_skipped ?? '—' },
          { key: 'created_at', label: 'Uploaded' },
        ]}
        rows={runs ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <div className={formStyles.actionsRow}>
            <Button size="compact" variant="secondary" onClick={() => onResume?.(row.id)}>
              Resume
            </Button>
            {ROLLBACKABLE_STATUSES.has(row.status) && (
              <Button size="compact" variant="danger" disabled={isOffline} loading={rollingBackId === row.id} onClick={() => setRollbackTarget(row)}>
                Roll back
              </Button>
            )}
          </div>
        )}
      />

      {rollbackTarget && (
        <ConfirmDialog
          title={`Roll back run #${rollbackTarget.id}?`}
          consequence={`Every record this run created and that has no real activity against it since will be permanently deleted. Any record that has since accumulated real activity (a stay, a payment, a linked reservation) will be left in place and reported back.`}
          requireReason
          confirmLabel="Roll back"
          onConfirm={handleRollback}
          onCancel={() => setRollbackTarget(null)}
        />
      )}
    </div>
  );
}
