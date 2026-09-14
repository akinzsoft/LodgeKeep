import { useRef, useState } from 'react';
import { Button, Card, ConfirmDialog, DataTable } from '../../shared/components/index.js';
import { doorAccessApi, ApiError } from '../../shared/api/index.js';
import { formatInZone } from './format.js';
import styles from './DoorAccess.module.css';

/**
 * Lock audit-trail import — PRODUCT_REQUIREMENTS.md §3.23: upload the file
 * pulled from the handheld reader, preview the parsed events with a duplicate
 * count, confirm, and see how many alerts were raised retrospectively.
 *
 * The app never assumes the lock software's column layout: after upload it
 * shows the file's REAL column headers and staff map them (confirmed
 * decision — the HiRead ProUSB export columns could not be confirmed, and
 * the same screen works for any other lock's export). The mapping from the
 * last successful import is pre-filled when this file has the same columns.
 *
 * The server keeps nothing between steps: the chosen `File` is re-sent for
 * preview and commit. Changing the file or the mapping discards the preview,
 * so "Import" can only ever confirm exactly what was previewed.
 *
 * `generationRef` counts every change of file or mapping. A response that
 * arrives after such a change belongs to a selection that no longer exists
 * and is dropped — otherwise a slow "Read columns" for file A could fill the
 * mapping while file B is what gets previewed and imported (found in code
 * review; the same stale-response class Data Migration's NewImportTab fixed).
 */
const EXCEL_DATES = '';

const EMPTY_MAPPING = {
  roomColumn: '',
  cardColumn: '',
  timestampColumn: '',
  timestampFormat: EXCEL_DATES,
  cardTypeColumn: '',
  guestCardTypeValues: [],
  resultColumn: '',
  deniedResultValues: [],
};

function errorText(caught, fallback) {
  return caught instanceof ApiError ? caught.message : fallback;
}

