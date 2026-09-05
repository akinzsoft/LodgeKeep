import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { cashieringApi, ApiError } from '../../shared/api/index.js';
import formStyles from './CashieringForm.module.css';
import styles from './CashieringScreen.module.css';

/**
 * CashieringScreen — PLAN.md Phase 2.5, PRODUCT_REQUIREMENTS.md §3.5.
 *
 * No router exists in this app (the same constraint every other screen
 * here works within), and no other screen exposes a "view this
 * reservation's folio" deep link yet — so this screen starts from a plain
 * reservation-id lookup rather than assuming navigation state it would
 * have to invent. A caller who already knows the reservation id (visible
 * on the Reservations/Front Desk tabs) enters it here.
 *
 * One screen, not four tabs, deliberately: PRODUCT_REQUIREMENTS.md's four
 * named Cashiering screens (folio view, split billing, payment capture,
 * refunds & adjustments) are all actions against the SAME folio a cashier
 * is already looking at, not four separate destinations — splitting them
 * into tabs would mean re-loading the same folio state four times over.
 *
 * Voided lines render struck-through, never removed (PRODUCT_REQUIREMENTS.md
 * §3.5's own explicit requirement, and ARCHITECTURE.md §8's "void, never
 * delete" made visible).
 */
export function CashieringScreen({ isOffline = false }) {
  const [reservationIdInput, setReservationIdInput] = useState('');
  const [reservationId, setReservationId] = useState(null);
  const [folios, setFolios] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function loadFolios(id) {
    setError(null);
    setFolios(null);
    try {
      const rows = await cashieringApi.listFoliosForReservation(id);
      setFolios(rows);
    } catch (caught) {
      setFolios([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load folios for this reservation.');
    }
  }

  function handleLookup(event) {
    event.preventDefault();
    const id = reservationIdInput.trim();
    if (!id) return;
    setReservationId(id);
    loadFolios(id);
  }

  async function withSubmitting(action) {
    setSubmitting(true);
    setError(null);
    try {
      await action();
      await loadFolios(reservationId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That action could not be completed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOpenAdditionalFolio() {
    const billedTo = window.prompt('Bill this folio to (e.g. "Guest" or a company name):', 'Company');
    if (billedTo === null) return;
    await withSubmitting(() => cashieringApi.openAdditionalFolio(reservationId, billedTo));
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Cashiering</h1>

      <Card title="Find a reservation's folio">
        <form className={formStyles.row} onSubmit={handleLookup}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Reservation ID</span>
            <input
              className={formStyles.input}
              value={reservationIdInput}
              onChange={(event) => setReservationIdInput(event.target.value)}
              placeholder="e.g. 42"
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit">Load folios</Button>
          </div>
        </form>
      </Card>

      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      {isOffline && (
        <p className={formStyles.disabledNotice}>You are offline. Cashiering actions are disabled until connectivity returns.</p>
      )}

      {folios !== null && folios.length === 0 && (
        <Card title="Folios" state="empty" emptyMessage="No folios exist yet for this reservation — check in the guest first." />
      )}

      {folios !== null &&
        folios.map((folio) => (
          <FolioPanel
            key={folio.id}
            folio={folio}
            otherFolios={folios.filter((f) => f.id !== folio.id)}
            isOffline={isOffline}
            submitting={submitting}
            onAction={withSubmitting}
          />
        ))}

      {folios !== null && folios.length > 0 && (
        <div className={formStyles.actionsRow}>
          <Button variant="secondary" disabled={isOffline || submitting} onClick={handleOpenAdditionalFolio}>
            Open a split folio
          </Button>
        </div>
      )}
    </div>
  );
}

function FolioPanel({ folio, otherFolios, isOffline, submitting, onAction }) {
  const [lineItems, setLineItems] = useState(null);
  const [payments, setPayments] = useState(null);
  const [showChargeForm, setShowChargeForm] = useState(false);
  const [showAdjustmentForm, setShowAdjustmentForm] = useState(false);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [voidingLine, setVoidingLine] = useState(null);
  const [refundingPayment, setRefundingPayment] = useState(null);
  const [movingLine, setMovingLine] = useState(null);
  const [destinationFolioId, setDestinationFolioId] = useState('');
  const [checkoutUrl, setCheckoutUrl] = useState(null);

  async function reload() {
    try {
      const detail = await cashieringApi.getFolio(folio.id);
      setLineItems(detail.lineItems);
      setPayments(detail.payments);
    } catch {
      setLineItems([]);
      setPayments([]);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is redefined every render and only needs to run once per folio.id (this panel is remounted, not re-propped, when the folio list changes — see CashieringScreen's key={folio.id} usage).
  }, [folio.id]);

  return (
    <Card title={`Folio ${folio.folio_number} — ${folio.billed_to}`}>
      <div className={styles.folioHeader}>
        <StatusPill tone={folio.status === 'open' ? 'success' : 'neutral'} label={folio.status === 'open' ? 'Open' : 'Closed'} />
        <span className={styles.balance}>
          Balance: <Money amount={folio.balance} currencyCode={folio.currency} />
        </span>
      </div>

      <DataTable
        title="Line items"
        state={lineItems === null ? 'loading' : 'success'}
        emptyMessage="No charges posted yet."
        columns={[
          { key: 'business_date', label: 'Date' },
          { key: 'type', label: 'Type' },
          {
            key: 'description',
            label: 'Description',
            render: (row) => <span className={row.voided_at ? styles.voided : ''}>{row.description}</span>,
          },
          {
            key: 'amount',
            label: 'Amount',
            align: 'right',
            render: (row) => (
              <span className={row.voided_at ? styles.voided : ''}>
                <Money amount={row.amount} currencyCode={folio.currency} />
              </span>
            ),
          },
        ]}
        rows={lineItems ?? []}
        rowKey={(row) => row.id}
        actions={(row) =>
          !row.voided_at &&
          row.type !== 'payment' &&
          row.type !== 'refund' && (
            <div className={formStyles.actionsRow}>
              {otherFolios.length > 0 && (
                <Button size="compact" variant="secondary" disabled={isOffline || submitting} onClick={() => setMovingLine(row)}>
                  Move
                </Button>
              )}
              <Button size="compact" variant="danger" disabled={isOffline || submitting} onClick={() => setVoidingLine(row)}>
                Void
              </Button>
            </div>
          )
        }
      />

      <DataTable
        title="Payments"
        state={payments === null ? 'loading' : 'success'}
        emptyMessage="No payments captured yet."
        columns={[
          { key: 'provider', label: 'Method' },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={row.status === 'CAPTURED' ? 'success' : row.status === 'FAILED' ? 'danger' : 'neutral'} label={row.status} /> },
          { key: 'amount', label: 'Amount', align: 'right', render: (row) => <Money amount={row.amount} currencyCode={row.currency} /> },
        ]}
        rows={payments ?? []}
        rowKey={(row) => row.id}
        actions={(row) =>
          row.status === 'CAPTURED' &&
          !row.parent_payment_id && (
            <Button size="compact" variant="danger" disabled={isOffline || submitting} onClick={() => setRefundingPayment(row)}>
              Refund
            </Button>
          )
        }
      />

      {folio.status === 'open' && (
        <div className={formStyles.actionsRow}>
          <Button variant="secondary" size="compact" disabled={isOffline} onClick={() => setShowChargeForm((v) => !v)}>
            Post a charge
          </Button>
          <Button variant="secondary" size="compact" disabled={isOffline} onClick={() => setShowAdjustmentForm((v) => !v)}>
            Post an adjustment
          </Button>
          <Button variant="secondary" size="compact" disabled={isOffline} onClick={() => setShowPaymentForm((v) => !v)}>
            Capture a payment
          </Button>
        </div>
      )}

      {showChargeForm && (
        <ChargeForm
          disabled={isOffline || submitting}
          onSubmit={async (values) => {
            await onAction(() => cashieringApi.postCharge(folio.id, values));
            setShowChargeForm(false);
            reload();
          }}
          onCancel={() => setShowChargeForm(false)}
        />
      )}

      {showAdjustmentForm && (
        <AdjustmentForm
          disabled={isOffline || submitting}
          onSubmit={async (values) => {
            await onAction(() => cashieringApi.postAdjustment(folio.id, values));
            setShowAdjustmentForm(false);
            reload();
          }}
          onCancel={() => setShowAdjustmentForm(false)}
        />
      )}

      {showPaymentForm && (
        <PaymentForm
          currency={folio.currency}
          disabled={isOffline || submitting}
          onCash={async (values) => {
            await onAction(() => cashieringApi.captureCashPayment(folio.id, values));
            setShowPaymentForm(false);
            reload();
          }}
          onPaystack={async (values) => {
            const result = await cashieringApi.capturePaystackPayment(folio.id, values);
            if (result?.authorizationUrl) setCheckoutUrl(result.authorizationUrl);
            await reload();
          }}
          onCancel={() => setShowPaymentForm(false)}
        />
      )}

      {checkoutUrl && (
        <p className={formStyles.disabledNotice}>
          Paystack checkout started — send the guest this link to complete payment:{' '}
          <a href={checkoutUrl} target="_blank" rel="noreferrer">
            {checkoutUrl}
          </a>
        </p>
      )}

      {voidingLine && (
        <ConfirmDialog
          title="Void line item"
          consequence={`This voids "${voidingLine.description}" (${voidingLine.amount}). It stays visible, struck through, and cannot be undone.`}
          requireReason
          confirmLabel="Void this line"
          onConfirm={async (reason) => {
            await onAction(() => cashieringApi.voidLineItem(voidingLine.id, reason));
            setVoidingLine(null);
            reload();
          }}
          onCancel={() => setVoidingLine(null)}
        />
      )}

      {refundingPayment && (
        <ConfirmDialog
          title="Refund payment"
          consequence={`This refunds the full ${refundingPayment.amount} ${refundingPayment.currency} payment (${refundingPayment.provider}). It cannot be undone.`}
          requireReason
          confirmLabel="Confirm refund"
          onConfirm={async (reason) => {
            await onAction(() => cashieringApi.refundPayment(refundingPayment.id, { reason }));
            setRefundingPayment(null);
            reload();
          }}
          onCancel={() => setRefundingPayment(null)}
        />
      )}

      {movingLine && (
        <div className={styles.moveDialog} role="dialog" aria-label="Move line item">
          <p>Move &quot;{movingLine.description}&quot; to:</p>
          <select className={formStyles.select} value={destinationFolioId} onChange={(event) => setDestinationFolioId(event.target.value)}>
            <option value="">Select a folio</option>
            {otherFolios.map((f) => (
              <option key={f.id} value={f.id}>
                {f.folio_number} — {f.billed_to}
              </option>
            ))}
          </select>
          <div className={formStyles.actionsRow}>
            <Button
              disabled={!destinationFolioId}
              onClick={async () => {
                await onAction(() => cashieringApi.moveLineItem(movingLine.id, destinationFolioId));
                setMovingLine(null);
                setDestinationFolioId('');
                reload();
              }}
            >
              Move
            </Button>
            <Button variant="ghost" onClick={() => setMovingLine(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ChargeForm({ disabled, onSubmit, onCancel }) {
  const [type, setType] = useState('room_charge');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');

  return (
    <form
      className={formStyles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ type, description, amount });
      }}
    >
      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Type</span>
          <select className={formStyles.select} value={type} onChange={(event) => setType(event.target.value)}>
            <option value="room_charge">Room charge</option>
            <option value="pos_charge">POS charge</option>
          </select>
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Description</span>
          <input className={formStyles.input} value={description} onChange={(event) => setDescription(event.target.value)} required />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Amount</span>
          <input className={formStyles.input} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required />
        </label>
      </div>
      <div className={formStyles.actionsRow}>
        <Button type="submit" disabled={disabled}>
          Post charge
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AdjustmentForm({ disabled, onSubmit, onCancel }) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  return (
    <form
      className={formStyles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ description, amount, reason });
      }}
    >
      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Description</span>
          <input className={formStyles.input} value={description} onChange={(event) => setDescription(event.target.value)} required />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Amount (negative for a discount)</span>
          <input className={formStyles.input} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="-20.00" required />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Reason</span>
          <input className={formStyles.input} value={reason} onChange={(event) => setReason(event.target.value)} required />
        </label>
      </div>
      <div className={formStyles.actionsRow}>
        <Button type="submit" disabled={disabled}>
          Post adjustment
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function PaymentForm({ currency, disabled, onCash, onPaystack, onCancel }) {
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const [guestEmail, setGuestEmail] = useState('');

  return (
    <form
      className={formStyles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (method === 'cash') onCash({ amount, currency });
        else onPaystack({ amount, currency, guestEmail });
      }}
    >
      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Method</span>
          <select className={formStyles.select} value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="cash">Cash</option>
            <option value="paystack">Paystack (card/digital)</option>
          </select>
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Amount</span>
          <input className={formStyles.input} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required />
        </label>
        {method === 'paystack' && (
          <label className={formStyles.field}>
            <span className={formStyles.label}>Guest email</span>
            <input
              type="email"
              className={formStyles.input}
              value={guestEmail}
              onChange={(event) => setGuestEmail(event.target.value)}
              required
            />
          </label>
        )}
      </div>
      <div className={formStyles.actionsRow}>
        <Button type="submit" disabled={disabled}>
          Capture payment
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
