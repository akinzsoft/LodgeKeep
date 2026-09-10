import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { Money, isBalanceSettled, describeBalanceState } from '../../shared/format/money.jsx';
import { cashieringApi, arApi, profilesApi, ApiError } from '../../shared/api/index.js';
import { openPaystackPopup } from '../../shared/paystack.js';
import { OutstandingBalancesTab } from './OutstandingBalancesTab.jsx';
import formStyles from './CashieringForm.module.css';
import styles from './CashieringScreen.module.css';

const TABS = [
  { key: 'balances', label: 'Balances' },
  { key: 'lookup', label: 'Folio Lookup' },
];

/**
 * CashieringScreen — PLAN.md Phase 2.5, PRODUCT_REQUIREMENTS.md §3.5.
 *
 * Two tabs. "Balances" (default) is new — gap closure (user-reported):
 * "see all outstanding balance of guest and there room no." Before this,
 * the screen had no relationship at all to PRODUCT_REQUIREMENTS.md's own
 * "Role-based views" table, which names an "Open folios list" as the
 * Cashier role's own LANDING screen — a real, previously-unflagged gap,
 * not an invented one. "Folio Lookup" is everything this screen already
 * was: a plain reservation-id lookup, since no other screen exposes a
 * "view this reservation's folio" deep link — a caller who already knows
 * the id (visible on Reservations/Front Desk) enters it here, or arrives
 * via "View folio" from the Balances tab (`handleViewFolio`).
 *
 * This does NOT contradict this screen's own original "one screen, not
 * four tabs" reasoning — that was specifically about PRODUCT_REQUIREMENTS.md's
 * four named Cashiering *actions* (folio view, split billing, payment
 * capture, refunds/adjustments) being the same destination against the
 * SAME folio, not four separate ones. "Open folios list" is a genuinely
 * different, property-wide destination — the same category of addition
 * every other multi-tab screen here (`SetupScreen`, `BookingScreen`,
 * `HousekeepingScreen`, `ReportingScreen`) already handles with a tab, not
 * a second top-level nav item.
 *
 * Voided lines render struck-through, never removed (PRODUCT_REQUIREMENTS.md
 * §3.5's own explicit requirement, and ARCHITECTURE.md §8's "void, never
 * delete" made visible).
 */
export function CashieringScreen({ isOffline = false }) {
  const [tab, setTab] = useState('balances');
  const [reservationIdInput, setReservationIdInput] = useState('');
  const [reservationId, setReservationId] = useState(null);
  const [folios, setFolios] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // PLAN.md Phase 4 (Accounts Receivable) — the company list for the "Bill
  // to company" picker (below), fetched once here rather than per folio
  // panel, since every panel on this screen shares the same list.
  const [companies, setCompanies] = useState([]);

  useEffect(() => {
    profilesApi.listCompanyProfiles().then(setCompanies).catch(() => setCompanies([]));
  }, []);

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

  function handleViewFolio(id) {
    setReservationIdInput(String(id));
    setReservationId(String(id));
    loadFolios(id);
    setTab('lookup');
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

      <div className={styles.tabs} role="tablist" aria-label="Cashiering sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`.trim()}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={styles.panel}>
        {tab === 'balances' && <OutstandingBalancesTab isOffline={isOffline} onViewFolio={handleViewFolio} />}

        {tab === 'lookup' && (
          <>
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
                  companies={companies}
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
          </>
        )}
      </div>
    </div>
  );
}

