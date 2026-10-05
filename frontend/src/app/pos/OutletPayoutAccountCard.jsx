import { useEffect, useRef, useState } from 'react';
import { Card, Button } from '../../shared/components/index.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

const EMPTY_FORM = { bankName: '', bankCode: '', accountNumber: '' };

function describe(settlesTo) {
  return `${settlesTo.account_name} (${settlesTo.bank_name}, account ending ${settlesTo.account_number_last4})`;
}

/**
 * OutletPayoutAccountCard — the bank account this outlet's ONLINE card payments
 * (guest QR orders, Register card / NQR) settle to, through its own Paystack
 * subaccount. An outlet with none settles to the property's account (Setup >
 * Payments), and the card says so. Changing it never affects payments already
 * taken. Admin / super_admin only (`setup.manage`).
 */
export function OutletPayoutAccountCard({ outletId, outletName, isOffline = false, canManage = true }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [resolvedName, setResolvedName] = useState(null);
  const [busy, setBusy] = useState(null); // 'resolving' | 'saving' | 'removing' | 'verifying'
  const [verification, setVerification] = useState(null);
  const outletRef = useRef(outletId);

  async function load() {
    const requestedFor = outletId;
    try {
      const result = await posApi.getOutletPayoutAccount(requestedFor);
      if (outletRef.current !== requestedFor) return;
      setInfo(result);
      setError(null);
    } catch (caught) {
      if (outletRef.current !== requestedFor) return;
      setInfo({ account: null, settles_to: { source: null } });
      setError(caught instanceof ApiError ? caught.message : 'Could not load the payout account.');
    }
  }

  useEffect(() => {
    outletRef.current = outletId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset-then-fetch when the outlet changes
    setInfo(null);
    setVerification(null);
    setEditing(false);
    setResolvedName(null);
    setForm(EMPTY_FORM);
    if (canManage) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to `outletId` changing only
  }, [outletId, canManage]);

  if (!canManage) {
    return (
      <Card title={`Online payout account — ${outletName}`}>
        <p className={formStyles.hint}>Only an administrator can set the bank account this outlet&apos;s online card payments settle to.</p>
      </Card>
    );
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setResolvedName(null);
  }

  async function handleResolve(event) {
    event.preventDefault();
    setBusy('resolving');
    setError(null);
    try {
      const result = await posApi.resolveOutletPayoutBankAccount(outletId, { bankCode: form.bankCode, accountNumber: form.accountNumber });
      setResolvedName(result.accountName);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not check this account.');
    } finally {
      setBusy(null);
    }
  }

  async function handleSave() {
    setBusy('saving');
    setError(null);
    try {
      setInfo(await posApi.setOutletPayoutAccount(outletId, form));
      setVerification(null);
      setEditing(false);
      setResolvedName(null);
      setForm(EMPTY_FORM);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save this payout account.');
    } finally {
      setBusy(null);
    }
  }

  async function handleVerify() {
    const requestedFor = outletId;
    setBusy('verifying');
    setError(null);
    setVerification(null);
    try {
      const result = await posApi.verifyOutletPayoutAccount(requestedFor);
      if (outletRef.current === requestedFor) setVerification(result);
    } catch (caught) {
      if (outletRef.current === requestedFor) setError(caught instanceof ApiError ? caught.message : 'Could not reach Paystack to verify this account.');
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setBusy('removing');
    setError(null);
    try {
      setInfo(await posApi.clearOutletPayoutAccount(outletId));
      setVerification(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove the payout account.');
    } finally {
      setBusy(null);
    }
  }

  const settlesTo = info?.settles_to;
  return (
    <Card title={`Online payout account — ${outletName}`}>
      <p className={formStyles.hint}>
        Online card payments for this outlet (guest QR orders, Register card and NQR) settle to its own bank account when one is set; otherwise to the property&apos;s account. We create the Paystack
        account for you. Changing it never affects payments already taken.
      </p>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {info === null ? (
        <p className={formStyles.hint}>Loading payout account…</p>
      ) : (
        <>
          {settlesTo.source === 'outlet' && (
            <p role="status" className={formStyles.disabledNotice}>
              Settles to this outlet&apos;s own account: <strong>{describe(settlesTo)}</strong>.
            </p>
          )}
          {settlesTo.source === 'property' && (
            <p role="status" className={formStyles.disabledNotice}>
              No account of its own — settles to the <strong>property account</strong>: {describe(settlesTo)}.
            </p>
          )}
          {settlesTo.source === null && (
            <p role="alert" className={formStyles.errorBanner}>
              No payout account is configured for this outlet or the property, so card payments are unavailable here until one is set.
            </p>
          )}
          {verification && (verification.ok ? (
            <p role="status" className={formStyles.disabledNotice}>
              Verified with Paystack: the {verification.source === 'outlet' ? "outlet's" : "property's"} subaccount is active
              {verification.paystack.verified === true ? ' and verified' : ''}, settling to account ending {verification.paystack.account_number_last4 ?? verification.local.account_number_last4} ({verification.paystack.settlement_bank ?? verification.local.bank_name}).
            </p>
          ) : (
            <div role="alert" className={formStyles.errorBanner}>
              <p>Paystack&apos;s record of this payout account has a problem, so payouts may not land:</p>
              <ul>{verification.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            </div>
          ))}
          {!editing && (
            <div className={formStyles.actionsRow}>
              {settlesTo.source !== null && (
                <Button variant="secondary" loading={busy === 'verifying'} disabled={isOffline} onClick={handleVerify}>
                  Verify with Paystack
                </Button>
              )}
              <Button onClick={() => setEditing(true)} disabled={isOffline}>
                {info.account ? 'Change account' : 'Set outlet account'}
              </Button>
              {info.account && (
                <Button variant="danger" loading={busy === 'removing'} disabled={isOffline} onClick={handleRemove}>
                  Use the property account instead
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {editing && (
        <form className={formStyles.form} onSubmit={handleResolve} aria-label="Outlet payout account">
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Bank name</span>
              <input className={formStyles.input} value={form.bankName} onChange={(e) => updateField('bankName', e.target.value)} placeholder="Zenith Bank" required />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Bank code</span>
              <input className={formStyles.input} value={form.bankCode} onChange={(e) => updateField('bankCode', e.target.value)} placeholder="057" required />
            </label>
          </div>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Account number</span>
            <input className={formStyles.input} inputMode="numeric" value={form.accountNumber} onChange={(e) => updateField('accountNumber', e.target.value)} placeholder="0123456789" required />
          </label>
          {resolvedName && (
            <p role="status" className={formStyles.disabledNotice}>
              Resolved to <strong>{resolvedName}</strong> — confirm this is correct, then save.
            </p>
          )}
          <div className={formStyles.actionsRow}>
            {!resolvedName ? (
              <Button type="submit" loading={busy === 'resolving'} disabled={isOffline}>
                Check account name
              </Button>
            ) : (
              <>
                <Button type="button" loading={busy === 'saving'} disabled={isOffline} onClick={handleSave}>
                  Save payout account
                </Button>
                <Button type="button" variant="secondary" onClick={() => setResolvedName(null)}>
                  Re-check
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setResolvedName(null);
                setForm(EMPTY_FORM);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
