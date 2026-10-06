import { useEffect, useId, useState } from 'react';
import { ApiError, approvalsApi } from '../../shared/api/index.js';
import { Button, Skeleton } from '../../shared/components/index.js';
import { digitsOnly, isCompletePin, PIN_INPUT_PROPS } from './pin.js';

/**
 * "Approval PIN" — a section of My Profile where a manager sets or changes
 * the 6-digit PIN they type at a till to approve a void, a refund or a sale
 * past recorded stock (backend `src/modules/approvals`). It is never a login
 * credential. Setting it asks for the current password; the PIN is never
 * shown back.
 *
 * Rendered with the host modal's own CSS module (`styles`) so it matches the
 * Profile and Change password sections beside it.
 *
 * @param {object} styles   MyAccountModal's CSS module.
 * @param {boolean} [isOffline]
 */
export function ApprovalPinSection({ styles, isOffline = false }) {
  const passwordId = useId();
  const pinId = useId();
  const confirmId = useId();
  const [status, setStatus] = useState(undefined); // undefined loading, null failed
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState({ currentPassword: '', pin: '', confirmPin: '' });
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setStatus(undefined);
    setLoadError(null);
    try {
      setStatus(await approvalsApi.getMyApprovalPin());
    } catch (caught) {
      setStatus(null);
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load your approval PIN status.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, as the rest of this modal does
    load();
  }, []);

  const mismatch = isCompletePin(form.pin) && isCompletePin(form.confirmPin) && form.pin !== form.confirmPin;
  const ready = form.currentPassword.length > 0 && isCompletePin(form.pin) && form.pin === form.confirmPin;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!ready || saving || isOffline) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await approvalsApi.setMyApprovalPin({ currentPassword: form.currentPassword, pin: form.pin });
      setStatus({ ...status, has_pin: result.has_pin, set_at: result.set_at, locked_until: null });
      setForm({ currentPassword: '', pin: '', confirmPin: '' });
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save your approval PIN.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionHeading}>Approval PIN</h3>
      <p className={styles.hint}>
        Managers type this 6-digit PIN at a till to approve a void, a refund or a sale past recorded stock. It is not your password and cannot be used to sign in.
      </p>

      {status === undefined && <Skeleton height={44} />}
      {status === null && (
        <>
          <p role="alert" className={styles.errorBanner}>
            {loadError}
          </p>
          <Button type="button" variant="secondary" onClick={load}>
            Try again
          </Button>
        </>
      )}

      {status && (
        <form className={styles.form} onSubmit={handleSubmit}>
          <p className={styles.hint}>{status.has_pin ? 'You have an approval PIN. Set a new one below to change it.' : 'You have not set an approval PIN yet.'}</p>
          {status.locked_until && (
            <p role="alert" className={styles.errorBanner}>
              Your PIN is locked after too many wrong tries. Setting a new PIN unlocks it.
            </p>
          )}
          {error && (
            <p role="alert" className={styles.errorBanner}>
              {error}
            </p>
          )}
          {saved && !error && (
            <p role="status" className={styles.successNote}>
              Approval PIN saved.
            </p>
          )}

          <label className={styles.field} htmlFor={passwordId}>
            <span className={styles.label}>Current password</span>
            <input
              id={passwordId}
              className={styles.input}
              type="password"
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={(event) => setForm({ ...form, currentPassword: event.target.value })}
              required
            />
          </label>
          <div className={styles.row}>
            <label className={styles.field} htmlFor={pinId}>
              <span className={styles.label}>New PIN (6 digits)</span>
              <input
                id={pinId}
                className={styles.input}
                {...PIN_INPUT_PROPS}
                value={form.pin}
                onChange={(event) => setForm({ ...form, pin: digitsOnly(event.target.value) })}
                required
              />
            </label>
            <label className={styles.field} htmlFor={confirmId}>
              <span className={styles.label}>Confirm PIN</span>
              <input
                id={confirmId}
                className={styles.input}
                {...PIN_INPUT_PROPS}
                value={form.confirmPin}
                onChange={(event) => setForm({ ...form, confirmPin: digitsOnly(event.target.value) })}
                required
              />
            </label>
          </div>
          {mismatch && <p className={styles.errorBanner}>The two PINs don&rsquo;t match.</p>}
          <p className={styles.hint}>Avoid one digit repeated or a straight run like 123456.</p>
          {isOffline && (
            <p role="alert" className={styles.errorBanner}>
              You&rsquo;re offline — saving is disabled until the connection returns.
            </p>
          )}
          <div className={styles.actionsRow}>
            <Button type="submit" loading={saving} disabled={isOffline || !ready}>
              {status.has_pin ? 'Change PIN' : 'Set PIN'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
