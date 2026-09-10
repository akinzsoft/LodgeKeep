import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { arApi, profilesApi, ApiError } from '../../shared/api/index.js';
import formStyles from './ARForm.module.css';

const EMPTY_PAYMENT_FORM = { amount: '', currency: '', method_label: '', reference: '', received_at: '' };

/**
 * PaymentsTab — PLAN.md Phase 4 (Accounts Receivable), PRODUCT_REQUIREMENTS.md
 * §3.9's "payment collection workflows." Manual recording only, no gateway
 * (this session's confirmed decision) — `method_label` is a plain free-text
 * field (wire/cheque/bank transfer), not a fixed enum, matching
 * `ar_payments.method_label`'s own shape on the backend. Applications are
 * optional at recording time — an "on-account" payment with no
 * applications is a real, valid state (`ar/service.js`'s own header: the
 * full amount reduces exposure immediately regardless of allocation) — and
 * can be applied later via the "Apply" action on an already-recorded
 * payment.
 */
export function PaymentsTab({ isOffline = false }) {
  const [accounts, setAccounts] = useState(null);
  const [companies, setCompanies] = useState(null);
  const [accountId, setAccountId] = useState('');
  const [payments, setPayments] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [error, setError] = useState(null);

  const [form, setForm] = useState(EMPTY_PAYMENT_FORM);
  const [applications, setApplications] = useState([]);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState(null);

  const [applyingPayment, setApplyingPayment] = useState(null);
  const [applyRows, setApplyRows] = useState([]);
  const [applySubmitting, setApplySubmitting] = useState(false);
  const [applyError, setApplyError] = useState(null);

  const [voidingPayment, setVoidingPayment] = useState(null);

  useEffect(() => {
    Promise.all([arApi.listAccounts(), profilesApi.listCompanyProfiles()])
      .then(([accountRows, companyRows]) => {
        setAccounts(accountRows);
        setCompanies(companyRows);
      })
      .catch((caught) => {
        setAccounts([]);
        setCompanies([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load AR accounts.');
      });
  }, []);

  function companyName(companyProfileId) {
    return (companies ?? []).find((c) => String(c.id) === String(companyProfileId))?.name ?? `Company ${companyProfileId}`;
  }

  async function loadForAccount(id) {
    setError(null);
    setPayments(null);
    setInvoices(null);
    try {
      const [paymentRows, invoiceRows] = await Promise.all([arApi.listPaymentsForAccount(id), arApi.listInvoicesForAccount(id)]);
      setPayments(paymentRows);
      setInvoices(invoiceRows.filter((invoice) => invoice.status !== 'void'));
    } catch (caught) {
      setPayments([]);
      setInvoices([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load payments for this account.');
    }
  }

  function handleSelectAccount(event) {
    const id = event.target.value;
    setAccountId(id);
    const account = (accounts ?? []).find((a) => String(a.id) === id);
    setForm({ ...EMPTY_PAYMENT_FORM, currency: account?.currency ?? '' });
    setApplications([]);
    if (id) loadForAccount(id);
    else {
      setPayments(null);
      setInvoices(null);
    }
  }

  function addApplicationRow() {
    setApplications([...applications, { invoiceId: '', amount: '' }]);
  }

  function updateApplicationRow(index, changes) {
    setApplications(applications.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  }

  function removeApplicationRow(index) {
    setApplications(applications.filter((_, i) => i !== index));
  }

  async function handleRecordPayment(event) {
    event.preventDefault();
    setRecording(true);
    setRecordError(null);
    try {
      await arApi.recordPayment(accountId, {
        amount: form.amount,
        currency: form.currency,
        methodLabel: form.method_label,
        reference: form.reference || undefined,
        receivedAt: form.received_at || undefined,
        applications: applications.filter((row) => row.invoiceId && row.amount).length > 0 ? applications.filter((row) => row.invoiceId && row.amount) : undefined,
      });
      const account = (accounts ?? []).find((a) => String(a.id) === accountId);
      setForm({ ...EMPTY_PAYMENT_FORM, currency: account?.currency ?? '' });
      setApplications([]);
      await loadForAccount(accountId);
    } catch (caught) {
      setRecordError(caught instanceof ApiError ? caught.message : 'Could not record this payment.');
    } finally {
      setRecording(false);
    }
  }

  function startApply(payment) {
    setApplyingPayment(payment);
    setApplyRows([{ invoiceId: '', amount: '' }]);
    setApplyError(null);
  }

  async function handleApply(event) {
    event.preventDefault();
    setApplySubmitting(true);
    setApplyError(null);
    try {
      await arApi.applyPayment(applyingPayment.id, applyRows.filter((row) => row.invoiceId && row.amount));
      setApplyingPayment(null);
      await loadForAccount(accountId);
    } catch (caught) {
      setApplyError(caught instanceof ApiError ? caught.message : 'Could not apply this payment.');
    } finally {
      setApplySubmitting(false);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Payment actions are disabled until connectivity returns.</p>}

      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Account</span>
          <select className={formStyles.select} value={accountId} onChange={handleSelectAccount}>
            <option value="">Select an account</option>
            {(accounts ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {companyName(account.company_profile_id)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {accountId && (
        <>
          <DataTable
            title="Payments"
            state={payments === null ? 'loading' : payments.length === 0 ? 'empty' : 'success'}
            emptyMessage="No payments recorded yet for this account."
            columns={[
              { key: 'received_at', label: 'Received' },
              { key: 'method_label', label: 'Method' },
              { key: 'reference', label: 'Reference', render: (row) => row.reference ?? '—' },
              { key: 'amount', label: 'Amount', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
              {
                key: 'status',
                label: 'Status',
                render: (row) => (row.voided_at ? <StatusPill tone="neutral" label="Voided" /> : <StatusPill tone="success" label="Recorded" />),
              },
            ]}
            rows={payments ?? []}
            rowKey={(row) => row.id}
            actions={(row) =>
              !row.voided_at && (
                <div className={formStyles.actionsRow}>
                  <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => startApply(row)}>
                    Apply
                  </Button>
                  <Button size="compact" variant="danger" disabled={isOffline} onClick={() => setVoidingPayment(row)}>
                    Void
                  </Button>
                </div>
              )
            }
          />

          <Card title="Record a payment">
            {recordError && (
              <p role="alert" className={formStyles.errorBanner}>
                {recordError}
              </p>
            )}
            <form className={formStyles.form} onSubmit={handleRecordPayment}>
              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Amount</span>
                  <input className={formStyles.input} value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="0.00" required />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Currency</span>
                  <input
                    className={formStyles.input}
                    value={form.currency}
                    onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })}
                    maxLength={3}
                    required
                  />
                </label>
              </div>
              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Method</span>
                  <input
                    className={formStyles.input}
                    value={form.method_label}
                    onChange={(event) => setForm({ ...form, method_label: event.target.value })}
                    placeholder="wire, cheque, bank transfer…"
                    required
                  />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Reference</span>
                  <input className={formStyles.input} value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Received on</span>
                  <input
                    type="date"
                    className={formStyles.input}
                    value={form.received_at}
                    onChange={(event) => setForm({ ...form, received_at: event.target.value })}
                  />
                </label>
              </div>

              <div>
                <span className={formStyles.label}>Apply to invoices (optional — an unapplied payment is still recorded)</span>
                {applications.map((row, index) => (
                  <div className={formStyles.row} key={index}>
                    <label className={formStyles.field}>
                      <select
                        className={formStyles.select}
                        value={row.invoiceId}
                        onChange={(event) => updateApplicationRow(index, { invoiceId: event.target.value })}
                      >
                        <option value="">Select an invoice</option>
                        {(invoices ?? []).map((invoice) => (
                          <option key={invoice.id} value={invoice.id}>
                            {invoice.invoice_number} ({invoice.total_amount} {invoice.currency})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={formStyles.field}>
                      <input
                        className={formStyles.input}
                        value={row.amount}
                        onChange={(event) => updateApplicationRow(index, { amount: event.target.value })}
                        placeholder="0.00"
                      />
                    </label>
                    <Button type="button" variant="ghost" size="compact" onClick={() => removeApplicationRow(index)}>
                      Remove
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="secondary" size="compact" onClick={addApplicationRow}>
                  Add an invoice application
                </Button>
              </div>

              <div className={formStyles.actionsRow}>
                <Button type="submit" loading={recording} disabled={isOffline}>
                  Record payment
                </Button>
              </div>
            </form>
          </Card>
        </>
      )}

      {applyingPayment && (
        <Card title={`Apply payment (${applyingPayment.amount} ${applyingPayment.currency})`}>
          {applyError && (
            <p role="alert" className={formStyles.errorBanner}>
              {applyError}
            </p>
          )}
          <form className={formStyles.form} onSubmit={handleApply}>
            {applyRows.map((row, index) => (
              <div className={formStyles.row} key={index}>
                <label className={formStyles.field}>
                  <select
                    className={formStyles.select}
                    value={row.invoiceId}
                    onChange={(event) => setApplyRows(applyRows.map((r, i) => (i === index ? { ...r, invoiceId: event.target.value } : r)))}
                    required
                  >
                    <option value="">Select an invoice</option>
                    {(invoices ?? []).map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.invoice_number} ({invoice.total_amount} {invoice.currency})
                      </option>
                    ))}
                  </select>
                </label>
                <label className={formStyles.field}>
                  <input
                    className={formStyles.input}
                    value={row.amount}
                    onChange={(event) => setApplyRows(applyRows.map((r, i) => (i === index ? { ...r, amount: event.target.value } : r)))}
                    placeholder="0.00"
                    required
                  />
                </label>
              </div>
            ))}
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={applySubmitting} disabled={isOffline}>
                Apply
              </Button>
              <Button type="button" variant="ghost" onClick={() => setApplyingPayment(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {voidingPayment && (
        <ConfirmDialog
          title="Void payment"
          consequence={`This voids the ${voidingPayment.amount} ${voidingPayment.currency} payment recorded on ${voidingPayment.received_at}, reversing any invoice applications it made. It cannot be undone.`}
          requireReason
          confirmLabel="Void this payment"
          onConfirm={async (reason) => {
            const target = voidingPayment;
            setVoidingPayment(null);
            try {
              await arApi.voidPayment(target.id, reason);
              await loadForAccount(accountId);
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not void this payment.');
            }
          }}
          onCancel={() => setVoidingPayment(null)}
        />
      )}
    </div>
  );
}
