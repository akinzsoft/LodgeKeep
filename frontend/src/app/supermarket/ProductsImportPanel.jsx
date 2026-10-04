import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Button, DataTable, ConfirmDialog, StatusPill } from '../../shared/components/index.js';
import { supermarketApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import formStyles from '../pos/POSForm.module.css';
import tillStyles from './Supermarket.module.css';
import styles from './ProductsImport.module.css';

const POLL_MS = 2000;

const STATUS = {
  uploaded: { tone: 'neutral', label: 'Uploaded' },
  dry_run_complete: { tone: 'warning', label: 'Checked, not imported' },
  committing: { tone: 'info', label: 'Importing…' },
  completed: { tone: 'success', label: 'Imported' },
  failed: { tone: 'danger', label: 'Failed — nothing imported' },
  rolled_back: { tone: 'neutral', label: 'Undone' },
  partially_rolled_back: { tone: 'warning', label: 'Partly undone' },
};
const UNDOABLE = ['completed', 'partially_rolled_back'];

const message = (caught, fallback) => (caught instanceof ApiError ? caught.message : fallback);
const statusPill = (status) => <StatusPill tone={STATUS[status]?.tone ?? 'neutral'} label={STATUS[status]?.label ?? status} />;
const findingColumns = [
  { key: 'row_number', label: 'Row', align: 'right' },
  { key: 'column_name', label: 'Column', render: (row) => row.column_name ?? '—' },
  { key: 'message', label: 'Problem' },
];

/**
 * Supermarket Stage 3 — bulk CSV product import (Supermarket → Products
 * import, `supermarket.manage`). Upload checks the file straight away (the
 * dry run writes nothing); Import creates every product in one go or none;
 * Undo removes the products nobody has touched since. The server holds every
 * rule; this screen only shows what it says.
 */
export function ProductsImportPanel({ outletId, outletName, isOffline = false }) {
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // remounts the file input to clear it
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [current, setCurrent] = useState(null); // {run, errors, summary}
  const [confirmImport, setConfirmImport] = useState(false);

  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [undoTarget, setUndoTarget] = useState(null);
  const [undoResult, setUndoResult] = useState(null);

  // The run on screen, and the outlet shown: a response for any other run or outlet (a slow poll after
  // "Start again", a history load or upload that finishes after switching outlets) is dropped.
  const currentId = useRef(null);
  const shownOutlet = useRef(outletId);
  const showRun = useCallback((result) => {
    currentId.current = result ? String(result.run.id) : null;
    setCurrent(result);
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const rows = await supermarketApi.listProductsImports(outletId);
      if (shownOutlet.current !== outletId) return;
      setHistory(rows);
      setHistoryError(null);
    } catch (caught) {
      if (shownOutlet.current !== outletId) return;
      setHistory([]);
      setHistoryError(message(caught, 'Could not load past imports.'));
    }
  }, [outletId]);

  useEffect(() => {
    shownOutlet.current = outletId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new outlet starts clean, then loads its history
    setHistory(null);
    setUndoResult(null);
    setError(null);
    showRun(null);
    loadHistory();
  }, [outletId, loadHistory, showRun]);

  // While an import is running, ask how it went every 2 seconds.
  const runningId = current?.run.status === 'committing' ? String(current.run.id) : null;
  useEffect(() => {
    if (!runningId) return undefined;
    const timer = setInterval(async () => {
      try {
        const result = await supermarketApi.getProductsImport(runningId);
        if (currentId.current !== runningId) return;
        setCurrent(result);
        if (result.run.status !== 'committing') loadHistory();
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [runningId, loadHistory]);

  async function handleTemplate() {
    setError(null);
    try {
      triggerDownload(await supermarketApi.downloadProductsTemplate(), 'supermarket-products-template.csv');
    } catch (caught) {
      setError(message(caught, 'Could not download the template.'));
    }
  }

  async function handleUpload(event) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setUndoResult(null);
    const uploadOutlet = outletId;
    try {
      const result = await supermarketApi.uploadProductsImport({ outletId, file });
      if (shownOutlet.current !== uploadOutlet) return;
      showRun(result);
      loadHistory();
    } catch (caught) {
      if (shownOutlet.current === uploadOutlet) setError(message(caught, 'Could not check this file.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    setConfirmImport(false);
    setBusy(true);
    setError(null);
    const id = String(current.run.id);
    try {
      const run = await supermarketApi.commitProductsImport(id);
      if (currentId.current === id) setCurrent((existing) => ({ ...existing, run }));
    } catch (caught) {
      setError(message(caught, 'Could not start the import.'));
    } finally {
      setBusy(false);
    }
  }

  async function openRun(id) {
    setError(null);
    setUndoResult(null);
    try {
      showRun(await supermarketApi.getProductsImport(id));
    } catch (caught) {
      setError(message(caught, 'Could not open this import.'));
    }
  }

  async function handleUndo(reason) {
    const target = undoTarget;
    setUndoTarget(null);
    setError(null);
    try {
      setUndoResult({ fileName: target.original_filename, ...(await supermarketApi.rollbackProductsImport(target.id, reason)) });
      if (currentId.current === String(target.id)) showRun(await supermarketApi.getProductsImport(target.id));
      loadHistory();
    } catch (caught) {
      setError(message(caught, 'Could not undo this import.'));
    }
  }

  function startAgain() {
    showRun(null);
    setFile(null);
    setFileKey((key) => key + 1);
    setError(null);
  }

  const run = current?.run;
  const summary = current?.summary;
  const findings = current?.errors ?? [];
  const blocking = findings.filter((row) => row.severity === 'error');
  const warnings = findings.filter((row) => row.severity === 'warning');
  // The server sends at most a few hundred of each kind; the titles carry the real totals.
  const errorTotal = current?.findingCounts?.errors ?? blocking.length;
  const warningTotal = current?.findingCounts?.warnings ?? warnings.length;
  const shownNote = (shown, total) => (total > shown ? `, first ${shown} shown` : '');

  return (
    <section id="supermarket-panel-import" role="tabpanel" aria-labelledby="supermarket-tab-import" className={styles.panel}>
      <Card title="Import products from a spreadsheet">
        <p className={tillStyles.hint}>
          One row per product: name, category, price, barcodes (separate several with |), unit, cost price, opening stock, reorder level, supplier. Each row creates the product, its barcodes, its stock item and its opening stock at {outletName}.
          Use supermarket-only category names: a category another outlet sells from is refused.
        </p>
        {isOffline && <p className={tillStyles.hint} role="status">You are offline. Importing is unavailable until the connection returns.</p>}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={handleTemplate} disabled={isOffline}>Download template</Button>
        </div>
        {!run && (
          <form className={styles.uploadForm} onSubmit={handleUpload}>
            <label className={styles.fileField}>
              <span className={formStyles.label}>CSV file</span>
              <input key={fileKey} type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={isOffline || busy} />
            </label>
            <Button type="submit" disabled={isOffline || busy || !file} loading={busy}>Check file</Button>
          </form>
        )}
        {error && <p className={tillStyles.errorBanner} role="alert">{error}</p>}
      </Card>

      {run && (
        <Card title={run.original_filename}>
          <div className={styles.runHeader}>
            {statusPill(run.status)}
            <Button type="button" variant="ghost" onClick={startAgain}>Start again</Button>
          </div>

          {summary?.kind === 'predicted' && (
            <div className={styles.stats} aria-label="What this file will create">
              <Stat label="Products" value={summary.products} />
              <Stat label="New categories" value={summary.categoriesToCreate} />
              <Stat label="Barcodes" value={summary.barcodes} />
              <Stat label="Opening stock" value={`${summary.openingStockUnits} units`} detail={`${summary.productsWithOpeningStock} products`} />
            </div>
          )}
          {summary?.kind === 'imported' && (
            <div className={styles.stats} aria-label="What this import created">
              <Stat label="Products imported" value={summary.products} />
              <Stat label="Categories created" value={summary.categoriesCreated} />
            </div>
          )}

          {run.status === 'failed' && <p className={tillStyles.errorBanner} role="alert">{run.failed_reason}</p>}
          {run.status === 'committing' && <p className={tillStyles.hint} role="status">Importing… this page updates by itself.</p>}

          {blocking.length > 0 && (
            <DataTable
              title={`Problems to fix (${errorTotal}${shownNote(blocking.length, errorTotal)}) — nothing is imported while any row is wrong`}
              columns={findingColumns}
              rows={blocking}
              rowKey={(row) => `e-${row.id ?? `${row.row_number}-${row.column_name}-${row.message}`}`}
            />
          )}
          {warnings.length > 0 && (
            <DataTable
              title={`Warnings (${warningTotal}${shownNote(warnings.length, warningTotal)}) — these do not stop the import`}
              columns={findingColumns}
              rows={warnings}
              rowKey={(row) => `w-${row.id ?? `${row.row_number}-${row.column_name}-${row.message}`}`}
            />
          )}

          {run.status === 'dry_run_complete' && (
            <div className={styles.actions}>
              {blocking.length === 0 ? (
                <Button type="button" onClick={() => setConfirmImport(true)} disabled={isOffline || busy} loading={busy}>
                  Import {summary?.products ?? run.rows_total} products
                </Button>
              ) : (
                <p className={tillStyles.hint}>Fix the rows above in your spreadsheet, then start again with the corrected file.</p>
              )}
            </div>
          )}
        </Card>
      )}

      {undoResult && (
        <Card title={`Undo of ${undoResult.fileName}`}>
          <p className={tillStyles.hint} role="status">
            {undoResult.rowsRolledBack} product(s) removed.{' '}
            {undoResult.rowsRefused.length === 0 ? 'Nothing was kept.' : `${undoResult.rowsRefused.length} kept because they have been used since:`}
          </p>
          {undoResult.rowsRefused.length > 0 && (
            <ul className={styles.refusedList} aria-label="Kept after undo">
              {undoResult.rowsRefused.map((row) => (
                <li key={`${row.entityType}-${row.entityId}`}>
                  <strong>{row.name ?? (row.entityType === 'menu_category' ? 'Category' : `Row ${row.rowNumber}`)}</strong>: {row.reason}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <DataTable
        title="Past imports at this outlet"
        state={history === null ? 'loading' : historyError ? 'error' : 'success'}
        errorMessage={historyError}
        emptyMessage="No imports yet."
        columns={[
          { key: 'created_at', label: 'Uploaded', render: (row) => new Date(row.created_at).toLocaleString() },
          { key: 'original_filename', label: 'File' },
          { key: 'status', label: 'Status', render: (row) => statusPill(row.status) },
          { key: 'rows_created', label: 'Products', align: 'right', render: (row) => (['completed', 'rolled_back', 'partially_rolled_back'].includes(row.status) ? row.rows_created : '—') },
        ]}
        rows={history ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <span className={styles.rowActions}>
            <Button type="button" size="compact" variant="ghost" onClick={() => openRun(row.id)}>View</Button>
            {UNDOABLE.includes(row.status) && (
              <Button type="button" size="compact" variant="secondary" onClick={() => setUndoTarget(row)} disabled={isOffline}>Undo</Button>
            )}
          </span>
        )}
      />

      {confirmImport && (
        <ConfirmDialog
          title={`Import ${summary?.products ?? run.rows_total} products into ${outletName}?`}
          consequence={`Everything in the file is created in one go, or nothing is.${summary?.productsWithOpeningStock ? ` ${summary.openingStockUnits} units of opening stock are received into ${outletName}.` : ''}`}
          confirmLabel="Import"
          onConfirm={handleImport}
          onCancel={() => setConfirmImport(false)}
        />
      )}
      {undoTarget && (
        <ConfirmDialog
          title={`Undo the import of ${undoTarget.original_filename}?`}
          consequence="Products nobody has sold, moved stock for or re-barcoded since are deleted, with their opening stock. Any that have been used are kept and listed."
          requireReason
          confirmLabel="Undo import"
          onConfirm={handleUndo}
          onCancel={() => setUndoTarget(null)}
        />
      )}
    </section>
  );
}

function Stat({ label, value, detail }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {detail && <span className={styles.statDetail}>{detail}</span>}
    </div>
  );
}
