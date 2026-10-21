import { useState } from 'react';
import { Button } from '../../shared/components/index.js';
import { platformApi, ApiError } from '../../shared/api/index.js';
import styles from './PlatformScreens.module.css';

/**
 * "Move to new domain and send login emails" for an already-active tenant. Changes only which address the tenant's links use and
 * e-mails each active user their new sign-in address; never touches status, subscription or billing. Never runs by itself.
 * Confirms first, because it e-mails every active user. The server refuses anything but an active tenant and repeats nothing.
 */
export function MoveDomainForm({ tenantId, currentDomain, onDone }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!window.confirm('This moves the tenant to the new address and e-mails every active user their login details. Continue?')) return;
    setSubmitting(true);
    try {
      setResult(await platformApi.moveToNewDomain(tenantId, reason.trim()));
      setReason('');
      onDone?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not move this tenant.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <p className={styles.hint}>
        Current address domain: <strong>{currentDomain || 'the default'}</strong>. Moving it changes only the address in e-mailed links and sends each
        active user an e-mail with the new address and their login e-mail. Status, subscription and billing are not touched. Both addresses keep working.
      </p>
      <label className={styles.field}>
        <span className={styles.label}>Reason for moving (recorded on the audit trail)</span>
        <input className={styles.input} value={reason} onChange={(event) => setReason(event.target.value)} required placeholder="e.g. Customer asked to switch to the new address" />
      </label>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {result && (
        <p role="status" className={styles.hint}>
          Moved to {result.appDomain}. {result.emails.queued} e-mail(s) queued, {result.emails.alreadySent} already sent before.
        </p>
      )}
      <Button type="submit" loading={submitting}>Move to new domain and send login emails</Button>
    </form>
  );
}
