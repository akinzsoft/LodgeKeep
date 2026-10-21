import { useState } from 'react';
import { Button } from '../../shared/components/index.js';
import { platformApi, ApiError } from '../../shared/api/index.js';
import styles from './PlatformScreens.module.css';

const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'other', label: 'Other' },
];

/**
 * Records a manual (cash / bank transfer / other) subscription payment. `mode` 'subscribe' marks a trial or suspended tenant
 * subscribed; 'renew' records another payment for a tenant already paying manually. Everything is checked again on the server
 * (the plan, the currency, the dates); this form only saves a round trip. Confirms before sending, because "mark subscribed"
 * e-mails every active user of the tenant.
 */
export function ManualPaymentForm({ tenantId, mode, onDone }) {
  const [form, setForm] = useState({ plan_code: 'standard', method: 'bank_transfer', reference: '', amount: '', currency: 'NGN', paid_until: '', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const subscribing = mode === 'subscribe';

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    const question = subscribing
      ? 'This marks the tenant as subscribed, moves it to the subscribed address and e-mails every active user. Continue?'
      : 'This records the payment and e-mails the tenant’s super admins a receipt. Continue?';
    if (!window.confirm(question)) return;
    setSubmitting(true);
    try {
      const body = { ...form, plan_code: form.plan_code.trim(), reference: form.reference.trim(), amount: form.amount.trim(), currency: form.currency.trim().toUpperCase() };
      const outcome = subscribing ? await platformApi.markSubscribed(tenantId, body) : await platformApi.recordPayment(tenantId, body);
      setResult(outcome);
      onDone?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record this payment.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <p className={styles.hint}>
        {subscribing
          ? 'Record the cash or bank-transfer payment and mark this tenant subscribed. It moves to the subscribed address and each active user gets an e-mail with their login details and the paid-until date. Nothing is charged to a card.'
          : 'Record another cash or bank-transfer payment. The paid-until date moves forward; the tenant’s super admins get a receipt.'}
      </p>
      <label className={styles.field}>
        <span className={styles.label}>Plan code</span>
        <input className={styles.input} value={form.plan_code} onChange={set('plan_code')} required />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Payment method</span>
        <select className={styles.input} value={form.method} onChange={set('method')}>
          {METHODS.map((method) => (
            <option key={method.value} value={method.value}>{method.label}</option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Receipt or transfer reference (3–100 characters, must be unique)</span>
        <input className={styles.input} value={form.reference} onChange={set('reference')} required minLength={3} maxLength={100} />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Amount received</span>
        <input className={styles.input} value={form.amount} onChange={set('amount')} required inputMode="decimal" placeholder="50000.00" />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Currency (must match the plan)</span>
        <input className={styles.input} value={form.currency} onChange={set('currency')} required maxLength={3} />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Paid until</span>
        <input className={styles.input} type="date" value={form.paid_until} onChange={set('paid_until')} required />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Reason (recorded on the audit trail)</span>
        <input className={styles.input} value={form.reason} onChange={set('reason')} required placeholder="e.g. Transfer confirmed in the bank statement" />
      </label>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {result && (
        <p role="status" className={styles.hint}>
          Recorded. Paid until {result.paidUntil}.{' '}
          {result.emails ? `${result.emails.queued} e-mail(s) queued, ${result.emails.alreadySent} already sent before.` : ''}
        </p>
      )}
      <Button type="submit" loading={submitting}>
        {subscribing ? 'Mark subscribed' : 'Record payment'}
      </Button>
    </form>
  );
}