function FolioPanel({ folio, otherFolios, companies, isOffline, submitting, onAction }) {
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
  const [checkoutAccessCode, setCheckoutAccessCode] = useState(null);
  const [checkoutPaymentId, setCheckoutPaymentId] = useState(null);
  const [openingPopup, setOpeningPopup] = useState(false);
  const isSettled = isBalanceSettled(folio.balance);
  const balanceState = describeBalanceState(folio.balance);

  // PLAN.md Phase 4 (Accounts Receivable) — `undefined` = not applicable
  // (no company billed to this folio) or not yet loaded; `null` = billed to
  // a company but that company has no AR account at this property (a real,
  // if unusual, state — `billFolioToCompany` itself requires an active
  // account to exist, but nothing prevents the account being closed
  // afterward).
  const [arAccount, setArAccount] = useState(undefined);
  const [arAccountError, setArAccountError] = useState(null);
  const [showBillPicker, setShowBillPicker] = useState(false);
  const [billCompanyId, setBillCompanyId] = useState('');

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

  useEffect(() => {
    if (!folio.company_profile_id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing state as `folio.company_profile_id` changes (e.g. an un-bill action), not a fetch
      setArAccount(undefined);
      return;
    }
    setArAccountError(null);
    arApi
      .listAccounts()
      .then((accounts) => {
        setArAccount(accounts.find((a) => String(a.company_profile_id) === String(folio.company_profile_id)) ?? null);
      })
      .catch((caught) => {
        setArAccount(null);
        setArAccountError(caught instanceof ApiError ? caught.message : 'Could not load this folio’s AR account.');
      });
  }, [folio.company_profile_id]);

  async function handleBillToCompany(companyProfileId) {
    await onAction(() => cashieringApi.billFolioToCompany(folio.id, companyProfileId || null));
    setShowBillPicker(false);
    setBillCompanyId('');
  }

  return (
    <Card title={`Folio ${folio.folio_number} — ${folio.billed_to}`}>
      <div className={styles.folioHeader}>
        <StatusPill tone={folio.status === 'open' ? 'success' : 'neutral'} label={folio.status === 'open' ? 'Open' : 'Closed'} />
        {folio.status === 'open' && balanceState && <StatusPill tone={balanceState.tone} label={balanceState.label} />}
        {arAccount?.is_over_limit && <StatusPill tone="danger" label="AR account over limit" />}
        <span className={styles.balance}>
          Balance: <Money amount={folio.balance} currencyCode={folio.currency} />
        </span>
      </div>

      {/*
        Gap closure (PLAN.md Phase 4, Accounts Receivable): replaces the
        raw `window.prompt`-driven `billed_to` label with a real company
        picker wired to the backend's `bill-to-account` endpoint. `billed_to`
        itself is unchanged as a plain display label (auto-set to the
        company's name by the backend once billed) — this is purely about
        which folios settle through Accounts Receivable instead of a direct
        guest payment.
      */}
      {folio.status === 'open' && (
        <div className={formStyles.actionsRow}>
          {arAccountError && (
            <p role="alert" className={formStyles.errorBanner}>
              {arAccountError}
            </p>
          )}
          {folio.company_profile_id && arAccount && (
            <span className={styles.balance}>
              AR limit: <Money amount={arAccount.credit_limit} currencyCode={arAccount.currency} /> · AR balance:{' '}
              <Money amount={arAccount.current_balance} currencyCode={arAccount.currency} />
            </span>
          )}
          <Button size="compact" variant="secondary" disabled={isOffline || submitting} onClick={() => setShowBillPicker((v) => !v)}>
            {folio.company_profile_id ? 'Change company billing' : 'Bill to company'}
          </Button>
          {folio.company_profile_id && (
            <Button size="compact" variant="secondary" disabled={isOffline || submitting} onClick={() => handleBillToCompany(null)}>
              Un-bill (settle with guest instead)
            </Button>
          )}
        </div>
      )}

      {showBillPicker && (
        <div className={formStyles.actionsRow}>
          <select className={formStyles.select} value={billCompanyId} onChange={(event) => setBillCompanyId(event.target.value)}>
            <option value="">Select a company</option>
            {(companies ?? []).map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
          <Button size="compact" disabled={!billCompanyId || isOffline || submitting} onClick={() => handleBillToCompany(billCompanyId)}>
            Bill this folio
          </Button>
          <Button size="compact" variant="ghost" onClick={() => setShowBillPicker(false)}>
            Cancel
          </Button>
        </div>
      )}

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
        actions={(row) => (
          <div className={formStyles.actionsRow}>
            {/*
              Gap closure (user-reported): a real Paystack payment can
              succeed on Paystack's own side while this app's own copy
              stays PENDING/INITIATED — the webhook that would normally
              flip it to CAPTURED can't reach a local dev backend at all,
              and nothing anywhere in the UI ever called the backend's
              already-real `POST /cashiering/payments/:id/verify` (checks
              the transaction directly against Paystack's own API, not
              dependent on the webhook). Shown only for a still-pending
              gateway payment — cash is always synchronous, and a
              CAPTURED/FAILED/REFUNDED payment has nothing left to verify.
            */}
            {row.provider === 'paystack' && (row.status === 'PENDING' || row.status === 'INITIATED') && (
              <Button
                size="compact"
                variant="secondary"
                disabled={isOffline || submitting}
                onClick={async () => {
                  await onAction(() => cashieringApi.verifyPayment(row.id));
                  reload();
                }}
              >
                Verify
              </Button>
            )}
            {row.status === 'CAPTURED' && !row.parent_payment_id && (
              <Button size="compact" variant="danger" disabled={isOffline || submitting} onClick={() => setRefundingPayment(row)}>
                Refund
              </Button>
            )}
          </div>
        )}
      />

      {folio.status === 'open' && (
        <div className={formStyles.actionsRow}>
          <Button variant="secondary" size="compact" disabled={isOffline} onClick={() => setShowChargeForm((v) => !v)}>
            Post a charge
          </Button>
          <Button variant="secondary" size="compact" disabled={isOffline} onClick={() => setShowAdjustmentForm((v) => !v)}>
            Post an adjustment
          </Button>
          {/*
            Gap closure (PLAN.md Phase 4, Accounts Receivable): a folio
            billed to a company settles only through Accounts Receivable's
            own payment recording — the backend rejects a direct guest
            payment against it outright
            (`CANNOT_PAY_AR_BILLED_FOLIO_DIRECTLY`), so the button that
            would only ever fail is replaced with a plain notice rather
            than left for a person to click and be told no.
          */}
          {folio.company_profile_id ? (
            <p className={formStyles.disabledNotice}>Billed to {folio.billed_to} — settled through Accounts Receivable.</p>
          ) : (
            <Button variant="secondary" size="compact" disabled={isOffline || isSettled} onClick={() => setShowPaymentForm((v) => !v)}>
              Capture a payment
            </Button>
          )}
        </div>
      )}

      {showChargeForm && (
        <ChargeForm
          disabled={isOffline || submitting}
          isArBilled={Boolean(folio.company_profile_id)}
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
          isArBilled={Boolean(folio.company_profile_id)}
          onSubmit={async (values) => {
            await onAction(() => cashieringApi.postAdjustment(folio.id, values));
            setShowAdjustmentForm(false);
            reload();
          }}
          onCancel={() => setShowAdjustmentForm(false)}
        />
      )}

      {showPaymentForm && !isSettled && !folio.company_profile_id && (
        <PaymentForm
          currency={folio.currency}
          balance={folio.balance}
          disabled={isOffline || submitting}
          onCash={async (values) => {
            await onAction(() => cashieringApi.captureCashPayment(folio.id, values));
            setShowPaymentForm(false);
            reload();
          }}
          onPaystack={async (values) => {
            const result = await cashieringApi.capturePaystackPayment(folio.id, values);
            if (result?.authorizationUrl) setCheckoutUrl(result.authorizationUrl);
            if (result?.accessCode) setCheckoutAccessCode(result.accessCode);
            if (result?.id) setCheckoutPaymentId(result.id);
            await reload();
          }}
          onCancel={() => setShowPaymentForm(false)}
        />
      )}

      {/*
        Gap closure (user-reported): "make it more profeesional and standard
        form with the payment button" — one deliberate payment panel, not a
        raw checkout URL sitting as visible link text next to a button. The
        popup ("Pay now") is the one primary action; the plain checkout link
        is a small secondary fallback, still needed for a guest who isn't
        physically at this terminal. The popup's own success/close event is
        never trusted by itself (ARCHITECTURE.md §7); closing it always
        re-verifies through the real backend endpoint, the same one the
        "Verify" action above already uses. Hidden once the folio settles —
        nothing left to pay.
      */}
      {checkoutUrl && !isSettled && (
        <div className={formStyles.paymentPanel}>
          <p className={formStyles.paymentPanelHint}>Complete payment securely via Paystack — the popup opens on this page.</p>
          <div className={formStyles.actionsRow}>
            {checkoutAccessCode && (
              <Button
                type="button"
                disabled={isOffline}
                loading={openingPopup}
                onClick={async () => {
                  setOpeningPopup(true);
                  try {
                    await openPaystackPopup({
                      accessCode: checkoutAccessCode,
                      onClose: async () => {
                        const paymentId = checkoutPaymentId;
                        setCheckoutUrl(null);
                        setCheckoutAccessCode(null);
                        setCheckoutPaymentId(null);
                        setOpeningPopup(false);
                        if (paymentId) {
                          await onAction(() => cashieringApi.verifyPayment(paymentId));
                          reload();
                        }
                      },
                    });
                  } catch {
                    setOpeningPopup(false);
                  }
                }}
              >
                Pay now
              </Button>
            )}
            <a className={formStyles.paymentFallbackLink} href={checkoutUrl} target="_blank" rel="noreferrer">
              Open payment page in a new tab
            </a>
          </div>
        </div>
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

/**
 * PLAN.md Phase 4 (Accounts Receivable) — shown only on an AR-billed folio's
 * forms, since the backend's `overrideCreditLimit` path is only meaningful
 * there (`cashiering/service.js`'s `postCharge`/`postAdjustment`). No
 * client-side permission check gates this checkbox — per this codebase's
 * own "UI-level RBAC ... is convenience only, the API check ... is the real
 * one" rule, the backend re-verifies the caller actually holds `ar.manage`
 * before honoring it (`assertCanOverrideCreditLimit`), so a caller without
 * that permission simply gets a real 403 on submit.
 */
function CreditLimitOverrideFields({ overrideCreditLimit, onToggle, overrideReason, onReasonChange }) {
  return (
    <>
      <label className={formStyles.checkboxField}>
        <input type="checkbox" checked={overrideCreditLimit} onChange={(event) => onToggle(event.target.checked)} />
        <span className={formStyles.label}>Override credit limit if this would exceed it</span>
      </label>
      {overrideCreditLimit && (
        <label className={formStyles.field}>
          <span className={formStyles.label}>Override reason</span>
          <input className={formStyles.input} value={overrideReason} onChange={(event) => onReasonChange(event.target.value)} required />
        </label>
      )}
    </>
  );
}

function ChargeForm({ disabled, isArBilled = false, onSubmit, onCancel }) {
  const [type, setType] = useState('room_charge');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [overrideCreditLimit, setOverrideCreditLimit] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  return (
    <form
      className={formStyles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ type, description, amount, overrideCreditLimit, overrideReason: overrideCreditLimit ? overrideReason : undefined });
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
      {isArBilled && (
        <CreditLimitOverrideFields
          overrideCreditLimit={overrideCreditLimit}
          onToggle={setOverrideCreditLimit}
          overrideReason={overrideReason}
          onReasonChange={setOverrideReason}
        />
      )}
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

function AdjustmentForm({ disabled, isArBilled = false, onSubmit, onCancel }) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [overrideCreditLimit, setOverrideCreditLimit] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  return (
    <form
      className={formStyles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ description, amount, reason, overrideCreditLimit, overrideReason: overrideCreditLimit ? overrideReason : undefined });
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
      {isArBilled && (
        <CreditLimitOverrideFields
          overrideCreditLimit={overrideCreditLimit}
          onToggle={setOverrideCreditLimit}
          overrideReason={overrideReason}
          onReasonChange={setOverrideReason}
        />
      )}
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

/**
 * Gap closure (user-reported): "the form textfield amt is editable pls
 * correct it." The Amount field is locked to the folio's own real balance
 * — there is no free-text local `amount` state to hold a different value,
 * since a payment capture here always pays the full outstanding balance
 * (confirmed with the user: no partial-payment capability is needed today;
 * `ChargeForm`/`AdjustmentForm` keep their own free-text amounts unchanged,
 * since a charge or adjustment is legitimately arbitrary, never "the
 * balance").
 */
function PaymentForm({ currency, balance, disabled, onCash, onPaystack, onCancel }) {
  const [method, setMethod] = useState('cash');
  const [guestEmail, setGuestEmail] = useState('');

  return (
    <form
      className={formStyles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (method === 'cash') onCash({ amount: balance, currency });
        else onPaystack({ amount: balance, currency, guestEmail });
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
          <input
            className={`${formStyles.input} ${formStyles.inputLocked}`}
            value={balance}
            readOnly
            aria-readonly="true"
          />
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
