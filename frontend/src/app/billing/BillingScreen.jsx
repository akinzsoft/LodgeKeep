import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { billingApi, ApiError } from '../../shared/api/index.js';
import { openPaystackPopup } from '../../shared/paystack.js';
import styles from './BillingScreen.module.css';

/** DESIGN_SYSTEM.md §1: status is always a filled pill with a text label, never colour alone. `subscriptions.status` -> tone/label, owned here since this is the one screen that reads it. */
const SUBSCRIPTION_STATUS = {
  active: { tone: 'success', label: 'Active' },
  past_due: { tone: 'warning', label: 'Past due' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

/**
 * BillingScreen — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22. A single
 * page, no tabs — subscription status, payment method, and invoice
 * history are all facts about the SAME one `subscriptions` row this
 * tenant ever has (see that table's own migration header: one row per
 * tenant, no history), unlike AR/Group Blocks/POS's multi-entity tabbed
 * shape. Filed under SETUP in `nav-config.js`, gated on `billing.view`.
 *
 * The "add/replace payment method" flow reuses the SAME embedded Paystack
 * popup mechanism (`shared/paystack.js`) Cashiering's own card-payment flow
 * already established — start a checkout, open the popup, and on close
 * ALWAYS call the real backend `complete` endpoint rather than trusting the
 * popup's own success event (ARCHITECTURE.md §7 applies to a client-side
 * callback exactly as much as it does to a webhook).
 */
export function BillingScreen({ isOffline = false }) {
  const [overview, setOverview] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [error, setError] = useState(null);

  const [email, setEmail] = useState('');
  const [starting, setStarting] = useState(false);
  const [openingPopup, setOpeningPopup] = useState(false);
  const [checkout, setCheckout] = useState(null); // { accessCode, authorizationUrl, reference }
  const [paymentMethodError, setPaymentMethodError] = useState(null);

  async function reload() {
    setError(null);
    try {
      const [overviewData, invoiceRows] = await Promise.all([billingApi.getOverview(), billingApi.listInvoices()]);
      setOverview(overviewData);
      setInvoices(invoiceRows);
    } catch (caught) {
      setOverview(null);
      setInvoices([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load billing information.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  async function handleStartCheckout(event) {
    event.preventDefault();
    setStarting(true);
    setPaymentMethodError(null);
    try {
      const result = await billingApi.startPaymentMethodCheckout({ email });
      setCheckout(result);
    } catch (caught) {
      setPaymentMethodError(caught instanceof ApiError ? caught.message : 'Could not start the card-verification checkout.');
    } finally {
      setStarting(false);
    }
  }

  async function handleOpenPopup() {
    setOpeningPopup(true);
    try {
      await openPaystackPopup({
        accessCode: checkout.accessCode,
        onClose: async () => {
          const reference = checkout.reference;
          setCheckout(null);
          setOpeningPopup(false);
          try {
            await billingApi.completePaymentMethod(reference);
            await reload();
          } catch (caught) {
            setPaymentMethodError(caught instanceof ApiError ? caught.message : 'Could not confirm the new payment method.');
          }
        },
      });
    } catch {
      setOpeningPopup(false);
    }
  }

  const cardState = overview === null ? (error ? 'error' : 'loading') : 'success';
  const statusInfo = overview?.subscription ? SUBSCRIPTION_STATUS[overview.subscription.status] ?? { tone: 'neutral', label: overview.subscription.status } : null;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Billing</h1>

      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={styles.disabledNotice}>You are offline. Billing actions are disabled until connectivity returns.</p>}

      <div className={styles.cards}>
        <Card title="Subscription" state={cardState} errorMessage={error} emptyMessage="No plan configured.">
          {overview && (
            <div className={styles.summaryRow}>
              <div className={styles.summaryLine}>
                <span className={styles.summaryLabel}>Plan</span>
                <span>{overview.plan ? `${overview.plan.name} — ${overview.plan.price} ${overview.plan.currency}/${overview.plan.billing_interval}` : '—'}</span>
              </div>
              <div className={styles.summaryLine}>
                <span className={styles.summaryLabel}>Status</span>
                {overview.subscription ? <StatusPill tone={statusInfo.tone} label={statusInfo.label} /> : <StatusPill tone="neutral" label="No active subscription" />}
              </div>
              {overview.subscription && (
                <>
                  <div className={styles.summaryLine}>
                    <span className={styles.summaryLabel}>Current period</span>
                    <span>
                      {overview.subscription.current_period_start} – {overview.subscription.current_period_end}
                    </span>
                  </div>
                  {overview.subscription.consecutive_failed_attempts > 0 && (
                    <p className={styles.disabledNotice}>
                      {overview.subscription.consecutive_failed_attempts} failed payment attempt(s) so far this period — add a valid payment method below to
                      resolve this.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </Card>

        <Card title="Payment method" state={cardState} errorMessage={error}>
          {overview && (
            <div className={styles.summaryRow}>
              {overview.subscription?.payment_method ? (
                <p>
                  {overview.subscription.payment_method.brand?.toUpperCase()} •••• {overview.subscription.payment_method.last4} — expires{' '}
                  {overview.subscription.payment_method.exp_month}/{overview.subscription.payment_method.exp_year}
                </p>
              ) : (
                <p className={styles.summaryLabel}>No payment method on file yet.</p>
              )}

              {paymentMethodError && (
                <p role="alert" className={styles.errorBanner}>
                  {paymentMethodError}
                </p>
              )}

              {!checkout && (
                <form className={styles.form} onSubmit={handleStartCheckout}>
                  <label className={styles.field}>
                    <span className={styles.label}>Billing email</span>
                    <input
                      type="email"
                      className={styles.input}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="admin@yourhotel.example.com"
                      required
                    />
                  </label>
                  <div className={styles.actionsRow}>
                    <Button type="submit" loading={starting} disabled={isOffline}>
                      {overview.subscription?.payment_method ? 'Replace payment method' : 'Add payment method'}
                    </Button>
                  </div>
                </form>
              )}

              {checkout && (
                <div className={styles.paymentPanel}>
                  <p className={styles.paymentPanelHint}>A small, fully-refunded verification charge confirms the card — never the real subscription price.</p>
                  <div className={styles.actionsRow}>
                    <Button type="button" disabled={isOffline} loading={openingPopup} onClick={handleOpenPopup}>
                      Verify card now
                    </Button>
                    <a className={styles.paymentFallbackLink} href={checkout.authorizationUrl} target="_blank" rel="noreferrer">
                      Open payment page in a new tab
                    </a>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <DataTable
        title="Invoice history"
        state={invoices === null ? 'loading' : invoices.length === 0 ? 'empty' : 'success'}
        emptyMessage="No invoices yet — one is generated automatically at the start of each billing period."
        columns={[
          { key: 'period', label: 'Period', render: (row) => `${row.period_start} – ${row.period_end}` },
          { key: 'amount', label: 'Amount', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
          {
            key: 'status',
            label: 'Status',
            render: (row) =>
              row.status === 'paid' ? (
                <StatusPill tone="success" label="Paid" />
              ) : row.status === 'uncollectible' ? (
                <StatusPill tone="danger" label="Uncollectible" />
              ) : row.status === 'void' ? (
                <StatusPill tone="neutral" label="Void" />
              ) : (
                <StatusPill tone="warning" label="Open" />
              ),
          },
          { key: 'due_at', label: 'Due', render: (row) => row.due_at },
        ]}
        rows={invoices ?? []}
        rowKey={(row) => row.id}
      />
    </div>
  );
}
