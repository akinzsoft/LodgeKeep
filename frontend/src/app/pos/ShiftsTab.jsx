import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

/**
 * ShiftsTab — PLAN.md Phase 4: "Shift open / cash-up" (PRODUCT_REQUIREMENTS.md
 * §3.4/§3.19). Blind cash-up is structural, not a UI trick: the close form
 * submits `counted_cash` and only THEN receives `expected_cash`/`variance`
 * in the response — nothing on this screen ever reads or displays what the
 * system expects before that submission (`pos/service.js`'s own header has
 * the full reasoning).
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
  const [closeResult, setCloseResult] = useState(null);

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

  async function handleOpenShift(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await posApi.openShift({ terminalId: selectedTerminalId, openingFloat });
      setOpeningFloat('');
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open this shift.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCloseShift(event) {
    event.preventDefault();
    setError(null);
    try {
      const result = await posApi.closeShift(closingShift.id, countedCash);
      setCloseResult(result);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not close this shift.');
      setClosingShift(null);
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
                Select a terminal
              </option>
              {(terminals ?? []).map((terminal) => (
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
          { key: 'opened_at', label: 'Opened' },
          { key: 'opening_float', label: 'Opening float', align: 'right', render: (row) => <Money amount={row.opening_float} currencyCode={row.currency} /> },
          {
            key: 'variance',
            label: 'Variance',
            align: 'right',
            render: (row) => (row.closed_at ? <Money amount={row.variance} currencyCode={row.currency} /> : 'Open'),
          },
        ]}
        rows={shifts ?? []}
        rowKey={(row) => row.id}
        actions={(row) =>
          !row.closed_at && (
            <Button size="compact" variant="danger" disabled={isOffline} onClick={() => setClosingShift(row)}>
              Close (blind count)
            </Button>
          )
        }
      />

      {closingShift && !closeResult && (
        <Card title="Close shift — blind cash-up">
          <p>Enter the cash you counted before this screen reveals what the system expected. This cannot be undone.</p>
          <form className={formStyles.row} onSubmit={handleCloseShift}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Counted cash</span>
              <input className={formStyles.input} type="number" step="0.01" min="0" value={countedCash} onChange={(e) => setCountedCash(e.target.value)} required />
            </label>
            <div className={formStyles.actionsRow}>
              <Button type="submit">Submit count</Button>
              <Button type="button" variant="ghost" onClick={() => setClosingShift(null)}>
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
            <Button
              variant="ghost"
              onClick={() => {
                setCloseResult(null);
                setClosingShift(null);
                setCountedCash('');
              }}
            >
              Done
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
