import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../shared/api/index.js';
import { formatMoney } from '../../shared/format/money.jsx';
import styles from './DiscountDialog.module.css';

/**
 * VoucherDialog — the cashier types a voucher code. That is ALL that is sent: the voucher's type, value and cap are the
 * server's, and so is the amount it takes off. Spaces, dashes and case do not matter. Every reason a code can fail at
 * the till reads the same on purpose (a code cannot be probed), so the message is just the server's.
 *
 * `apply(code)` is the caller's own request (a Register check or a supermarket cart) and resolves to the new discount
 * with its `amount`. `onDone(discount)` runs once it is on the check.
 */
export function VoucherDialog({ apply, onDone, onCancel, isOffline = false }) {
  const titleId = useId();
  const codeId = useId();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape' && !busy) onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const ready = code.replace(/[\s-]/g, '').length >= 8 && !busy && !isOffline;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const applied = await apply(code.trim());
      onDone(applied);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not use that voucher. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.overlay} role="presentation">
      <form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={handleSubmit}>
        <h2 id={titleId} className={styles.title}>
          Use a voucher
        </h2>
        <div className={styles.field}>
          <label htmlFor={codeId} className={styles.label}>
            Voucher code
          </label>
          <input
            id={codeId}
            className={styles.input}
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoFocus
          />
        </div>
        <p className={styles.hint}>The voucher decides how much comes off. It cannot be combined with another discount on the same check.</p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {isOffline && <p className={styles.hint}>You are offline. A voucher can only be used when you are connected.</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={styles.primary} disabled={!ready}>
            {busy ? 'Checking…' : 'Use voucher'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** What a voucher took off, for the toast after it is applied. */
export function voucherAppliedText(discount, currency) {
  return discount?.amount ? `Voucher applied: ${currency ? formatMoney(discount.amount, currency) : discount.amount} off.` : 'Voucher applied.';
}
