import { useEffect, useState } from 'react';
import { Button, Card, ConfirmDialog, DataTable, StatusPill } from '../../shared/components/index.js';
import { doorAccessApi, ApiError } from '../../shared/api/index.js';
import { RULE_LABELS, SEVERITY_TONE, STATUS_TONE, capitalize, describeAge, formatInZone } from './format.js';
import styles from './DoorAccess.module.css';

/**
 * Alert inbox + evidence view — PRODUCT_REQUIREMENTS.md §3.23. Every alert
 * here came from an uploaded lock log, so each carries a visible
 * "retrospective — occurred N days ago" pill: a manager must be able to tell
 * at a glance they are looking at history, not something happening now.
 */
export function AlertsTab({ config, isOffline = false }) {
  const [status, setStatus] = useState('open');
  const [rule, setRule] = useState('');
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  async function reload(filters = { status, rule }) {
    setError(null);
    try {
      setAlerts(await doorAccessApi.listAlerts(filters));
    } catch (caught) {
      setAlerts([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load alerts.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time fetch only; filter changes call reload() explicitly with their new values
  }, []);

  function changeFilter(next) {
    const filters = { status, rule, ...next };
    if ('status' in next) setStatus(next.status);
    if ('rule' in next) setRule(next.rule);
    reload(filters);
  }

  return (
    <>
      {/* Filters sit outside DataTable deliberately: its toolbar only renders
          in the success state, and "no open alerts" is the normal case. */}
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Status</span>
          <select className={styles.select} value={status} onChange={(e) => changeFilter({ status: e.target.value })}>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="">All</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Rule</span>
          <select className={styles.select} value={rule} onChange={(e) => changeFilter({ rule: e.target.value })}>
            <option value="">All rules</option>
            {Object.entries(RULE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <DataTable
        title="Door access alerts"
        state={alerts === null ? 'loading' : error ? 'error' : 'success'}
        errorMessage={error}
        emptyMessage={
          status === 'open'
            ? 'No open alerts. Alerts appear only after a lock log is imported — no alerts does not mean no activity since the last import.'
            : 'No alerts match these filters.'
        }
        columns={[
          { key: 'severity', label: 'Severity', render: (row) => <StatusPill tone={SEVERITY_TONE[row.severity] ?? 'neutral'} label={capitalize(row.severity)} /> },
          { key: 'room_number', label: 'Room' },
          { key: 'rule', label: 'Rule', render: (row) => RULE_LABELS[row.rule] ?? row.rule },
          { key: 'first_event_at', label: 'First door opening', render: (row) => formatInZone(row.first_event_at, config.timezone) },
          { key: 'age', label: 'Detected', render: (row) => <StatusPill tone="neutral" label={describeAge(row.first_event_at)} /> },
          { key: 'event_count', label: 'Openings', align: 'right' },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={STATUS_TONE[row.status] ?? 'neutral'} label={capitalize(row.status)} /> },
        ]}
        rows={alerts ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <Button variant="secondary" size="compact" onClick={() => setSelectedId(row.id)}>
            View evidence
          </Button>
        )}
      />

      {selectedId && (
        <AlertDetail
          key={selectedId}
          alertId={selectedId}
          config={config}
          isOffline={isOffline}
          onClose={() => setSelectedId(null)}
          onChanged={() => reload()}
        />
      )}
    </>
  );
}

function AlertDetail({ alertId, config, isOffline, onClose, onChanged }) {
  const [alert, setAlert] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setAlert(await doorAccessApi.getAlert(alertId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this alert.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; keyed by alertId in the parent
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remounted per alert via key
  }, []);

  async function run(action) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await load();
      onChanged();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'That action could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Card state="error" title="Alert evidence" errorMessage={error} />;
  if (!alert) return <Card state="loading" title="Alert evidence" />;

  const evidence = alert.evidence ?? {};
  const previous = evidence.previousStay;
  const tz = config.timezone;

  return (
    <Card title={`Evidence — room ${alert.room_number}, ${RULE_LABELS[alert.rule] ?? alert.rule}`}>
      <div className={styles.panel}>
        {actionError && (
          <p className={styles.errorBanner} role="alert">
            {actionError}
          </p>
        )}
        <p className={styles.warningBanner}>
          {describeAge(alert.first_event_at)}. This was found when a lock log was uploaded, not as it happened.
        </p>

        <dl className={styles.definitionList}>
          <dt>Status</dt>
          <dd>
            <StatusPill tone={STATUS_TONE[alert.status] ?? 'neutral'} label={capitalize(alert.status)} />
          </dd>
          <dt>Card</dt>
          <dd>
            {alert.card_id}
            {evidence.cardType ? ` (${evidence.cardType})` : ''}
          </dd>
          <dt>Door openings</dt>
          <dd>
            {alert.event_count}, from {formatInZone(alert.first_event_at, tz)} to {formatInZone(alert.last_event_at, tz)}
          </dd>
          <dt>Previous stay in room</dt>
          <dd>
            {previous
              ? `${previous.guestName ?? 'Guest'} (${previous.confirmationNumber ?? previous.reservationId}) — room vacated by ${
                  previous.vacatedBy === 'checkout' ? 'checkout' : 'room move'
                } at ${formatInZone(previous.roomVacatedAt, tz)}`
              : 'No earlier stay recorded in this room'}
          </dd>
          {evidence.roomAtDetection && (
            <>
              <dt>Room when detected</dt>
              <dd>
                {evidence.roomAtDetection.frontDeskStatus}, {evidence.roomAtDetection.housekeepingStatus}
                {evidence.roomAtDetection.hasDiscrepancy ? ', housekeeping discrepancy open' : ''}
              </dd>
            </>
          )}
          {alert.status === 'resolved' && (
            <>
              <dt>Resolution</dt>
              <dd>{alert.resolution_reason}</dd>
            </>
          )}
        </dl>

        <DataTable
          title="Room activity around this alert (24 hours either side)"
          columns={[
            { key: 'opened_at', label: 'Opened', render: (row) => formatInZone(row.opened_at, tz) },
            { key: 'card_id', label: 'Card' },
            { key: 'card_type', label: 'Card type', render: (row) => row.card_type ?? '—' },
            { key: 'result', label: 'Result' },
          ]}
          rows={alert.roomTimeline ?? []}
          rowKey={(row) => row.id}
          emptyMessage="No other door openings in this window."
        />

        {isOffline && <p className={styles.notice}>You are offline. Acknowledging and resolving are disabled until connectivity returns.</p>}
        <div className={styles.actionsRow}>
          {alert.status === 'open' && (
            <Button variant="secondary" disabled={isOffline || busy} onClick={() => run(() => doorAccessApi.acknowledgeAlert(alert.id))}>
              Acknowledge
            </Button>
          )}
          {alert.status !== 'resolved' && (
            <Button disabled={isOffline || busy} onClick={() => setResolving(true)}>
              Resolve
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {resolving && (
        <ConfirmDialog
          title="Resolve alert"
          consequence={`This closes the alert for room ${alert.room_number}. It stays in the alert history with your reason and cannot be reopened.`}
          requireReason
          confirmLabel="Resolve alert"
          onConfirm={(reason) => {
            setResolving(false);
            run(() => doorAccessApi.resolveAlert(alert.id, reason));
          }}
          onCancel={() => setResolving(false)}
        />
      )}
    </Card>
  );
}
