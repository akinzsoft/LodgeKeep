import { useState } from 'react';
import { ConfirmDialog } from '../../shared/components/index.js';
import styles from './RemoveReasonDialog.module.css';

/** Quick picks for removing a line that is no longer in its grace window (or was already sent). The chosen text is the stored, audited reason. */
export const REMOVE_REASONS = ['Customer changed mind', 'Wrong item', 'Item unavailable'];
const OTHER = 'Other';

/**
 * Asks why a line is being removed with one-tap reasons instead of a blank box. The reason is still sent to the
 * server and audited exactly as typed text was; "Other" takes free text and is stored as "Other: <text>".
 */
export function RemoveReasonDialog({ consequence, onConfirm, onCancel }) {
  const [pick, setPick] = useState(null);
  const [otherText, setOtherText] = useState('');
  const reason = pick === OTHER ? (otherText.trim() ? `Other: ${otherText.trim()}` : '') : pick || '';

  return (
    <ConfirmDialog title="Remove item" consequence={consequence} confirmLabel="Remove" confirmDisabled={!reason} onConfirm={() => onConfirm(reason)} onCancel={onCancel}>
      <div className={styles.picks} role="group" aria-label="Reason for removing">
        {[...REMOVE_REASONS, OTHER].map((label) => (
          <button key={label} type="button" className={styles.pick} aria-pressed={pick === label} onClick={() => setPick(label)}>
            {label}
          </button>
        ))}
      </div>
      {pick === OTHER && (
        <input className={styles.otherInput} type="text" maxLength={200} aria-label="Other reason" placeholder="What happened?" value={otherText} onChange={(event) => setOtherText(event.target.value)} />
      )}
    </ConfirmDialog>
  );
}
