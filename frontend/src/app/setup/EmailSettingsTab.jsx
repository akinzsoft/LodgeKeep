import { useEffect, useState } from 'react';
import { EmailDeliveryNotice } from './EmailDeliveryNotice.jsx';
import { Card, Button, Toast, StatusPill } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import formStyles from './SetupForm.module.css';

const MODE_LABEL = { platform: 'Platform email (default)', custom: 'Your own SMTP', console: 'Console (development only)' };
const PORTS = [587, 465, 2525, 25];

function emptyForm() {
  return {
    mode: 'platform',
    reply_to: '',
    smtp_host: '',
    smtp_port: '587',
    smtp_security: 'starttls',
    smtp_user: '',
    smtp_password: '',
    smtp_from: '',
    smtp_from_name: '',
  };
}

function formFrom(data) {
  if (!data) return emptyForm();
  return {
    mode: data.mode ?? 'platform',
    reply_to: data.reply_to ?? '',
    smtp_host: data.smtp_host ?? '',
    smtp_port: String(data.smtp_port ?? 587),
    smtp_security: data.smtp_security ?? (data.smtp_port === 465 ? 'tls' : 'starttls'),
    smtp_user: data.smtp_user ?? '',
    smtp_password: '',
    smtp_from: data.smtp_from ?? '',
    smtp_from_name: data.smtp_from_name ?? '',
  };
}

/**
 * EmailSettingsTab — where this property's emails (invitations, password
 * resets, verification codes, reservation emails) are sent from.
 *
 * Two modes: the platform's own mailbox (the default; nothing to set up, the
 * From address is the platform's and the property name is the display name)
 * or the property's own SMTP. The password is never sent back by the API
 * (only a "set" flag), so the field always starts blank; leaving it blank on
 * save keeps the stored one. Nothing about the platform mailbox's
 * credentials ever reaches this screen.
 */
export function EmailSettingsTab({ disabled, isOffline = false }) {
  const [settings, setSettings] = useState(undefined); // undefined = loading, null = none saved yet
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  async function reload() {
    try {
      const [data, nextStatus] = await Promise.all([setupApi.getEmailSettings(), setupApi.getEmailDeliveryStatus().catch(() => null)]);
      setSettings(data);
      setStatus(nextStatus);
      setForm(formFrom(data));
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
      const body = { mode: form.mode, reply_to: form.reply_to.trim() || null };
      if (form.mode === 'custom') {
        Object.assign(body, {
          smtp_host: form.smtp_host.trim(),
          smtp_port: Number(form.smtp_port),
          smtp_security: form.smtp_security,
          smtp_user: form.smtp_user || null,
          smtp_password: form.smtp_password || undefined,
          smtp_from: form.smtp_from || null,
          smtp_from_name: form.smtp_from_name || null,
        });
      }
      await setupApi.updateEmailSettings(body);
      await reload();
      setToast('Email settings saved');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save email settings.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await setupApi.sendTestEmail();
      setTestResult(
        result.mode === 'console'
          ? { ok: false, message: 'Written to the server log only (development mode) — nothing was delivered.' }
          : { ok: true, message: `Test email sent to ${result.to}. Check that inbox.` }
      );
    } catch (caught) {
      setTestResult({ ok: false, message: caught instanceof ApiError ? caught.message : 'Could not send the test email.' });
    } finally {
      setTesting(false);
      reload();
    }
  }

  if (settings === undefined) {
    return <p className={formStyles.disabledNotice}>Loading email settings…</p>;
  }

  const activeMode = status?.mode ?? settings?.mode ?? 'platform';
  const lastTest = status?.lastTest;
  const usage = status?.usage;

  return (
    <div>
      <Card title="Email status">
        <EmailDeliveryNotice where="settings" refreshKey={settings} />
        <p>
          Active mode: <strong>{MODE_LABEL[activeMode] ?? activeMode}</strong>{' '}
          {status && <StatusPill tone={status.sendsEmail ? 'success' : 'danger'} label={status.sendsEmail ? 'Sending' : 'Not sending'} />}
        </p>
        {activeMode === 'platform' && usage && usage.sentToday !== null && (
          <p className={formStyles.disabledNotice}>
            Booking and invoice emails today: {usage.sentToday} of {usage.dailyCap}. Sign-in emails (invitations, password resets, verification codes) are not counted.
          </p>
        )}
        <p className={formStyles.disabledNotice}>
          {lastTest
            ? `Last test: ${lastTest.ok ? 'sent successfully' : `failed — ${lastTest.error ?? 'unknown error'}`} (${new Date(lastTest.at).toLocaleString()}).`
            : 'No test email has been sent yet.'}
        </p>
      </Card>

      <Card title="Email settings">
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Send emails using</span>
            <select className={formStyles.select} value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
              <option value="platform">Platform email (default — nothing to set up)</option>
              <option value="custom">Your own SMTP server</option>
              {status?.consoleAllowed && <option value="console">Console (development only — no real delivery)</option>}
            </select>
          </label>

          {form.mode === 'platform' && (
            <>
              <p className={formStyles.disabledNotice}>
                Emails are sent from the platform&rsquo;s verified address, with your property name as the sender name. Replies go to the address below.
              </p>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Reply-To address (optional)</span>
                <input
                  className={formStyles.input}
                  type="email"
                  value={form.reply_to}
                  onChange={(event) => setForm({ ...form, reply_to: event.target.value })}
                  placeholder="Defaults to your super admin's email"
                />
              </label>
            </>
          )}

          {form.mode === 'custom' && (
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
                  <select className={formStyles.select} value={form.smtp_port} onChange={(event) => setForm({ ...form, smtp_port: event.target.value })}>
                    {PORTS.map((port) => (
                      <option key={port} value={port}>
                        {port}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Security</span>
                  <select className={formStyles.select} value={form.smtp_security} onChange={(event) => setForm({ ...form, smtp_security: event.target.value })}>
                    <option value="starttls">STARTTLS (usually port 587)</option>
                    <option value="tls">SSL/TLS (usually port 465)</option>
                  </select>
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
                  <span className={formStyles.label}>From address</span>
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
        <p className={formStyles.disabledNotice}>Sends to your own address, using what is currently saved above — save first if you just changed anything.</p>
        {testResult && (
          <p role={testResult.ok ? 'status' : 'alert'} className={testResult.ok ? formStyles.disabledNotice : formStyles.errorBanner}>
            {testResult.message}
          </p>
        )}
        <div className={formStyles.actionsRow}>
          <Button type="button" loading={testing} disabled={isOffline} variant="secondary" onClick={handleSendTest}>
            Send test email
          </Button>
        </div>
      </Card>

      {toast && (
        <div className={formStyles.toastLayer}>
          <Toast message={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </div>
  );
}