export function ImportTab({ config, isOffline = false, onImported, onOpenSettings }) {
  const [file, setFile] = useState(null);
  const [columns, setColumns] = useState(null);
  const [mapping, setMapping] = useState(EMPTY_MAPPING);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const fileInputRef = useRef(null);
  const generationRef = useRef(0);

  if (config.adapter === 'none') {
    return (
      <Card
        title="Import lock log"
        state="empty"
        emptyMessage="Choose this property's lock system before importing a lock audit trail."
        emptyAction={<Button onClick={onOpenSettings}>Open settings</Button>}
      />
    );
  }

  function reset() {
    generationRef.current += 1;
    setFile(null);
    setColumns(null);
    setMapping(EMPTY_MAPPING);
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function updateMapping(changes) {
    generationRef.current += 1;
    setMapping((current) => ({ ...current, ...changes }));
    setPreview(null);
  }

  function toSubmittedMapping() {
    return {
      roomColumn: mapping.roomColumn,
      cardColumn: mapping.cardColumn,
      timestampColumn: mapping.timestampColumn,
      timestampFormat: mapping.timestampFormat === EXCEL_DATES ? null : mapping.timestampFormat,
      cardTypeColumn: mapping.cardTypeColumn || null,
      guestCardTypeValues: mapping.cardTypeColumn ? mapping.guestCardTypeValues : [],
      resultColumn: mapping.resultColumn || null,
      deniedResultValues: mapping.resultColumn ? mapping.deniedResultValues : [],
    };
  }

  async function handleReadColumns(event) {
    event.preventDefault();
    setBusy('columns');
    setError(null);
    setResult(null);
    setPreview(null);
    const generation = generationRef.current;
    try {
      const data = await doorAccessApi.readHeaders(file);
      if (generation !== generationRef.current) return;
      setColumns(data);
      const saved = data.savedMapping;
      setMapping(
        saved
          ? {
              ...EMPTY_MAPPING,
              ...saved,
              timestampFormat: saved.timestampFormat ?? EXCEL_DATES,
              cardTypeColumn: saved.cardTypeColumn ?? '',
              resultColumn: saved.resultColumn ?? '',
            }
          : EMPTY_MAPPING
      );
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setColumns(null);
      setError(errorText(caught, 'Could not read that file.'));
    } finally {
      setBusy(null);
    }
  }

  async function handlePreview() {
    setBusy('preview');
    setError(null);
    const generation = generationRef.current;
    try {
      const data = await doorAccessApi.previewImport(file, toSubmittedMapping());
      if (generation === generationRef.current) setPreview(data);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setPreview(null);
      setError(errorText(caught, 'Could not preview this import.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit() {
    setConfirming(false);
    setBusy('commit');
    setError(null);
    try {
      const summary = await doorAccessApi.commitImport(file, toSubmittedMapping());
      setResult(summary);
      setPreview(null);
      setColumns(null);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      onImported();
    } catch (caught) {
      setError(errorText(caught, 'The import could not be completed. Nothing was imported.'));
    } finally {
      setBusy(null);
    }
  }

  const headers = columns?.headers ?? [];
  const requiredMapped = mapping.roomColumn && mapping.cardColumn && mapping.timestampColumn;
  const cardTypeIncomplete = mapping.cardTypeColumn && mapping.guestCardTypeValues.length === 0;
  const canPreview = file && columns && requiredMapped && !cardTypeIncomplete && !busy && !isOffline;

  return (
    <>
      {error && (
        <p className={styles.errorBanner} role="alert">
          {error}
        </p>
      )}
      {isOffline && <p className={styles.notice}>You are offline. Importing is disabled until connectivity returns.</p>}

      {result && <ImportResult result={result} timezone={config.timezone} onAnother={reset} />}

      <Card title="1. Choose the exported lock log">
        <form className={styles.form} onSubmit={handleReadColumns}>
          <label className={styles.field}>
            <span className={styles.label}>Lock audit-trail file (.xls, .xlsx or .csv)</span>
            {/* No `required`: the button's disabled state is the real guard (jsdom does not treat a programmatic upload as satisfying `required`). */}
            <input
              ref={fileInputRef}
              className={styles.input}
              type="file"
              disabled={Boolean(busy)}
              accept=".xls,.xlsx,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                generationRef.current += 1;
                setFile(e.target.files?.[0] ?? null);
                setColumns(null);
                setPreview(null);
                setResult(null);
              }}
            />
            <p className={styles.help}>Export the audit trail from the lock software after pulling it from the locks with the handheld reader.</p>
          </label>
          <div className={styles.actionsRow}>
            <Button type="submit" disabled={!file || Boolean(busy) || isOffline}>
              {busy === 'columns' ? 'Reading…' : 'Read columns'}
            </Button>
          </div>
        </form>
      </Card>

      {columns && (
        <Card title="2. Match the columns">
          <div className={styles.form}>
            <p className={styles.help}>
              {columns.rowCount} row{columns.rowCount === 1 ? '' : 's'} found. Tell us which column holds each piece of information.
              {columns.savedMapping ? ' The columns from your last import have been filled in.' : ''}
            </p>
            <div className={styles.row}>
              <ColumnSelect label="Room or lock number" value={mapping.roomColumn} headers={headers} onChange={(v) => updateMapping({ roomColumn: v })} required />
              <ColumnSelect label="Card ID" value={mapping.cardColumn} headers={headers} onChange={(v) => updateMapping({ cardColumn: v })} required />
              <ColumnSelect label="Date and time opened" value={mapping.timestampColumn} headers={headers} onChange={(v) => updateMapping({ timestampColumn: v })} required />
            </div>
            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.label}>How the date and time are written</span>
                <select className={styles.select} value={mapping.timestampFormat} onChange={(e) => updateMapping({ timestampFormat: e.target.value })}>
                  <option value={EXCEL_DATES}>Spreadsheet date cells (no format needed)</option>
                  {columns.timestampFormats.map((format) => (
                    <option key={format} value={format}>
                      Text, like {format}
                    </option>
                  ))}
                </select>
                <p className={styles.help}>Times are read as {config.timezone ?? "the property's"} local time.</p>
              </label>
              <ColumnSelect
                label="Card type (optional)"
                value={mapping.cardTypeColumn}
                headers={headers}
                onChange={(v) => updateMapping({ cardTypeColumn: v, guestCardTypeValues: [] })}
              />
              <ColumnSelect
                label="Granted / denied result (optional)"
                value={mapping.resultColumn}
                headers={headers}
                onChange={(v) => updateMapping({ resultColumn: v, deniedResultValues: [] })}
              />
            </div>

            {mapping.cardTypeColumn ? (
              <ValuePicker
                legend="Which card types are guest cards?"
                help="Only guest cards are checked. Staff, master and maintenance cards are stored but never raise an alert."
                distinct={columns.distinctValues[mapping.cardTypeColumn]}
                selected={mapping.guestCardTypeValues}
                onChange={(values) => updateMapping({ guestCardTypeValues: values })}
              />
            ) : (
              <p className={styles.warningBanner}>
                No card-type column is mapped, so every card will be treated as a guest card. Housekeeping or master keys opening an
                empty room will then raise false alerts. Map a card-type column if the export has one.
              </p>
            )}

            {mapping.resultColumn && (
              <ValuePicker
                legend="Which results mean the door stayed locked (denied)?"
                help="Denied openings are stored but not checked — nobody got in."
                distinct={columns.distinctValues[mapping.resultColumn]}
                selected={mapping.deniedResultValues}
                onChange={(values) => updateMapping({ deniedResultValues: values })}
              />
            )}

            <div className={styles.actionsRow}>
              <Button onClick={handlePreview} disabled={!canPreview}>
                {busy === 'preview' ? 'Checking…' : 'Preview import'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {preview && (
        <PreviewPanel
          preview={preview}
          timezone={config.timezone}
          disabled={isOffline || Boolean(busy) || preview.newEventCount === 0}
          committing={busy === 'commit'}
          onImport={() => setConfirming(true)}
        />
      )}

      {confirming && preview && (
        <ConfirmDialog
          title="Import lock log"
          consequence={`This stores ${preview.newEventCount} door opening${preview.newEventCount === 1 ? '' : 's'} permanently and checks them against past stays. Door events cannot be edited or deleted afterwards. Managers are emailed if critical alerts are found.`}
          confirmLabel="Import"
          onConfirm={handleCommit}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

function ColumnSelect({ label, value, headers, onChange, required = false }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{required ? 'Choose a column' : 'Not in this file'}</option>
        {headers.map((header) => (
          <option key={header} value={header}>
            {header}
          </option>
        ))}
      </select>
    </label>
  );
}

function ValuePicker({ legend, help, distinct, selected, onChange }) {
  const values = distinct?.values ?? [];
  return (
    <fieldset className={styles.checkboxGroup}>
      <legend className={styles.label}>{legend}</legend>
      <p className={styles.help}>{help}</p>
      {values.length === 0 && <p className={styles.help}>This column has no values.</p>}
      {values.map((value) => (
        <label key={value} className={styles.checkbox}>
          <input
            type="checkbox"
            checked={selected.includes(value)}
            onChange={(e) => onChange(e.target.checked ? [...selected, value] : selected.filter((v) => v !== value))}
          />
          {value}
        </label>
      ))}
      {distinct?.truncated && <p className={styles.help}>Only the first {values.length} different values are shown.</p>}
    </fieldset>
  );
}

function Stat({ label, value }) {
  return (
    <div className={styles.statTile}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

function PreviewPanel({ preview, timezone, disabled, committing, onImport }) {
  const duplicates = preview.duplicatesInFile + preview.duplicatesAlreadyImported;
  return (
    <Card title="3. Check and import">
      <div className={styles.panel}>
        <div className={styles.summaryRow}>
          <Stat label="New door openings" value={preview.newEventCount} />
          <Stat label="Duplicates skipped" value={duplicates} />
          <Stat label="Rooms not recognised" value={preview.unmatchedRoomRowCount} />
          <Stat label="Rows that could not be read" value={preview.unparseableCount} />
        </div>
        <p className={styles.help}>
          {preview.newEventCount > 0
            ? `Covers ${formatInZone(preview.earliestEventAt, timezone)} to ${formatInZone(preview.latestEventAt, timezone)}. ${preview.guestEventCount} guest-card opening(s) will be checked; ${preview.nonGuestEventCount} non-guest and ${preview.deniedEventCount} denied opening(s) are stored only.`
            : 'Every door opening in this file has already been imported — there is nothing new to import.'}
          {duplicates > 0 ? ' Duplicates are normal when a lock is pulled more than once.' : ''}
        </p>

        {preview.unmatchedRooms.length > 0 && (
          <DataTable
            title="Rooms not recognised (these rows will be skipped)"
            columns={[
              { key: 'identifier', label: 'Value in file' },
              { key: 'count', label: 'Rows', align: 'right' },
            ]}
            rows={preview.unmatchedRooms}
            rowKey={(row) => row.identifier}
          />
        )}

        {preview.unparseableRows.length > 0 && (
          <DataTable
            title="Rows that could not be read (these will be skipped)"
            columns={[
              { key: 'rowNumber', label: 'Row' },
              { key: 'reason', label: 'Problem', render: (row) => READ_PROBLEMS[row.reason] ?? row.reason },
              { key: 'value', label: 'Value', render: (row) => row.value ?? '—' },
            ]}
            rows={preview.unparseableRows}
            rowKey={(row) => row.rowNumber}
          />
        )}

        {preview.sampleEvents.length > 0 && (
          <DataTable
            title="First door openings to be imported"
            columns={[
              { key: 'rowNumber', label: 'Row' },
              { key: 'roomNumber', label: 'Room' },
              { key: 'cardId', label: 'Card' },
              { key: 'cardType', label: 'Card type', render: (row) => row.cardType ?? '—' },
              { key: 'openedAt', label: 'Opened', render: (row) => formatInZone(row.openedAt, timezone) },
              { key: 'result', label: 'Result' },
            ]}
            rows={preview.sampleEvents}
            rowKey={(row) => row.rowNumber}
          />
        )}

        <div className={styles.actionsRow}>
          <Button onClick={onImport} disabled={disabled}>
            {committing ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

const READ_PROBLEMS = {
  missing_room_or_card: 'Room or card is blank',
  unreadable_timestamp: 'Date/time not in the chosen format',
  card_id_too_long: 'Card ID longer than 100 characters',
  implausible_timestamp: 'Date is before 2000 or in the future — check the lock clock',
};

function ImportResult({ result, timezone, onAnother }) {
  return (
    <Card title="Import complete">
      <div className={styles.panel}>
        <div className={styles.summaryRow}>
          <Stat label="Door openings stored" value={result.eventsStored} />
          <Stat label="New critical alerts" value={result.criticalAlertsCreated} />
          <Stat label="Existing alerts updated" value={result.alertsExtended} />
          <Stat label="Stay confirmations" value={result.stayConfirmationsRecorded} />
        </div>
        <p className={result.criticalAlertsCreated > 0 ? styles.warningBanner : styles.notice}>
          {result.criticalAlertsCreated > 0
            ? `${result.criticalAlertsCreated} critical alert(s) were raised retrospectively for door openings between ${formatInZone(result.earliestEventAt, timezone)} and ${formatInZone(result.latestEventAt, timezone)}. ${result.notifiedRecipientCount > 0 ? 'Managers have been notified.' : 'No manager account could be notified.'} Review them under Alerts.`
            : 'No new critical alerts were found in this lock log. This only covers the period in the file — anything after it will not show until the next lock log is imported.'}
        </p>
        <div className={styles.actionsRow}>
          <Button variant="secondary" onClick={onAnother}>
            Import another file
          </Button>
        </div>
      </div>
    </Card>
  );
}
