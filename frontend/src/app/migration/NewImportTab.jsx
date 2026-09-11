import { useEffect, useRef, useState } from 'react';
import { Card, Button, DataTable, ConfirmDialog, StatusPill } from '../../shared/components/index.js';
import { migrationApi, setupApi, ApiError } from '../../shared/api/index.js';
import formStyles from './MigrationForm.module.css';

const PROPERTY_REQUIRED_ENTITY_TYPES = new Set(['reservations', 'ar_balances']);

/** DESIGN_SYSTEM.md §1: status is always a filled pill with a text label, never colour alone — owned here since this tab is the one place a run's own lifecycle status renders. */
const RUN_STATUS_TONE = {
  uploaded: 'neutral',
  dry_run_complete: 'warning',
  committing: 'warning',
  completed: 'success',
  failed: 'danger',
  rolled_back: 'neutral',
  partially_rolled_back: 'warning',
};

/**
 * The backend's own `severity: 'duplicate_candidate'` finding carries only a
 * human-readable message naming the matching guest id(s)
 * (`"...( id: 42)."` / `"...(ids: 42, 43)."`) — no separate structured
 * candidate list exists in the response. Parsing it back out here is a
 * pragmatic, honest reflection of the real data rather than inventing a
 * backend change this frontend-only pass is not scoped to make.
 */
