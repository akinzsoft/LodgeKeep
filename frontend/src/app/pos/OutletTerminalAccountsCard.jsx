import { useEffect, useRef, useState } from 'react';
import { Card, Button } from '../../shared/components/index.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import { ACCOUNT_PROVIDERS, EXTERNAL_TERMINAL_LABEL } from '../../shared/terminalProviders.js';
import formStyles from './POSForm.module.css';

/**
 * OutletTerminalAccountsCard — which bank account each of this outlet's
 * external card terminals (Moniepoint, Opay, GTBank) pays into. RECORDING
 * ONLY: Lodgekeep cannot route that money (it moves through the terminal's own
 * bank binding), so this only labels each "Card (external terminal)" sale with
 * the account, for matching against that account's own settlement report.
 * Optional per provider; with none recorded a sale just carries no account.
 * Lists show the last 4 digits only; the full number appears while editing.
 */
export function OutletTerminalAccountsCard({ outletId, outletName, isOffline = false }) {
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // provider being edited
  const [form, setForm] = useState({ accountNumber: '', accountLabel: '' });
  const [saving, setSaving] = useState(false);
  // A slow answer for the outlet just switched away from must not land.
  const outletRef = useRef(outletId);

  async function load() {
    const requestedFor = outletId;
    try {
      const list = await posApi.listOutletTerminalAccounts(requestedFor);
      if (outletRef.current !== requestedFor) return;
      setAccounts(list);
      setError(null);
    } catch (caught) {
      if (outletRef.current !== requestedFor) return;
      setAccounts([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the recorded accounts.');
    }
  }

  useEffect(() => {
    outletRef.current = outletId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset-then-fetch when the outlet changes
    setAccounts(null);
    setEditing(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to `outletId` changing only
  }, [outletId]);

  const byProvider = new Map((accounts ?? []).map((row) => [row.provider, row]));

  function startEdit(provider) {
    const existing = byProvider.get(provider);
    setEditing(provider);
    setError(null);
    setForm({ accountNumber: existing?.account_number ?? '', accountLabel: existing?.account_label ?? '' });
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await posApi.setOutletTerminalAccount(outletId, editing, form);
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save this account.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(provider) {
    setError(null);
    try {
      await posApi.removeOutletTerminalAccount(outletId, provider);
      if (editing === provider) setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove this account.');
    }
  }

  return (
    <Card title={`Terminal accounts — ${outletName}`}>
      <p className={formStyles.hint}>
        Record which bank account each of this outlet&apos;s {EXTERNAL_TERMINAL_LABEL} terminals pays into. This changes no money flow — it only labels each sale with the
        account, so you can match it against that account&apos;s own settlement report. Optional.
      </p>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {accounts === null ? (
        <p className={formStyles.hint}>Loading recorded accounts…</p>
      ) : (
        <ul className={formStyles.checkboxGroup}>
          {ACCOUNT_PROVIDERS.map((provider) => {
            const row = byProvider.get(provider.value);
            return (
              <li key={provider.value} className={formStyles.actionsRow}>
                <strong>{provider.label}</strong>
                <span>{row ? `${row.account_label ? `${row.account_label} ` : ''}····${row.account_number_last4}` : 'No account recorded'}</span>
                <Button size="compact" variant="ghost" onClick={() => startEdit(provider.value)} disabled={isOffline} aria-label={`${row ? 'Edit' : 'Record'} ${provider.label} account`}>
                  {row ? 'Edit' : 'Record account'}
                </Button>
                {row && (
                  <Button size="compact" variant="danger" onClick={() => handleRemove(provider.value)} disabled={isOffline} aria-label={`Remove ${provider.label} account`}>
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <form className={formStyles.row} onSubmit={handleSave} aria-label={`${editing} account`}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Account number</span>
            <input className={formStyles.input} inputMode="numeric" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} required />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Label (optional)</span>
            <input className={formStyles.input} value={form.accountLabel} maxLength={80} onChange={(e) => setForm({ ...form, accountLabel: e.target.value })} />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={saving} disabled={isOffline}>
              Save account
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
