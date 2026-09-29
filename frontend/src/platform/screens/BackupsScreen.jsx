import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ConfirmDialog, DataTable, StatusPill } from '../../shared/components/index.js';
import { platformApi, ApiError } from '../../shared/api/index.js';
import { usePlatformAuth } from '../auth/PlatformAuthContext.jsx';
import styles from './PlatformScreens.module.css';

const STATUS = { running: { tone: 'info', label: 'Running' }, sent: { tone: 'success', label: 'Sent' }, failed: { tone: 'danger', label: 'Failed' } };
const MIN_PASSPHRASE_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POLL_MS = 3000;

function formatBytes(bytes) {
  if (bytes == null) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * BackupsScreen — the platform console's whole-database backup
 * (user-requested: "click Backup and specify the email to send it to").
 * Confirmed: the whole database; encrypted with a passphrase typed here for
 * this one backup (sent to the server once, never stored or emailed);
 * platform admins only — a support account sees the form and the history,
 * and the server refuses it (the console's own "no client-side role check"
 * convention, with a hint saying so).
 *
 * Because the file holds every hotel's guests and finances, sending it asks
 * for confirmation naming the address. The history polls while a backup is
 * running.
 */
export function BackupsScreen({ onBack, onLogout }) {
  const { role } = usePlatformAuth();
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [email, setEmail] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = (requestRef.current += 1);
    try {
      const result = await platformApi.listBackups();
      if (requestId === requestRef.current) setHistory(result);
    } catch (caught) {
      if (requestId !== requestRef.current) return;
      setHistory((current) => current ?? { backups: [], emailConfigured: true, emailProvider: null });
      setError(caught instanceof ApiError ? caught.message : 'Could not load the backup history.');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, [reload]);

  const anyRunning = Boolean(history?.backups?.some((row) => row.status === 'running'));
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning, reload]);

  const emailValid = EMAIL_PATTERN.test(email.trim());
  const passphraseLongEnough = passphrase.length >= MIN_PASSPHRASE_LENGTH;
  const passphrasesMatch = passphrase === confirmPassphrase;
  const canStart = emailValid && passphraseLongEnough && passphrasesMatch && !starting && !anyRunning && history?.emailConfigured !== false;

  async function handleStart() {
    setConfirming(false);
    setError(null);
    setNotice(null);
    setStarting(true);
    try {
      const row = await platformApi.startBackup({ recipientEmail: email.trim(), passphrase });
      setNotice(`Backup #${row.id} started — it will be emailed to ${row.recipient_email} in a moment.`);
      setPassphrase('');
      setConfirmPassphrase('');
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start the backup.');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className={styles.console}>
      <div className={styles.consoleHeader}>
        <h1 className={styles.consoleTitle}>Backups</h1>
        <div className={styles.actionsRow}>
          <Button variant="secondary" onClick={onBack}>
            Back to tenants
          </Button>
          <Button variant="ghost" onClick={onLogout}>
            Sign out
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.hint}>
          {notice}
        </p>
      )}

      <Card title="Back up the database">
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (canStart) setConfirming(true);
          }}
        >
          <p className={styles.hint}>
            Emails a complete copy of the database — every hotel, every guest, every bill — as one encrypted file. It is encrypted with the
            passphrase below, which is not stored anywhere or included in the email: write it down, because without it the backup cannot be
            opened.{' '}
            {role !== 'admin' && 'Starting a backup needs the platform admin tier — your account can still try, but the server will refuse it.'}
          </p>
          {history?.emailConfigured === false && (
            <p role="alert" className={styles.errorBanner}>
              This server has no email mailbox configured, so a backup cannot be emailed. Set EMAIL_PROVIDER and the SMTP settings in
              .env.production first.
            </p>
          )}
          {history?.emailProvider === 'console' && history?.emailConfigured && (
            <p className={styles.hint}>No real email provider is configured here: the backup email is only written to the server log.</p>
          )}
          <label className={styles.field}>
            <span className={styles.label}>Send to</span>
            <input className={styles.input} type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Passphrase (at least {MIN_PASSPHRASE_LENGTH} characters)</span>
            <input
              className={styles.input}
              type={showPassphrase ? 'text' : 'password'}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Type the passphrase again</span>
            <input
              className={styles.input}
              type={showPassphrase ? 'text' : 'password'}
              value={confirmPassphrase}
              onChange={(event) => setConfirmPassphrase(event.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          {passphrase && !passphraseLongEnough && <p className={styles.hint}>The passphrase is too short.</p>}
          {confirmPassphrase && !passphrasesMatch && <p className={styles.hint}>The two passphrases do not match.</p>}
          <div className={styles.actionsRow}>
            <Button type="submit" loading={starting} disabled={!canStart}>
              Back up now
            </Button>
            <Button type="button" variant="ghost" onClick={() => setShowPassphrase((shown) => !shown)}>
              {showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
            </Button>
            {anyRunning && <span className={styles.subtitle}>A backup is running…</span>}
          </div>
        </form>
      </Card>

      <DataTable
        title="Backup history"
        state={history === null ? 'loading' : history.backups.length === 0 ? 'empty' : 'success'}
        emptyMessage="No backups yet."
        columns={[
          { key: 'requested_at', label: 'Started', render: (row) => row.requested_at },
          { key: 'requested_by', label: 'By', render: (row) => row.requested_by?.name ?? row.requested_by?.email ?? '—' },
          { key: 'recipient_email', label: 'Sent to' },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={STATUS[row.status]?.tone ?? 'neutral'} label={STATUS[row.status]?.label ?? row.status} /> },
          { key: 'size', label: 'Size', align: 'right', render: (row) => formatBytes(row.size_bytes) },
          {
            key: 'contents',
            label: 'Contents',
            render: (row) => (row.table_count == null ? '—' : `${row.table_count} tables, ${row.row_count} rows`),
          },
          {
            key: 'detail',
            label: 'Detail',
            render: (row) =>
              row.error ??
              (row.status === 'sent' && row.email_provider === 'console' ? 'Logged only — no real email provider' : row.file_name ?? '—'),
          },
        ]}
        rows={history?.backups ?? []}
        rowKey={(row) => row.id}
      />

      {confirming && (
        <ConfirmDialog
          title="Email a full backup?"
          consequence={`A copy of every hotel's data will be emailed to ${email.trim()}, encrypted with your passphrase. Make sure you have written the passphrase down.`}
          confirmLabel="Send backup"
          onConfirm={handleStart}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
