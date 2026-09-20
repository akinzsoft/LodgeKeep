import { useEffect, useState } from 'react';
import { Card, Button, Toast } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import formStyles from './SetupForm.module.css';

/**
 * PaymentSubaccountTab — gap closure: every tenant's guest card revenue
 * used to settle into one shared platform Paystack account, regardless of
 * which hotel it belonged to. This is the Setup screen a property uses to
 * fix that: a bank account number + bank name, which creates a real
 * Paystack Subaccount through our own single merchant integration — no
 * hotel-side Paystack account, login, or business verification needed.
 *
 * A two-step flow, not a single "just save it" form: `resolveBankAccount`
 * first shows the REAL resolved account name back to the hotel for
 * confirmation before anything is created (DESIGN_SYSTEM.md §2 — confirm
 * before a real effect), since a typo'd account number would otherwise
 * silently route a hotel's future card revenue to the wrong bank account.
 * Saving is only enabled once a resolve has succeeded for the CURRENT
 * bank code/account number in the form — changing either field after a
 * successful resolve clears it, so a stale confirmation can never be
 * carried into a save for different, unconfirmed details.
 *
 * Deliberately plain "bank code" + "bank name" text fields, not a bank
 * picker backed by a live `GET /bank` listing — the user's own request
 * named exactly these two fields ("bank account number + bank name"); a
 * real bank-name-to-code directory is a genuine, flagged follow-on, not
 * built here to avoid inventing an endpoint nobody asked for this pass.
 *
 * Card payments are unavailable for a property until this is completed —
 * `startPaystackCheckout` (backend) refuses outright with
 * `PAYMENT_SUBACCOUNT_NOT_CONFIGURED` otherwise, matching the honest
 * "flagged stub, not invented behaviour" shape every other gateway gap in
 * this codebase already uses.
 */
export function PaymentSubaccountTab({ disabled, isOffline = false }) {
  const [subaccount, setSubaccount] = useState(undefined); // undefined = loading, null = none configured yet
  const [form, setForm] = useState(emptyForm());
  const [resolvedName, setResolvedName] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  function emptyForm() {
    return { bank_code: '', bank_name: '', account_number: '' };
  }

  async function reload() {
    try {
      const data = await setupApi.getPaymentSubaccount();
      setSubaccount(data);
    } catch (caught) {
      setSubaccount(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the payout account.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
  }, [disabled]);

  if (disabled) {
    return <p className={formStyles.disabledNotice}>Create a property first — a payout account belongs to one property.</p>;
  }

  function updateField(field, value) {
    setForm({ ...form, [field]: value });
    // A changed field invalidates any prior resolve — never save a
    // confirmation that no longer matches what's in the form.
    setResolvedName(null);
  }

  async function handleResolve(event) {
    event.preventDefault();
    setResolving(true);
    setError(null);
    setResolvedName(null);
    try {
      const result = await setupApi.resolvePaymentBankAccount({ bankCode: form.bank_code, accountNumber: form.account_number });
      setResolvedName(result.accountName);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not resolve this bank account.');
    } finally {
      setResolving(false);
    }
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await setupApi.savePaymentSubaccount({
        bankCode: form.bank_code,
        bankName: form.bank_name,
        accountNumber: form.account_number,
      });
      setSubaccount(saved);
      setForm(emptyForm());
      setResolvedName(null);
      setToast('Payout account saved');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the payout account.');
    } finally {
      setSaving(false);
    }
  }

  if (subaccount === undefined) {
    return <p className={formStyles.disabledNotice}>Loading payout account…</p>;
  }

  const canSave = Boolean(resolvedName) && !isOffline;

  return (
    <div>
      <Card title="Guest card payments — payout account">
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <p className={formStyles.disabledNotice}>
          Guest card payments settle here, minus any platform fee — never into a shared account. No Paystack account
          of your own is needed; we create it for you from these details.
        </p>

        {subaccount && (
          <p className={formStyles.disabledNotice} role="status">
            Currently paying out to <strong>{subaccount.account_name}</strong> ({subaccount.bank_name}, account ending{' '}
            {subaccount.account_number_last4}).
          </p>
        )}

        <form className={formStyles.form} onSubmit={resolvedName ? handleSave : handleResolve}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Bank name</span>
              <input
                className={formStyles.input}
                value={form.bank_name}
                onChange={(event) => updateField('bank_name', event.target.value)}
                placeholder="Zenith Bank"
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Bank code</span>
              <input
                className={formStyles.input}
                value={form.bank_code}
                onChange={(event) => updateField('bank_code', event.target.value)}
                placeholder="057"
                required
              />
            </label>
          </div>

          <label className={formStyles.field}>
            <span className={formStyles.label}>Account number</span>
            <input
              className={formStyles.input}
              inputMode="numeric"
              value={form.account_number}
              onChange={(event) => updateField('account_number', event.target.value)}
              placeholder="0123456789"
              required
            />
          </label>

          {resolvedName && (
            <p role="status" className={formStyles.disabledNotice}>
              Resolved to <strong>{resolvedName}</strong> — confirm this is correct, then save.
            </p>
          )}

          {isOffline && (
            <p role="alert" className={formStyles.errorBanner}>
              You&rsquo;re offline — the payout account can&rsquo;t be changed until the connection returns.
            </p>
          )}

          <div className={formStyles.actionsRow}>
            {!resolvedName ? (
              <Button type="submit" loading={resolving} disabled={isOffline}>
                Check account name
              </Button>
            ) : (
              <>
                <Button type="submit" loading={saving} disabled={!canSave}>
                  Save payout account
                </Button>
                <Button type="button" variant="secondary" disabled={saving} onClick={() => setResolvedName(null)}>
                  Re-check
                </Button>
              </>
            )}
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