function parseCandidateGuestIds(message) {
  const match = /\(ids?: ([\d, ]+)\)/.exec(message ?? '');
  if (!match) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * NewImportTab — PRODUCT_REQUIREMENTS.md §3.20's "Upload & dry run,"
 * "Duplicate review," "Availability conflicts," and "Commit & progress"
 * screens combined into one tab, since they all operate on the SAME run
 * moving through its own lifecycle (`uploaded` -> `dry_run_complete` ->
 * `committing` -> `completed`/`failed`/`rolled_back`/`partially_rolled_back`)
 * rather than four independent screens.
 *
 * No push/SSE mechanism exists anywhere in this app — while `status` is
 * `committing`, this tab polls `GET /migration/imports/:id` on a plain
 * interval, the same "poll, don't push" shape every other async-job-backed
 * screen in this app already accepts (no dedicated precedent existed to
 * copy verbatim, but this matches `NightAuditScreen`'s own manual-reload
 * idiom, made automatic here since a commit can run unattended).
 */
export function NewImportTab({ isOffline = false, activeRunId, onRunChange }) {
  const [entityType, setEntityType] = useState('guests');
  const [propertyId, setPropertyId] = useState('');
  const [properties, setProperties] = useState(null);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const [run, setRun] = useState(null);
  const [errors, setErrors] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [resolvingRow, setResolvingRow] = useState(null);
  const [resolveError, setResolveError] = useState(null);
  const [confirmCommitOpen, setConfirmCommitOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState(null);

  const pollRef = useRef(null);

  // Tracks the operator's CURRENT `activeRunId`, so an in-flight
  // `loadRun`/`runDryRun` call that resolves after the operator has since
  // clicked "Start a new import" can tell its own result is stale before
  // applying it. Without this, a slow `getImportRun` response arriving
  // after `startOver()` has already cleared `run`/`activeRunId` would
  // silently resurrect the old run's data on top of the fresh upload form —
  // found by this pass's own test suite, not by inspection. Kept in sync
  // two ways: this effect covers an ordinary prop change (e.g. History's
  // "Resume"), while `handleUpload`/`startOver` below write it directly,
  // synchronously, in their own event-handler bodies — refs may not be
  // mutated during render itself, only in effects/handlers.
  const currentRunIdRef = useRef(activeRunId);
  useEffect(() => {
    currentRunIdRef.current = activeRunId;
  }, [activeRunId]);

  // Set right before `handleUpload` calls `onRunChange` with a freshly
  // created run — suppresses the mount-style effect below from ALSO
  // fetching that same run via `getImportRun` the instant `activeRunId`
  // changes, which would otherwise race the explicit `runDryRun` call
  // `handleUpload` already makes with genuinely fresher data. Real
  // duplicate-fetch bug, not just a test-timing artifact: in production
  // this would briefly flash whichever of the two responses lands last.
  const skipNextLoadRef = useRef(false);

  useEffect(() => {
    if (PROPERTY_REQUIRED_ENTITY_TYPES.has(entityType) && properties === null) {
      setupApi
        .listProperties()
        .then(setProperties)
        .catch(() => setProperties([]));
    }
  }, [entityType, properties]);

  async function loadRun(id) {
    try {
      const result = await migrationApi.getImportRun(id);
      if (currentRunIdRef.current !== id) return; // stale — the operator has since moved on
      setRun(result.run);
      setErrors(result.errors);
      setLoadError(null);
    } catch (caught) {
      if (currentRunIdRef.current !== id) return;
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load this import run.');
    }
  }

  useEffect(() => {
    if (!activeRunId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing local run state as activeRunId itself clears (the parent-owned "start a fresh import" signal), not a synchronization loop
      setRun(null);
      setErrors([]);
      return;
    }
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false;
      return;
    }
    loadRun(activeRunId);
  }, [activeRunId]);

  useEffect(() => {
    if (run?.status === 'committing' && activeRunId) {
      pollRef.current = setInterval(() => loadRun(activeRunId), 2000);
      return () => clearInterval(pollRef.current);
    }
    return undefined;
  }, [run?.status, activeRunId]);

  async function runDryRun(id) {
    setDryRunning(true);
    setLoadError(null);
    try {
      const result = await migrationApi.runDryRun(id);
      if (currentRunIdRef.current !== id) return; // stale — the operator has since moved on
      setRun(result.run);
      setErrors(result.errors);
    } catch (caught) {
      if (currentRunIdRef.current !== id) return;
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not run the dry run.');
    } finally {
      setDryRunning(false);
    }
  }

  async function handleUpload(event) {
    event.preventDefault();
    setUploading(true);
    setUploadError(null);
    try {
      const created = await migrationApi.uploadImport({ entityType, propertyId: propertyId || undefined, file });
      // Keep the ref in sync immediately, synchronously — don't wait for
      // the re-render `onRunChange` triggers (React may not have re-run
      // this component's render, and therefore not yet re-assigned
      // `currentRunIdRef.current`, before the `runDryRun` call below
      // resolves), or its own stale-response guard would wrongly discard
      // this genuinely fresh result.
      currentRunIdRef.current = created.id;
      skipNextLoadRef.current = true;
      onRunChange(created.id);
      setFile(null);
      // Nothing is written until the operator confirms commit — kicking the
      // dry run off immediately just makes "Upload & dry run" read as one
      // step, per §3.20's own UI text; the "Run dry run" button below is
      // the fallback if this call itself fails.
      await runDryRun(created.id);
    } catch (caught) {
      setUploadError(caught instanceof ApiError ? caught.message : 'Could not upload this file.');
    } finally {
      setUploading(false);
    }
  }

  async function handleResolve(rowNumber, resolution, matchedGuestId) {
    setResolvingRow(rowNumber);
    setResolveError(null);
    try {
      await migrationApi.resolveDuplicate(activeRunId, rowNumber, resolution, matchedGuestId);
      await loadRun(activeRunId);
    } catch (caught) {
      setResolveError(caught instanceof ApiError ? caught.message : 'Could not save this duplicate resolution.');
    } finally {
      setResolvingRow(null);
    }
  }

  async function handleCommit() {
    setConfirmCommitOpen(false);
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await migrationApi.commitImportRun(activeRunId);
      setRun(result);
    } catch (caught) {
      setCommitError(caught instanceof ApiError ? caught.message : 'Could not commit this import.');
    } finally {
      setCommitting(false);
    }
  }

  function startOver() {
    currentRunIdRef.current = null;
    onRunChange(null);
    setRun(null);
    setErrors([]);
    setUploadError(null);
    setLoadError(null);
  }

  if (!activeRunId) {
    return (
      <Card title="Upload a spreadsheet">
        {uploadError && (
          <p role="alert" className={formStyles.errorBanner}>
            {uploadError}
          </p>
        )}
        {isOffline && <p className={formStyles.disabledNotice}>You are offline. Uploads are disabled until connectivity returns.</p>}
        <form className={formStyles.form} onSubmit={handleUpload}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Entity type</span>
              <select
                className={formStyles.select}
                value={entityType}
                onChange={(event) => {
                  setEntityType(event.target.value);
                  setPropertyId('');
                }}
              >
                {migrationApi.listEntityTypes().map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            {PROPERTY_REQUIRED_ENTITY_TYPES.has(entityType) && (
              <label className={formStyles.field}>
                <span className={formStyles.label}>Property</span>
                <select className={formStyles.select} value={propertyId} onChange={(event) => setPropertyId(event.target.value)} required>
                  <option value="">Select a property…</option>
                  {(properties ?? []).map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label className={formStyles.field}>
            <span className={formStyles.label}>CSV file</span>
            {/* Deliberately no `required` here — the submit button's own
                `disabled` check below is the real guard (and the only
                correct one: a file input's HTML5 constraint validation
                does not reliably recognise a programmatically-attached
                file as satisfying `required` in every test environment,
                only in a real browser's own native picker flow). */}
            <input
              type="file"
              accept=".csv,text/csv"
              className={formStyles.input}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button
              type="submit"
              loading={uploading}
              disabled={isOffline || !file || (PROPERTY_REQUIRED_ENTITY_TYPES.has(entityType) && !propertyId)}
            >
              Upload & run dry run
            </Button>
          </div>
        </form>
      </Card>
    );
  }

  if (!run) {
    return (
      <div>
        <div className={formStyles.actionsRow}>
          <Button type="button" variant="ghost" onClick={startOver}>
            Start a new import
          </Button>
        </div>
        <Card title="Import run" state={loadError ? 'error' : 'loading'} errorMessage={loadError} />
      </div>
    );
  }

  const duplicateErrors = errors.filter((e) => e.severity === 'duplicate_candidate');
  const blockingErrors = errors.filter((e) => e.severity === 'error');
  const conflictErrors = errors.filter((e) => e.severity === 'availability_conflict');
  const unresolvedCount = duplicateErrors.filter((e) => !e.resolution).length;
  const canCommit = run.status === 'dry_run_complete' && unresolvedCount === 0;

  return (
    <Card title={`Import run #${run.id} — ${run.entity_type}`}>
      <div className={formStyles.actionsRow}>
        <StatusPill tone={RUN_STATUS_TONE[run.status] ?? 'neutral'} label={run.status.replace(/_/g, ' ')} />
        <Button type="button" variant="ghost" onClick={startOver}>
          Start a new import
        </Button>
      </div>

      {loadError && (
        <p role="alert" className={formStyles.errorBanner}>
          {loadError}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Import actions are disabled until connectivity returns.</p>}

      {run.status === 'failed' && run.failed_reason && (
        <p role="alert" className={formStyles.errorBanner}>
          {run.failed_reason}
        </p>
      )}

      {run.status === 'uploaded' && (
        <>
          <p className={formStyles.hint}>Nothing is written to the database until you review a dry-run preview and explicitly confirm commit.</p>
          <div className={formStyles.actionsRow}>
            <Button type="button" loading={dryRunning} disabled={isOffline} onClick={() => runDryRun(activeRunId)}>
              Run dry run
            </Button>
          </div>
        </>
      )}

      {run.status === 'dry_run_complete' && (
        <>
          <p className={formStyles.hint}>Nothing has been written yet — review this preview, then confirm commit below.</p>

          <div className={formStyles.summaryRow}>
            <div className={formStyles.statTile}>
              <span className={formStyles.statLabel}>Total rows</span>
              <span className={formStyles.statValue}>{run.rows_total}</span>
            </div>
            <div className={formStyles.statTile}>
              <span className={formStyles.statLabel}>Will create</span>
              <span className={formStyles.statValue}>{run.rows_created}</span>
            </div>
            <div className={formStyles.statTile}>
              <span className={formStyles.statLabel}>Will skip</span>
              <span className={formStyles.statValue}>{run.rows_skipped}</span>
            </div>
          </div>

          {blockingErrors.length > 0 && (
            <DataTable
              title="Row errors"
              state="success"
              columns={[
                { key: 'row_number', label: 'Row' },
                { key: 'column_name', label: 'Column', render: (row) => row.column_name ?? '—' },
                { key: 'message', label: "What's wrong" },
              ]}
              rows={blockingErrors}
              rowKey={(row) => row.id}
            />
          )}

          {conflictErrors.length > 0 && (
            <DataTable
              title="Availability conflicts — not blocking, commit will still create these if confirmed"
              state="success"
              columns={[
                { key: 'row_number', label: 'Row' },
                { key: 'message', label: 'Conflict' },
              ]}
              rows={conflictErrors}
              rowKey={(row) => row.id}
            />
          )}

          {duplicateErrors.length > 0 && (
            <div>
              <h3>Likely duplicate guests — never auto-merged</h3>
              {resolveError && (
                <p role="alert" className={formStyles.errorBanner}>
                  {resolveError}
                </p>
              )}
              {duplicateErrors.map((candidate) => (
                <DuplicateCandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  candidateIds={parseCandidateGuestIds(candidate.message)}
                  isOffline={isOffline}
                  resolving={resolvingRow === candidate.row_number}
                  onResolve={handleResolve}
                />
              ))}
            </div>
          )}

          {unresolvedCount > 0 && (
            <p role="alert" className={formStyles.errorBanner}>
              {unresolvedCount} row(s) still need a duplicate decision before this run can be committed.
            </p>
          )}

          {commitError && (
            <p role="alert" className={formStyles.errorBanner}>
              {commitError}
            </p>
          )}

          <div className={formStyles.actionsRow}>
            <Button type="button" variant="secondary" loading={dryRunning} disabled={isOffline} onClick={() => runDryRun(activeRunId)}>
              Re-run dry run
            </Button>
            <Button type="button" disabled={isOffline || !canCommit} loading={committing} onClick={() => setConfirmCommitOpen(true)}>
              Commit import
            </Button>
          </div>
        </>
      )}

      {run.status === 'committing' && (
        <div>
          <p className={formStyles.hint}>
            Importing rows now — this can take a moment for a large file. You can navigate away and check the History tab later.
          </p>
          <div className={formStyles.progressTrack}>
            <div className={formStyles.progressFill} style={{ width: '60%' }} />
          </div>
        </div>
      )}

      {(run.status === 'completed' || run.status === 'rolled_back' || run.status === 'partially_rolled_back') && (
        <div className={formStyles.summaryRow}>
          <div className={formStyles.statTile}>
            <span className={formStyles.statLabel}>Created</span>
            <span className={formStyles.statValue}>{run.rows_created}</span>
          </div>
          <div className={formStyles.statTile}>
            <span className={formStyles.statLabel}>Skipped</span>
            <span className={formStyles.statValue}>{run.rows_skipped}</span>
          </div>
          <p className={formStyles.hint}>See the History tab to roll this run back if the data turns out to be wrong.</p>
        </div>
      )}

      {confirmCommitOpen && (
        <ConfirmDialog
          title="Commit this import?"
          consequence={`This will create up to ${run.rows_created} new record(s) from the row(s) this dry run approved. The run can be rolled back afterward from History if the data turns out to be wrong.`}
          confirmLabel={committing ? 'Committing…' : 'Commit import'}
          onConfirm={handleCommit}
          onCancel={() => setConfirmCommitOpen(false)}
        />
      )}
    </Card>
  );
}

function DuplicateCandidateRow({ candidate, candidateIds, isOffline, resolving, onResolve }) {
  const [choice, setChoice] = useState(candidate.resolution ?? '');
  const [matchedGuestId, setMatchedGuestId] = useState(
    candidate.resolved_guest_id ? String(candidate.resolved_guest_id) : candidateIds[0] ?? ''
  );
  const resolved = Boolean(candidate.resolution);

  return (
    <div className={`${formStyles.candidateCard} ${resolved ? formStyles.candidateResolved : ''}`.trim()}>
      <p>
        Row {candidate.row_number}: {candidate.message}
      </p>
      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Decision</span>
          <select className={formStyles.select} value={choice} onChange={(event) => setChoice(event.target.value)} disabled={isOffline}>
            <option value="">Choose…</option>
            <option value="use_existing">Use existing guest</option>
            <option value="create_new">Create a new guest anyway</option>
          </select>
        </label>
        {choice === 'use_existing' && candidateIds.length > 0 && (
          <label className={formStyles.field}>
            <span className={formStyles.label}>Existing guest</span>
            <select
              className={formStyles.select}
              value={matchedGuestId}
              onChange={(event) => setMatchedGuestId(event.target.value)}
              disabled={isOffline}
            >
              {candidateIds.map((id) => (
                <option key={id} value={id}>
                  Guest #{id}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className={formStyles.actionsRow}>
        <Button
          type="button"
          size="compact"
          variant="secondary"
          disabled={isOffline || !choice || (choice === 'use_existing' && !matchedGuestId)}
          loading={resolving}
          onClick={() => onResolve(candidate.row_number, choice, choice === 'use_existing' ? matchedGuestId : undefined)}
        >
          {resolved ? 'Update decision' : 'Save decision'}
        </Button>
        {resolved && <StatusPill tone="success" label={candidate.resolution === 'use_existing' ? 'Will use existing' : 'Will create new'} />}
      </div>
    </div>
  );
}
