import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { nightAuditApi, ApiError } from '../../shared/api/index.js';
import styles from './NightAuditScreen.module.css';

// Exported so HomeDashboard's "Night audit for today's business date" alert
// row maps the same status strings to the same tones, rather than a second,
// possibly-drifting copy of this vocabulary (DESIGN_SYSTEM.md §1: a status
// word's tone mapping is owned by the module that defines the status, not
// invented again by a consumer).
export const STATUS_TONE = { COMPLETED: 'success', FAILED: 'danger', RUNNING: 'warning', STALE: 'warning', RECOVERABLE: 'warning' };

/**
 * NightAuditScreen — PLAN.md Phase 2.5, PRODUCT_REQUIREMENTS.md §3.10.
 *
 * DESIGN_SYSTEM.md §2: "anything irreversible ... (run night audit) requires
 * an explicit confirm step stating the consequence in plain words" — night
 * audit closes the business date and cannot be undone, so it goes through
 * `ConfirmDialog` like any other financial/irreversible action, not a bare
 * button.
 */
export function NightAuditScreen({ isOffline = false }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  async function reload() {
    try {
      setRuns(await nightAuditApi.listRuns());
    } catch (caught) {
      setRuns([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load night audit history.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  async function handleRun() {
    setConfirming(false);
    setRunning(true);
    setError(null);
    setLastResult(null);
    try {
      const result = await nightAuditApi.runNightAudit();
      setLastResult(result);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Night audit could not complete.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Night Audit</h1>

      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}

      {isOffline && <p className={styles.disabledNotice}>You are offline. Night audit cannot run until connectivity returns.</p>}

      {lastResult && (
        <Card title="Last run result">
          <dl className={styles.resultGrid}>
            <div>
              <dt>Business date closed</dt>
              <dd>{lastResult.data.business_date}</dd>
            </div>
            <div>
              <dt>Room revenue</dt>
              <dd>
                <Money amount={lastResult.data.room_revenue} currencyCode="NGN" />
              </dd>
            </div>
            <div>
              <dt>Occupancy</dt>
              <dd>{lastResult.data.occupancy_pct}%</dd>
            </div>
            <div>
              <dt>Next business date</dt>
              <dd>{lastResult.meta.nextBusinessDate}</dd>
            </div>
            <div>
              <dt>Exceptions flagged</dt>
              <dd>{lastResult.meta.exceptions?.length ?? 0}</dd>
            </div>
          </dl>
        </Card>
      )}

      <div className={styles.actionsRow}>
        <Button disabled={isOffline || running} loading={running} onClick={() => setConfirming(true)}>
          Run night audit
        </Button>
      </div>

      <DataTable
        title="Run history"
        state={runs === null ? 'loading' : 'success'}
        emptyMessage="Night audit has not run for this property yet."
        columns={[
          { key: 'business_date', label: 'Business date' },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={STATUS_TONE[row.status] ?? 'neutral'} label={row.status} /> },
          { key: 'started_at', label: 'Started' },
          { key: 'completed_at', label: 'Completed' },
        ]}
        rows={runs ?? []}
        rowKey={(row) => row.id}
      />

      {confirming && (
        <ConfirmDialog
          title="Run night audit"
          consequence="This posts room charges for every in-house folio, closes today's business date, and advances the property to the next day. This cannot be undone."
          confirmLabel="Run night audit"
          onConfirm={handleRun}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
