import { useEffect, useState } from 'react';
import { Card, Button, Toast } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import formStyles from './SetupForm.module.css';

/**
 * EmailSettingsTab — gap closure (user-reported): "add the mail setup on
 * in SETUP menu." Every real email this codebase sends (MFA codes,
 * password resets, reservation confirmations, staff invitations, ...) has
 * only ever been configurable through the server's own `.env` file — this
 * is the first UI to let a property configure its own sending mailbox,
 * per the user-confirmed decision (AskUserQuestion): per-property, stored
 * in the database.
 *
 * The password field never receives the real saved value back from the
 * API (`GET /email-settings` only ever returns `smtp_password_set`, a
 * boolean) — it always starts blank, with a note explaining that leaving
 * it blank on save preserves whatever is already stored. This is the same
 * "never show a secret back, only that one exists" shape this codebase
 * already uses for dev-only token disclosures, just in the other
 * direction (never disclosing it AT ALL here, not even outside
 * production, since a saved SMTP password is a real credential to a real
 * mailbox, not a short-lived login code).
 */
export function EmailSettingsTab({ disabled, isOffline = false }) {
  const [settings, setSettings] = useState(undefined); // undefined = loading, null = none configured yet
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  function emptyForm() {
    return { provider: 'console', smtp_host: '', smtp_port: '', smtp_user: '', smtp_password: '', smtp_from: '', smtp_from_name: '' };
  }

  async function reload() {
    try {
      const data = await setupApi.getEmailSettings();
      setSettings(data);
      if (data) {
        setForm({
          provider: data.provider,
          smtp_host: data.smtp_host ?? '',
          smtp_port: data.smtp_port ?? '',
          smtp_user: data.smtp_user ?? '',
          smtp_password: '',
          smtp_from: data.smtp_from ?? '',
          smtp_from_name: data.smtp_from_name ?? '',
        });
      }
    } catch (caught) {
      setSettings(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load email settings.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
  }, [disabled]);

  if (disabled) {
    return <p className={formStyles.disabledNotice}>Create a property first — email settings belong to one property.</p>;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const saved = await setupApi.updateEmailSettings({
        provider: form.provider,
        smtp_host: form.smtp_host || null,
        smtp_port: form.smtp_port || null,
        smtp_user: form.smtp_user || null,
        smtp_password: form.smtp_password || undefined,
        smtp_from: form.smtp_from || null,
        smtp_from_name: form.smtp_from_name || null,
      });
      setSettings(saved);
      setForm({ ...form, smtp_password: '' });
      setToast('Email settings saved');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save email settings.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendTest(event) {
    event.preventDefault();
    setTesting(true);
    setTestResult(null);
    try {
      const result = await setupApi.sendTestEmail(testTo);
      setTestResult({ ok: true, message: `Sent via "${result.provider}". Check the inbox at ${testTo}.` });
    } catch (caught) {
      setTestResult({ ok: false, message: caught instanceof ApiError ? caught.message : 'Could not send the test email.' });
    } finally {
      setTesting(false);
    }
  }

  if (settings === undefined) {
    return <p className={formStyles.disabledNotice}>Loading email settings…</p>;
  }

  return (
    <div>
      <Card title="Email delivery">
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <p className={formStyles.disabledNotice}>
          Controls where this property&rsquo;s real emails (verification codes, password resets, reservation
          confirmations, staff invitations) actually get sent from. Leave the provider as &ldquo;Console (dev
          only)&rdquo; to keep the server&rsquo;s own default behavior.
        </p>
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Provider</span>
            <select
              className={formStyles.select}
              value={form.provider}
              onChange={(event) => setForm({ ...form, provider: event.target.value })}
            >
              <option value="console">Console (dev only — no real delivery)</option>
              <option value="smtp">SMTP (real delivery through your own mailbox)</option>
            </select>
          </label>

          {form.provider === 'smtp' && (
            <>
              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>SMTP host</span>
                  <input
                    className={formStyles.input}
                    value={form.smtp_host}
                    onChange={(event) => setForm({ ...form, smtp_host: event.target.value })}
                    placeholder="mail.yourdomain.com"
                    required
                  />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Port</span>
                  <input
                    className={formStyles.input}
                    inputMode="numeric"
                    value={form.smtp_port}
                    onChange={(event) => setForm({ ...form, smtp_port: event.target.value })}
                    placeholder="465"
                  />
                </label>
              </div>

              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Username</span>
                  <input
                    className={formStyles.input}
                    value={form.smtp_user}
                    onChange={(event) => setForm({ ...form, smtp_user: event.target.value })}
                    placeholder="you@yourdomain.com"
                  />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Password{settings?.smtp_password_set ? ' (already set — leave blank to keep it)' : ''}</span>
                  <input
                    className={formStyles.input}
                    type="password"
                    value={form.smtp_password}
                    onChange={(event) => setForm({ ...form, smtp_password: event.target.value })}
                    placeholder={settings?.smtp_password_set ? '••••••••' : ''}
                    autoComplete="new-password"
                  />
                </label>
              </div>

              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>From address (optional)</span>
                  <input
                    className={formStyles.input}
                    value={form.smtp_from}
                    onChange={(event) => setForm({ ...form, smtp_from: event.target.value })}
                    placeholder="Defaults to the username above"
                  />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>From name (optional)</span>
                  <input
                    className={formStyles.input}
                    value={form.smtp_from_name}
                    onChange={(event) => setForm({ ...form, smtp_from_name: event.target.value })}
                    placeholder="Defaults to LodgeKeep"
                  />
                </label>
              </div>
            </>
          )}

          {isOffline && (
            <p role="alert" className={formStyles.errorBanner}>
              You&rsquo;re offline — saving email settings is disabled until the connection returns.
            </p>
          )}
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={isOffline}>
              Save
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Send a test email">
        <p className={formStyles.disabledNotice}>Uses whatever is currently saved above — save first if you just changed anything.</p>
        <form className={formStyles.form} onSubmit={handleSendTest}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Send to</span>
            <input
              className={formStyles.input}
              type="email"
              value={testTo}
              onChange={(event) => setTestTo(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          {testResult && (
            <p role={testResult.ok ? 'status' : 'alert'} className={testResult.ok ? formStyles.disabledNotice : formStyles.errorBanner}>
              {testResult.message}
            </p>
          )}
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={testing} disabled={isOffline} variant="secondary">
              Send test email
            </Button>
          </div>
        </form>
      </Card>

      {toast && (
        <div className={formStyles.toastLayer}>
          <Toast message={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </div>
  );
}
