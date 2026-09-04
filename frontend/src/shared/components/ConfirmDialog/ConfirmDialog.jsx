import { useId, useState } from 'react';
import styles from './ConfirmDialog.module.css';

/**
 * ConfirmDialog — DESIGN_SYSTEM.md §2's warning/confirmation state:
 * "anything irreversible or financial (void a line item, refund, cancel a
 * booking, run night audit, change a tax rate, delete a rate plan) requires
 * an explicit confirm step stating the consequence in plain words.
 * Confirmations for money operations require a reason field, which feeds the
 * audit trail (SECURITY.md §1.1)."
 *
 * `requireReason` is what makes that second sentence real rather than a
 * convention every caller has to remember: when true, `onConfirm` cannot
 * fire with an empty reason — the Confirm button is disabled until one is
 * typed, and the value passed to `onConfirm` is exactly what the backend's
 * `src/audit` write path expects in its own `reason` field
 * (`src/audit/service.js`), so a caller can thread it straight through
 * without inventing its own validation.
 *
 * @param {string} title
 * @param {string} consequence   The plain-words statement of what happens — DESIGN_SYSTEM.md §2's "stating the consequence in plain words", not a generic "Are you sure?".
 * @param {boolean} [requireReason]
 * @param {string} [confirmLabel]
 * @param {string} [cancelLabel]
 * @param {(reason?: string) => void} onConfirm
 * @param {() => void} onCancel
 */
export function ConfirmDialog({
  title,
  consequence,
  requireReason = false,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) {
  const [reason, setReason] = useState('');
  const titleId = useId();
  const reasonId = useId();

  const reasonMissing = requireReason && reason.trim().length === 0;

  return (
    <div className={styles.overlay} role="presentation" onClick={onCancel}>
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p className={styles.consequence}>{consequence}</p>

        {requireReason && (
          <div className={styles.reasonField}>
            <label htmlFor={reasonId} className={styles.reasonLabel}>
              Reason
            </label>
            <textarea
              id={reasonId}
              className={styles.reasonInput}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </div>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={styles.confirm}
            disabled={reasonMissing}
            onClick={() => onConfirm(requireReason ? reason.trim() : undefined)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
