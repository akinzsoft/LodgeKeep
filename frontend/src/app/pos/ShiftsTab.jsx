import { useEffect, useRef, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function operatorName(row) {
  const name = [row.opened_by_first_name, row.opened_by_last_name].filter(Boolean).join(' ');
  return name || '—';
}

/** Money for a closed shift's cash-up figures; an open shift has none yet. */
function closedMoney(row, field) {
  return row.closed_at ? <Money amount={row[field]} currencyCode={row.currency} /> : '—';
}

/**
 * ShiftsTab — PLAN.md Phase 4: "Shift open / cash-up" (PRODUCT_REQUIREMENTS.md
 * §3.4/§3.19). Blind cash-up is structural, not a UI trick: the close form
 * submits `counted_cash` and only THEN receives `expected_cash`/`variance`
 * in the response — nothing on this screen ever reads or displays what the
 * system expects before that submission (`pos/service.js`'s own header has
 * the full reasoning).
 *
 * One Idempotency-Key is held per close attempt and renewed whenever the
 * count changes: re-submitting the same count after a lost response replays
 * the stored result, while a corrected count is a genuinely new request.
 */
export function ShiftsTab({ isOffline = false }) {
  const [terminals, setTerminals] = useState(null);
  const [shifts, setShifts] = useState(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState('');
  const [openingFloat, setOpeningFloat] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [closingShift, setClosingShift] = useState(null);
  const [countedCash, setCountedCash] = useState('');
  const [closeSubmitting, setCloseSubmitting] = useState(false);
  const [closeResult, setCloseResult] = useState(null);
  const closeKeyRef = useRef(null);

  async function reload() {
    try {
      const [terminalList, shiftList] = await Promise.all([posApi.listTerminals(), posApi.listShifts()]);
      setTerminals(terminalList);
      setShifts(shiftList);
    } catch (caught) {
      setTerminals([]);
      setShifts([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load shifts.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  // A terminal already running a shift can't open another — don't offer it.
  const openTerminalIds = new Set((shifts ?? []).filter((shift) => !shift.closed_at).map((shift) => String(shift.terminal_id)));
  const availableTerminals = (terminals ?? []).filter((terminal) => !openTerminalIds.has(String(terminal.id)));

  function startClosing(shift) {
    setError(null);
    setCloseResult(null);
    setCountedCash('');
    closeKeyRef.current = crypto.randomUUID();
    setClosingShift(shift);
  }

  function finishClosing() {
    setClosingShift(null);
    setCloseResult(null);
    setCountedCash('');
    closeKeyRef.current = null;
  }

  async function handleOpenShift(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await posApi.openShift({ terminalId: selectedTerminalId, openingFloat });
      setOpeningFloat('');
      setSelectedTerminalId('');
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open this shift.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCloseShift(event) {
    event.preventDefault();
    if (closeSubmitting) return;
    setCloseSubmitting(true);
    setError(null);
    try {
      const result = await posApi.closeShift(closingShift.id, countedCash, closeKeyRef.current);
      setCloseResult(result);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not close this shift.');
      // Nothing left to count against: the shift is gone or was closed
      // elsewhere. Any other failure keeps the count so it can be retried.
      if (caught instanceof ApiError && (caught.status === 404 || caught.code === 'CONFLICT_POS_SHIFT_ALREADY_CLOSED')) {
        finishClosing();
        await reload();
      }
    } finally {
      setCloseSubmitting(false);
    }
  }

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Shifts cannot be opened or closed until connectivity returns.</p>}

      <Card title="Open a shift">
        <form className={formStyles.row} onSubmit={handleOpenShift}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Terminal</span>
            <select className={formStyles.select} value={selectedTerminalId} onChange={(e) => setSelectedTerminalId(e.target.value)} required disabled={isOffline}>
              <option value="" disabled>
                {terminals !== null && terminals.length > 0 && availableTerminals.length === 0 ? 'Every terminal has an open shift' : 'Select a terminal'}
              </option>
              {availableTerminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>
                  {terminal.device_ref}
                </option>
              ))}
            </select>
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Opening float</span>
            <input className={formStyles.input} type="number" step="0.01" min="0" value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} required disabled={isOffline} />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={isOffline}>
              Open shift
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        title="Shift history"
        state={shifts === null ? 'loading' : shifts.length === 0 ? 'empty' : 'success'}
        emptyMessage="No shifts yet."
        columns={[
          { key: 'terminal_device_ref', label: 'Terminal', render: (row) => row.terminal_device_ref ?? '—' },
          { key: 'opened_by', label: 'Opened by', render: operatorName },
          { key: 'opened_at', label: 'Opened', render: (row) => formatTime(row.opened_at) },
          { key: 'closed_at', label: 'Closed', render: (row) => (row.closed_at ? formatTime(row.closed_at) : 'Open') },
          { key: 'opening_float', label: 'Opening float', align: 'right', render: (row) => <Money amount={row.opening_float} currencyCode={row.currency} /> },
          { key: 'counted_cash', label: 'Counted', align: 'right', render: (row) => closedMoney(row, 'counted_cash') },
          { key: 'expected_cash', label: 'Expected', align: 'right', render: (row) => closedMoney(row, 'expected_cash') },
          { key: 'variance', label: 'Variance', align: 'right', render: (row) => closedMoney(row, 'variance') },
        ]}
        rows={shifts ?? []}
        rowKey={(row) => row.id}
        actions={(row) =>
          !row.closed_at && (
            <Button size="compact" variant="danger" disabled={isOffline} onClick={() => startClosing(row)}>
              Close (blind count)
            </Button>
          )
        }
      />

      {closingShift && !closeResult && (
        <Card title={`Close shift — blind cash-up${closingShift.terminal_device_ref ? ` (${closingShift.terminal_device_ref})` : ''}`}>
          <p>Enter the cash you counted before this screen reveals what the system expected. This cannot be undone.</p>
          <form className={formStyles.row} onSubmit={handleCloseShift}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Counted cash</span>
              <input
                className={formStyles.input}
                type="number"
                step="0.01"
                min="0"
                value={countedCash}
                onChange={(e) => {
                  setCountedCash(e.target.value);
                  closeKeyRef.current = crypto.randomUUID();
                }}
                required
                disabled={isOffline || closeSubmitting}
              />
            </label>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={closeSubmitting} disabled={isOffline}>
                Submit count
              </Button>
              <Button type="button" variant="ghost" onClick={finishClosing} disabled={closeSubmitting}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {closeResult && (
        <Card title="Cash-up result">
          <dl className={formStyles.form}>
            <div>
              <dt className={formStyles.label}>Counted</dt>
              <dd>
                <Money amount={closeResult.counted_cash} currencyCode={closeResult.currency} />
              </dd>
            </div>
            <div>
              <dt className={formStyles.label}>Expected</dt>
              <dd>
                <Money amount={closeResult.expected_cash} currencyCode={closeResult.currency} />
              </dd>
            </div>
            <div>
              <dt className={formStyles.label}>Variance</dt>
              <dd>
                <Money amount={closeResult.variance} currencyCode={closeResult.currency} />
              </dd>
            </div>
          </dl>
          <div className={formStyles.actionsRow}>
            <Button variant="ghost" onClick={finishClosing}>
              Done
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
