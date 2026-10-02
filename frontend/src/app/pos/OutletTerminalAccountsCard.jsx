import { useEffect, useRef, useState } from 'react';
import { Card, Button } from '../../shared/components/index.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import { ACCOUNT_PROVIDERS, EXTERNAL_TERMINAL_LABEL, terminalProviderLabel } from '../../shared/terminalProviders.js';
import formStyles from './POSForm.module.css';

const EMPTY_FORM = { provider: '', accountNumber: '', bankName: '', accountLabel: '' };

/** "Zenith Bank · Pool bar" — either part optional; falls back to the provider's name. */
function accountName(row) {
  return [row.bank_name, row.account_label].filter(Boolean).join(' · ') || (row.provider ? terminalProviderLabel(row.provider) : 'Unnamed account');
}

/**
 * OutletTerminalAccountsCard — the bank accounts this outlet's external card
 * terminals (Moniepoint, Opay, GTBank, any bank POS) pay into. RECORDING ONLY:
 * Lodgekeep cannot route that money (it moves through the terminal's own bank
 * binding), so this only lets the Register label each "Card (external
 * terminal)" sale with the account the cashier picks, for matching against
 * that account's own settlement report. An outlet may hold any number of
 * accounts, optional per sale. Admin / super_admin only (`setup.manage`);
 * lists show the last 4 digits only, the full number appears while editing.
 */
export function OutletTerminalAccountsCard({ outletId, outletName, isOffline = false, canManage = true }) {
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | account id
  const [form, setForm] = useState(EMPTY_FORM);
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
    if (canManage) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to `outletId` changing only
  }, [outletId, canManage]);

  if (!canManage) {
    return (
      <Card title={`Terminal accounts — ${outletName}`}>
        <p className={formStyles.hint}>Only an administrator can add, change or remove the accounts your card terminals pay into. Cashiers pick one of them when taking a terminal payment.</p>
      </Card>
    );
  }

  function startNew() {
    setEditing('new');
    setError(null);
    setForm(EMPTY_FORM);
  }

  function startEdit(row) {
    setEditing(row.id);
    setError(null);
    setForm({ provider: row.provider ?? '', accountNumber: row.account_number ?? '', bankName: row.bank_name ?? '', accountLabel: row.account_label ?? '' });
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editing === 'new') await posApi.createOutletTerminalAccount(outletId, form);
      else await posApi.updateOutletTerminalAccount(outletId, editing, form);
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save this account.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(row) {
    setError(null);
    try {
      await posApi.removeOutletTerminalAccount(outletId, row.id);
      if (editing === row.id) setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove this account.');
    }
  }

  return (
    <Card title={`Terminal accounts — ${outletName}`}>
      <p className={formStyles.hint}>
        Record the bank accounts this outlet&apos;s {EXTERNAL_TERMINAL_LABEL} terminals pay into. This changes no money flow — cashiers pick one when taking a terminal payment,
        so each sale can be matched against that account&apos;s own settlement report. Removing an account never changes sales already recorded.
      </p>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {accounts === null ? (
        <p className={formStyles.hint}>Loading recorded accounts…</p>
      ) : (
        <>
          {accounts.length === 0 && <p className={formStyles.hint}>No account recorded. Terminal sales will carry no account.</p>}
          <ul className={formStyles.checkboxGroup}>
            {accounts.map((row) => (
              <li key={row.id} className={formStyles.actionsRow}>
                <strong>{accountName(row)}</strong>
                <span>····{row.account_number_last4}</span>
                <Button size="compact" variant="ghost" onClick={() => startEdit(row)} disabled={isOffline} aria-label={`Edit ${accountName(row)} account`}>
                  Edit
                </Button>
                <Button size="compact" variant="danger" onClick={() => handleRemove(row)} disabled={isOffline} aria-label={`Remove ${accountName(row)} account`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {!editing && (
            <Button onClick={startNew} disabled={isOffline}>
              Add account
            </Button>
          )}
        </>
      )}
      {editing && (
        <form className={formStyles.row} onSubmit={handleSave} aria-label={editing === 'new' ? 'New account' : 'Edit account'}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Account number</span>
            <input className={formStyles.input} inputMode="numeric" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} required />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Bank (optional)</span>
            <input className={formStyles.input} value={form.bankName} maxLength={80} placeholder="e.g. Zenith Bank" onChange={(e) => setForm({ ...form, bankName: e.target.value })} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Label (optional)</span>
            <input className={formStyles.input} value={form.accountLabel} maxLength={80} placeholder="e.g. Pool bar settlement" onChange={(e) => setForm({ ...form, accountLabel: e.target.value })} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Terminal provider (optional)</span>
            <select className={formStyles.input} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
              <option value="">Not listed</option>
              {ACCOUNT_PROVIDERS.map((provider) => (
                <option key={provider.value} value={provider.value}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>
          <span className={formStyles.hint}>Give the account a bank, a label or a listed provider so it can be told apart. Any bank can be typed; it is not checked against a list.</span>
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
