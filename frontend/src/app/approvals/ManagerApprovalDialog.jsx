import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, approvalsApi } from '../../shared/api/index.js';
import { digitsOnly, isCompletePin, PIN_INPUT_PROPS } from './pin.js';
import styles from './ManagerApprovalDialog.module.css';

/**
 * ManagerApprovalDialog — a manager approves one sensitive action at the till
 * with their 6-digit PIN (backend `src/modules/approvals`). Replaces the plain
 * reason-only confirmation for a void, a refund or selling past recorded
 * stock: someone picks the approving manager by name, the manager types their
 * PIN, and a reason is given. On success `onApproved(token, reason)` receives
 * a single-use approval (2 minutes, for this action and record only) that the
 * caller sends with the action in the `X-Manager-Approval` header.
 *
 * The PIN never leaves this component except in the one approval request,
 * and the token is held only in the caller's memory for the one action.
 * While the PIN is being checked the dialog cannot be cancelled, and once it
 * has closed a late answer is ignored — so the action never runs behind a
 * dialog the user saw close. A tap on the backdrop does nothing (a till is a
 * touch screen; an accidental tap must not throw away a typed PIN).
 *
 * @param {string} action            Registry key, e.g. 'pos.void_settlement'.
 * @param {string|number} [targetId] The record the approval is for (omit for an action whose record does not exist yet).
 * @param {string} title
 * @param {string} consequence       What will happen, in plain words.
 * @param {import('react').ReactNode} [children]  Extra detail shown under the consequence (e.g. the lines over stock).
 * @param {string} [confirmLabel]
 * @param {boolean} [busy]           The caller is running the approved action.
 * @param {boolean} [isOffline]
 * @param {(token: string, reason: string) => void} onApproved
 * @param {() => void} onCancel
 */
export function ManagerApprovalDialog({ action, targetId, title, consequence, children, confirmLabel = 'Approve', busy = false, isOffline = false, onApproved, onCancel }) {
  const titleId = useId();
  const approverId = useId();
  const pinId = useId();
  const reasonId = useId();
  const pinRef = useRef(null);
  const approverRef = useRef(null);
  const openRef = useRef(true);

  const [approvers, setApprovers] = useState(undefined); // undefined loading, null failed
  const [loadError, setLoadError] = useState(null);
  const [approver, setApprover] = useState('');
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function loadApprovers() {
    setApprovers(undefined);
    setLoadError(null);
    try {
      const list = await approvalsApi.listApprovers(action);
      setApprovers(list);
      const withPin = list.filter((row) => row.hasPin);
      if (withPin.length === 1) setApprover(withPin[0].id);
    } catch (caught) {
      setApprovers(null);
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load the managers who can approve this.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, the established pattern for dialogs here
    loadApprovers();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch-on-mount only, per action
  }, [action]);

  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
  }, []);

  const canApprove = approvers?.some((row) => row.hasPin);
  const ready = Boolean(approver) && isCompletePin(pin) && reason.trim().length > 0;
  const working = submitting || busy;

  function cancel() {
    if (!working) onCancel();
  }

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape' && !working) onCancel();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, working]);

  // Once the managers have loaded, put the cursor where the next keystroke belongs.
  useEffect(() => {
    if (!canApprove) return;
    (approver ? pinRef : approverRef).current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the list arrives, not on every pick
  }, [approvers]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!ready || working || isOffline) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await approvalsApi.requestApproval({ action, approverUserId: approver, pin, reason: reason.trim(), targetId });
      if (!openRef.current) return; // closed meanwhile: never run the action behind the user's back
      setPin('');
      onApproved(result.token, reason.trim());
    } catch (caught) {
      if (!openRef.current) return;
      setPin('');
      setError(describeError(caught));
      pinRef.current?.focus();
    } finally {
      if (openRef.current) setSubmitting(false);
    }
  }

  return (
    <div className={styles.overlay} role="presentation">
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={handleSubmit}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p className={styles.consequence}>{consequence}</p>
        {children}
        <p className={styles.notice}>A manager must approve this with their PIN.</p>

        {approvers === undefined && <p className={styles.muted}>Loading managers…</p>}
        {approvers === null && (
          <div className={styles.field}>
            <p role="alert" className={styles.error}>
              {loadError}
            </p>
            <button type="button" className={styles.secondary} onClick={loadApprovers}>
              Try again
            </button>
          </div>
        )}
        {approvers && !canApprove && (
          <p role="alert" className={styles.error}>
            {approvers.length === 0
              ? 'Nobody at this property can approve this.'
              : 'No manager who can approve this has set an approval PIN yet. A manager can set one under My Profile → Approval PIN.'}
          </p>
        )}

        {canApprove && (
          <>
            <div className={styles.field}>
              <label htmlFor={approverId} className={styles.label}>
                Manager
              </label>
              <select id={approverId} ref={approverRef} className={styles.input} value={approver} onChange={(event) => setApprover(event.target.value)} required>
                <option value="">Choose a manager</option>
                {approvers.map((row) => (
                  <option key={row.id} value={row.id} disabled={!row.hasPin}>
                    {row.hasPin ? row.name : `${row.name} (no PIN set)`}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor={pinId} className={styles.label}>
                Manager&rsquo;s PIN
              </label>
              <input
                id={pinId}
                ref={pinRef}
                className={`${styles.input} ${styles.pin}`}
                {...PIN_INPUT_PROPS}
                value={pin}
                onChange={(event) => setPin(digitsOnly(event.target.value))}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor={reasonId} className={styles.label}>
                Reason
              </label>
              <textarea id={reasonId} className={`${styles.input} ${styles.reason}`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required />
            </div>
          </>
        )}

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {isOffline && (
          <p role="alert" className={styles.error}>
            You&rsquo;re offline — approval is disabled until the connection returns.
          </p>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={cancel} disabled={working}>
            Cancel
          </button>
          <button type="submit" className={styles.primary} disabled={!canApprove || !ready || working || isOffline}>
            {working ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function describeError(caught) {
  if (!(caught instanceof ApiError)) return 'Could not reach the server. Try again.';
  if (caught.code === 'VALIDATION_APPROVAL_PIN_INCORRECT') {
    const left = caught.details?.attemptsLeft;
    return typeof left === 'number' ? `That PIN is not correct. ${left} ${left === 1 ? 'try' : 'tries'} left before it locks.` : 'That PIN is not correct.';
  }
  return caught.message;
}
