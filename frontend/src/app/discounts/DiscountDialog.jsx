import { useEffect, useId, useState } from 'react';
import { discountsApi, ApiError } from '../../shared/api/index.js';
import { ManagerApprovalDialog } from '../approvals/ManagerApprovalDialog.jsx';
import { KIND_LABELS, reasonsFor, isValidDiscountValue } from './discountText.js';
import styles from './DiscountDialog.module.css';

/**
 * DiscountDialog — asks for a discount or a comp. The person at the till names what, how much and why; the SERVER
 * works out the money, so nothing here is an amount the server trusts. Within the person's limit it applies at
 * once; above it (and for every comp) a manager approves with their PIN, bound to this exact request.
 *
 * `create({scope, kind, type, value, reasonId, lineId})` is the caller's own request (a Register check or a supermarket
 * cart) and resolves to the new discount with `approvalRequired` / `approvalAction`. `onDone(discount)` runs once the
 * discount is applied. If the manager step is dismissed the request stays pending and `onPending(discount)` runs, so
 * the screen can offer to approve it later.
 *
 * @param {Array<{id: string, label: string}>} lines  The lines a line discount can target (empty = whole check only).
 * @param {string|null} [initialLineId]
 */
export function DiscountDialog({ title = 'Give a discount', lines = [], initialLineId = null, create, onDone, onPending, onCancel, isOffline = false }) {
  const kindId = useId();
  const [kind, setKind] = useState('discount');
  const [scope, setScope] = useState(initialLineId ? 'line' : 'order');
  const [lineId, setLineId] = useState(initialLineId ?? lines[0]?.id ?? '');
  const [type, setType] = useState('percent');
  const [value, setValue] = useState('');
  const [reasons, setReasons] = useState(undefined); // undefined loading, null failed
  const [reasonId, setReasonId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // the created discount waiting for a manager

  useEffect(() => {
    let live = true;
    discountsApi
      .listReasons()
      .then((rows) => live && setReasons(rows))
      .catch(() => live && setReasons(null));
    return () => {
      live = false;
    };
  }, []);

  const choices = reasons ? reasonsFor(reasons, kind) : [];
  const valueOk = kind === 'comp' || isValidDiscountValue(value);
  const ready = valueOk && reasonId && (scope === 'order' || lineId) && !busy && !isOffline;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const created = await create({ scope, kind, type: kind === 'comp' ? 'percent' : type, value: kind === 'comp' ? '100' : value.trim(), reasonId, lineId: scope === 'line' ? lineId : undefined });
      const result = { ...created, reason_name: reasons?.find((reason) => String(reason.id) === String(reasonId))?.name ?? '' };
      if (result.approvalRequired) setPending(result);
      else onDone(result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not ask for the discount. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleApproved(token) {
    setBusy(true);
    try {
      const activated = await discountsApi.approveDiscount(pending.id, token);
      onDone({ ...pending, ...activated });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not apply the approved discount.');
      setPending(null);
      onPending?.(pending);
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <ManagerApprovalDialog
        action={pending.approvalAction}
        targetId={pending.id}
        title={pending.kind === 'comp' ? 'Approve a comp' : 'Approve a discount'}
        consequence={pending.kind === 'comp' ? 'The whole amount will be given away.' : 'This discount is above what you may give on your own.'}
        confirmLabel="Approve"
        busy={busy}
        isOffline={isOffline}
        onApproved={handleApproved}
        onCancel={() => {
          onPending?.(pending);
          onCancel();
        }}
      />
    );
  }

  return (
    <div className={styles.overlay} role="presentation">
      <form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={kindId} onSubmit={handleSubmit}>
        <h2 id={kindId} className={styles.title}>
          {title}
        </h2>

        <div className={styles.segment} role="group" aria-label="What to give">
          {Object.entries(KIND_LABELS).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={styles.segmentButton}
              aria-pressed={kind === key}
              onClick={() => {
                setKind(key);
                setReasonId('');
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {lines.length > 0 && (
          <div className={styles.field}>
            <label htmlFor={`${kindId}-scope`} className={styles.label}>
              Applies to
            </label>
            <select id={`${kindId}-scope`} className={styles.input} value={scope === 'order' ? 'order' : `line:${lineId}`} onChange={(event) => {
              const next = event.target.value;
              if (next === 'order') setScope('order');
              else {
                setScope('line');
                setLineId(next.slice(5));
              }
            }}>
              <option value="order">The whole check</option>
              {lines.map((line) => (
                <option key={line.id} value={`line:${line.id}`}>
                  {line.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {kind === 'discount' ? (
          <>
            <div className={styles.segment} role="group" aria-label="How much">
              <button type="button" className={styles.segmentButton} aria-pressed={type === 'percent'} onClick={() => setType('percent')}>
                Percent
              </button>
              <button type="button" className={styles.segmentButton} aria-pressed={type === 'fixed'} onClick={() => setType('fixed')}>
                Amount
              </button>
            </div>
            <div className={styles.field}>
              <label htmlFor={`${kindId}-value`} className={styles.label}>
                {type === 'percent' ? 'Percent off' : 'Amount off'}
              </label>
              <input id={`${kindId}-value`} className={styles.input} type="text" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
            </div>
          </>
        ) : (
          <p className={styles.hint}>A comp gives the whole amount away. A manager must approve it with their PIN.</p>
        )}

        <div className={styles.field}>
          <label htmlFor={`${kindId}-reason`} className={styles.label}>
            Reason
          </label>
          <select id={`${kindId}-reason`} className={styles.input} value={reasonId} onChange={(event) => setReasonId(event.target.value)} required>
            <option value="">{reasons === undefined ? 'Loading…' : 'Choose a reason'}</option>
            {choices.map((reason) => (
              <option key={reason.id} value={reason.id}>
                {reason.name}
              </option>
            ))}
          </select>
        </div>
        {reasons === null && <p role="alert" className={styles.error}>Could not load the reasons.</p>}

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {isOffline && (
          <p role="alert" className={styles.error}>
            You&rsquo;re offline — discounts are disabled until the connection returns.
          </p>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={styles.primary} disabled={!ready}>
            {busy ? 'Working…' : kind === 'comp' ? 'Ask for approval' : 'Apply discount'}
          </button>
        </div>
      </form>
    </div>
  );
}
