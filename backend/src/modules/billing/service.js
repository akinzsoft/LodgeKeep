'use strict';

/**
 * Subscription billing — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22.
 * The piece that makes self-service tenant signup commercially real: a
 * plan catalogue, recurring charges against the plan a tenant is on
 * (starting from trial conversion), a tokenised payment method on file,
 * failed-payment dunning, and gateway webhook handling.
 *
 * ── ACCESS PATTERN: A STAFF CALLER REACHING PLATFORM_SCOPED TABLES ───────
 *
 * `subscriptions`/`subscription_invoices`/`subscription_payments`/
 * `subscription_webhook_events` are PLATFORM_SCOPED with `tenant_id` an
 * `unscopedColumns` mandatory business column (see each migration's own
 * header) — Planmsys' own billing relationship with a tenant, not the
 * tenant's operational data. Every HTTP-facing function here is called
 * with an ordinary STAFF context (a real tenant admin viewing/managing
 * their own subscription), which cannot call `.platform()` directly (that
 * entry point requires a PLATFORM or SYSTEM audience). Following
 * `src/modules/platform/service.js`'s own `listImpersonationSessionsForTenant`
 * precedent for the identical shape of problem: every read/write here
 * rebuilds a SYSTEM context internally and filters explicitly by
 * `context.tenantId` (or a `tenantId` closed over from that same real
 * caller context) — never a caller-supplied tenant id — so one tenant can
 * never reach another's billing rows.
 *
 * The recurring billing cycle (`processTenantBillingCycle`,
 * `src/jobs/subscription-billing.js`'s own sweep) instead uses
 * `workerContext({tenantId})` throughout, reaching `tenants`/`users`/
 * `audit_log` (all TENANT_SCOPED) on the SAME connection as the
 * PLATFORM_SCOPED billing writes via `.platform().withContext(...)` — the
 * same rebind-onto-the-same-connection mechanism
 * `platformTenantLifecycle()`/`provisionTenant()` already established,
 * needed here for the identical reason: a suspend-on-dunning-exhaustion
 * write to `tenants` plus its own `audit_log` row must commit atomically
 * with the billing state it was triggered by.
 *
 * ── WHY A SEPARATE GATEWAY ADAPTER, NOT CASHIERING'S ─────────────────────
 *
 * See `paystack-gateway.js`'s own header — no shared abstraction exists to
 * extend, and the relationship is structurally different (Planmsys
 * charging a tenant vs. a guest paying a hotel), matching
 * PRODUCT_REQUIREMENTS.md §3.22's own explicit call for a pluggable
 * billing processor built as its own module from the start.
 *
 * ── ARCHITECTURE.md §7: A DB TRANSACTION CANNOT COMMIT ATOMICALLY WITH A
 *    PAYMENT PROVIDER ──────────────────────────────────────────────────
 *
 * Every real charge attempt (a renewal, a dunning retry) follows the same
 * three-step shape `cashiering/service.js`'s own Paystack flow already
 * established: (1) a local `subscription_payments` row is inserted
 * `INITIATED`, committed, BEFORE the gateway is ever called; (2) the real
 * `chargeAuthorization` HTTP call happens outside any open transaction;
 * (3) `applyChargeOutcome` applies the result via a CONDITIONAL UPDATE
 * (`WHERE status IN ('INITIATED','PENDING')`) — naturally idempotent, so
 * the SAME function can be called again by the webhook receiver
 * (`receiveBillingWebhook`) without double-applying an outcome the
 * synchronous path already recorded (an affected-row count of 0 is the
 * proof, the identical idiom `trial-expiry.js`/`platform/service.js`
 * already use for "did this already happen").
 *
 * ── OUT OF SCOPE, DELIBERATELY (confirmed with the user before building) ─
 *
 * Usage-based metering, plan upgrades/downgrades mid-cycle, invoicing
 * UI/PDF generation, tenant offboarding and data export.
 */

const { scopedDb } = require('../../db');
const { systemContext, workerContext } = require('../tenancy');
const { recordAuditEntry } = require('../../audit');
const { generateUlid } = require('../../shared/ulid');
const { isDunningAttemptDue, isDunningExhausted, nextAttemptDate } = require('./dunning');
const { writeOutboxEvent } = require('../../shared/outbox');
const { enqueueOutboxDispatch } = require('../../jobs/outbox-dispatcher');
const { assertAllowedCallbackUrl } = require('../../shared/callback-url');
const {
  NoActivePlanError,
  CardVerificationFailedError,
  InvoiceNotFoundError,
  CheckoutNotFoundError,
  CheckoutMismatchError,
  CheckoutExpiredError,
} = require('./errors');
const gateway = require('./paystack-gateway');
const { classifyGatewayRecord, interpretGatewayError } = require('../../shared/gateway-record');
const { persistWebhookEvent, finalizeWebhookEvent, deferWebhookEvent, webhookEventKey, RECORD_NOT_FOUND_GRACE_ATTEMPTS } = require('../../shared/webhook-events');

const CARD_VERIFICATION_AMOUNT = process.env.BILLING_CARD_VERIFICATION_AMOUNT || '50.00';
/** Re-review finding — how long a `billing_payment_method_checkouts` row stays completable after `startAddPaymentMethodCheckout` creates it. */
const CHECKOUT_EXPIRY_MINUTES = Number(process.env.BILLING_CHECKOUT_EXPIRY_MINUTES) || 30;

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

/** A staff-scoped read of the tenant's own row — `tenants` is TENANT_SCOPED with scopeRoot 'tenant', so this always resolves to exactly the caller's own tenant. */
async function getOwnTenant({ context }) {
  return scopedDb().for(context).table('tenants').first();
}

/**
 * `tenants` carries no `base_currency` column of its own (confirmed by
 * reading its migration directly) — a pre-existing gap this pass found
 * while adding the `billing_payment_method_checkouts.currency` NOT NULL
 * column (see that migration's own header): the card-verification
 * checkout's currency was silently `undefined` before this fix, never
 * caught because nothing previously validated it. Resolved the same way
 * `resolveBillingEmail` already resolves "the tenant's own billing
 * contact" from its first active property, in the absence of a real
 * tenant-level field — flagged here rather than silently masked, the same
 * discipline that function's own header already uses.
 */
async function resolveTenantCurrency({ context }) {
  const db = scopedDb().for(context);
  const property = await db.table('properties').where({ status: 'active' }).orderBy('id').first('base_currency');
  return property ? property.base_currency : 'NGN';
}

async function resolveDefaultPlan(db) {
  const plan = await db.reference().table('plans').where({ is_active: true }).orderBy('id').first();
  if (!plan) throw new NoActivePlanError();
  return plan;
}

async function resolvePlanFor(db, tenant) {
  if (!tenant.plan_id) return resolveDefaultPlan(db);
  const plan = await db.reference().table('plans').where({ id: tenant.plan_id }).first();
  return plan ?? resolveDefaultPlan(db);
}

/** Adds one calendar month, clamping to the shorter month's last day rather than overflowing (e.g. Jan 31 -> Feb 28/29, never Mar 3). Pure. */
function addOneMonth(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const targetMonthIndex = month; // 0-based next month
  const daysInTargetMonth = new Date(Date.UTC(year, targetMonthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  const result = new Date(Date.UTC(year, targetMonthIndex, clampedDay));
  return result.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Read side — GET /billing/*
// ---------------------------------------------------------------------

async function getBillingOverview({ context }) {
  const tenant = await getOwnTenant({ context });
  const db = scopedDb().for(systemContext());
  const [subscription, plan] = await Promise.all([
    db.platform().table('subscriptions').where({ tenant_id: context.tenantId }).first(),
    resolvePlanFor(db, tenant),
  ]);

  return {
    tenant: { status: tenant.status, trial_ends_at: tenant.trial_ends_at },
    plan: plan ? { id: String(plan.id), code: plan.code, name: plan.name, price: plan.price, currency: plan.currency, billing_interval: plan.billing_interval } : null,
    subscription: subscription
      ? {
          id: String(subscription.id),
          status: subscription.status,
          current_period_start: subscription.current_period_start,
          current_period_end: subscription.current_period_end,
          consecutive_failed_attempts: subscription.consecutive_failed_attempts,
          payment_method: subscription.payment_method_authorization_code
            ? {
                provider: subscription.payment_method_provider,
                last4: subscription.payment_method_last4,
                brand: subscription.payment_method_brand,
                exp_month: subscription.payment_method_exp_month,
                exp_year: subscription.payment_method_exp_year,
              }
            : null,
        }
      : null,
  };
}

async function listPlans() {
  const db = scopedDb().for(systemContext());
  return db.reference().table('plans').where({ is_active: true }).orderBy('id');
}

async function listInvoices({ context }) {
  const db = scopedDb().for(systemContext());
  const subscription = await db.platform().table('subscriptions').where({ tenant_id: context.tenantId }).first();
  if (!subscription) return [];
  return db.platform().table('subscription_invoices').where({ tenant_id: context.tenantId, subscription_id: subscription.id }).orderBy('period_start', 'desc');
}

async function listPaymentsForInvoice({ context, invoiceId }) {
  const db = scopedDb().for(systemContext());
  const invoice = await db.platform().table('subscription_invoices').where({ tenant_id: context.tenantId, id: invoiceId }).first();
  if (!invoice) throw new InvoiceNotFoundError();
  return db.platform().table('subscription_payments').where({ tenant_id: context.tenantId, subscription_invoice_id: invoiceId }).orderBy('created_at', 'desc');
}

// ---------------------------------------------------------------------
// Add / replace payment method
// ---------------------------------------------------------------------

/**
 * Starts a small (`BILLING_CARD_VERIFICATION_AMOUNT`) verification charge
 * to capture a reusable card authorization — never the real subscription
 * price. Refunded automatically once `completeAddPaymentMethod` verifies
 * it succeeded (see that function and `paystack-gateway.js`'s own header).
 *
 * Security fix: records a `billing_payment_method_checkouts` row BEFORE
 * the gateway is ever called — ARCHITECTURE.md §7's exact "local intent
 * row, committed, before the external call" shape every other real payment
 * flow in this codebase already follows (`payments`/`subscription_payments`
 * both do this). This is the ownership/replay record
 * `completeAddPaymentMethod` verifies a client-supplied `reference`
 * against, instead of trusting it outright — see that migration's own
 * header for the vulnerability this closes.
 */
async function startAddPaymentMethodCheckout({ context, email, callbackUrl }) {
  // Security fix — `callback_url` used to reach Paystack unvalidated, a
  // classic open redirect (see `src/shared/callback-url.js`'s own header).
  // Checked against the caller's own STAFF-scoped accessor, not the
  // SYSTEM-scoped one below — `tenants`/`tenant_domains` are both
  // TENANT_SCOPED and need `context.tenantId` to resolve at all.
  await assertAllowedCallbackUrl(scopedDb().for(context), { callbackUrl });

  const reference = `billing-card-${generateUlid()}`;
  const amount = CARD_VERIFICATION_AMOUNT;
  const currency = await resolveTenantCurrency({ context });

  const db = scopedDb().for(systemContext());
  await db.platform().table('billing_payment_method_checkouts').insert({
    tenant_id: context.tenantId,
    reference,
    email,
    amount,
    currency,
    // Re-review finding — this row used to stay completable forever.
    expires_at: minutesFromNow(CHECKOUT_EXPIRY_MINUTES),
  });

  const { authorizationUrl, accessCode } = await gateway.initializeTransaction({
    email,
    amount,
    currency,
    reference,
    callbackUrl,
  });
  return { authorizationUrl, accessCode, reference };
}

/**
 * Verifies the checkout above, captures the reusable authorization, and
 * upserts the tenant's ONE `subscriptions` row (see that table's own
 * migration header — one row per tenant, no history).
 *
 * ── SECURITY FIX ─────────────────────────────────────────────────────────
 * This used to trust a client-supplied `reference` outright: as long as
 * Paystack's own `/transaction/verify` reported `status: 'success'` with a
 * reusable authorization, whatever card it returned was attached to the
 * caller's tenant — with nothing checking the reference belonged to a
 * checkout THIS tenant started, nor that the verified amount/currency
 * matched what was expected. A `billing.manage` caller (any admin of any
 * tenant, trivially self-signed-up) could submit a reference for ANY
 * successful transaction on the platform's billing account, including a
 * stranger's, and silently capture that stranger's card. Fixed with four
 * checks, in order: (1) the reference must resolve to a `pending`,
 * unexpired `billing_payment_method_checkouts` row belonging to THIS
 * tenant — the same 404-not-403 shape every other cross-tenant lookup here
 * uses, and checked BEFORE the gateway is even called, so an invalid
 * reference never reaches Paystack at all; (2) the gateway's own verified
 * amount/currency must match what was recorded when the checkout started;
 * (3) the `reusable` flag Paystack returns must genuinely be true — a
 * one-off, non-reusable authorization can never become a recurring-billing
 * token; (4) the checkout row is claimed with a conditional UPDATE
 * (`WHERE status = 'pending'`) — replay protection, not just ownership.
 *
 * ── RE-REVIEW FIX: THE CLAIM MOVED BEFORE THE REFUND ─────────────────────
 * The claim used to happen LAST, inside the subscription-write transaction
 * — after `refundTransaction` had already been called. Two concurrent
 * completions for the SAME reference could both pass every check above
 * (verification is idempotent, so both see identical results) and both
 * reach `refundTransaction` before either claimed the row; only one
 * subscription update would ultimately win, but Paystack would already
 * have received two real refund calls for the one charge — a genuine
 * duplicate side effect a losing request's later rejection can't undo.
 * `refundTransaction`, unlike `verifyTransaction`, is NOT safe to call
 * twice. The claim is now a single, atomic, immediately-committed
 * statement — no explicit transaction needed, since one `UPDATE` is
 * already its own atomic unit — placed BEFORE the refund call so a losing
 * request is rejected before it can trigger any external side effect at
 * all, the same ordering discipline this codebase's AR payment-application
 * and stock-control fixes already established for "claim before doing the
 * thing that can't be undone by rejecting you afterward." The claim's own
 * `WHERE` also re-checks `expires_at` — belt-and-braces against the narrow
 * window between the read below and this statement.
 */
async function completeAddPaymentMethod({ context, reference, requestId, ip, userAgent }) {
  const readDb = scopedDb().for(systemContext());
  const checkout = await readDb
    .platform()
    .table('billing_payment_method_checkouts')
    .where({ tenant_id: context.tenantId, reference, status: 'pending' })
    .first();
  if (!checkout) throw new CheckoutNotFoundError();
  if (new Date(checkout.expires_at).getTime() <= Date.now()) throw new CheckoutExpiredError();

  const verification = await gateway.verifyTransaction({ reference });
  if (verification.status !== 'success' || !verification.authorization.authorizationCode || !verification.authorization.reusable) {
    throw new CardVerificationFailedError(verification.status);
  }
  if (verification.amountSubunit !== gateway.toSubunit(checkout.amount) || verification.currency !== checkout.currency) {
    throw new CheckoutMismatchError();
  }

  // The replay guard, moved ahead of the refund call — see this
  // function's own header. A second concurrent (or later, reused) call
  // for the SAME reference sees 0 affected rows here and is rejected
  // BEFORE it can call `refundTransaction`, even though the read above
  // already found the row `pending` — the actual exclusivity is this
  // atomic, WHERE-guarded UPDATE, not that earlier read.
  const claimed = await readDb
    .platform()
    .table('billing_payment_method_checkouts')
    .where({ id: checkout.id, status: 'pending' })
    .where('expires_at', '>', new Date())
    .update({ status: 'consumed' });
  if (claimed === 0) throw new CheckoutNotFoundError();

  // The verification charge itself was never a real subscription payment —
  // reverse it now that the authorization is safely captured AND this
  // request has won the claim above, so it is the only caller that will
  // ever reach this line for this reference. Best-effort: a refund
  // failure must not lose the captured card, so it is logged, not
  // thrown — the tenant is out the small verification amount until support
  // can reconcile it manually, a far better failure mode than silently
  // losing the payment method that was the actual point of this call.
  try {
    await gateway.refundTransaction({ reference });
  } catch (error) {
    console.error(`Failed to refund the billing card-verification charge (${reference}); the payment method was still captured:`, error);
  }

  const auth = verification.authorization;
  const tenant = await getOwnTenant({ context });
  const db = scopedDb().for(systemContext());
  const plan = await resolvePlanFor(db, tenant);

  return db.transaction(async (trx) => {
    const existing = await trx.platform().table('subscriptions').where({ tenant_id: context.tenantId }).forUpdate().first();

    const paymentMethodFields = {
      payment_method_provider: 'paystack',
      payment_method_authorization_code: auth.authorizationCode,
      payment_method_last4: auth.last4,
      payment_method_brand: auth.brand,
      payment_method_exp_month: auth.expMonth,
      payment_method_exp_year: auth.expYear,
    };

    let subscriptionId;
    if (existing) {
      // Replacing the card on an existing subscription — reset the failure
      // counter so a fresh, valid card gets a clean slate at the very next
      // scheduled attempt, rather than inheriting a dunning count run up
      // against the OLD card.
      await trx.platform().table('subscriptions').where({ id: existing.id }).update({ ...paymentMethodFields, consecutive_failed_attempts: 0 });
      subscriptionId = existing.id;
    } else {
      // First-ever payment method for this tenant — creates the
      // subscriptions row. `current_period_start` is the trial's own end
      // date when one is still running (the unified trial-conversion +
      // renewal design this migration's own header commits to: the SAME
      // periodic job that handles ordinary renewals also handles the very
      // first trial-to-paid transition, once that date arrives) — or today,
      // for a tenant with no running trial (a lapsed/already-active tenant
      // adding a payment method for the first time).
      const periodStart = tenant.status === 'trial' && tenant.trial_ends_at && new Date(tenant.trial_ends_at) > new Date()
        ? new Date(tenant.trial_ends_at).toISOString().slice(0, 10)
        : today();
      const [id] = await trx.platform().table('subscriptions').insert({
        tenant_id: context.tenantId,
        plan_id: plan.id,
        status: 'active',
        current_period_start: periodStart,
        current_period_end: addOneMonth(periodStart),
        ...paymentMethodFields,
      });
      subscriptionId = id;
    }

    // audit_log is TENANT_SCOPED — needs a tenant-scoped accessor on this
    // SAME connection, the rebind-onto-the-same-connection mechanism
    // `.platform().withContext(...)` now exposes (scoped-db.js's own
    // header), avoiding the cross-connection deadlock class
    // `src/modules/signup/service.js` found and fixed once already.
    const tenantDb = trx.platform().withContext(workerContext({ tenantId: context.tenantId }));
    await recordAuditEntry(tenantDb, {
      entityType: 'subscriptions',
      entityId: subscriptionId,
      action: existing ? 'payment_method_replaced' : 'payment_method_added',
      source: 'api',
      afterState: { last4: auth.last4, brand: auth.brand },
      requestId,
      ipAddress: ip,
      userAgent,
    });

    return { id: String(subscriptionId) };
  });
}

// ---------------------------------------------------------------------
// The recurring billing cycle — src/jobs/subscription-billing.js's sweep
// ---------------------------------------------------------------------

/** The tenant's first active user — used only as the "email of record" Paystack's charge API requires. No dedicated `subscriptions.billing_email` column was added this pass (see this pass's own report for the reasoning) — flagged as a real, narrow follow-on gap, not silently assumed away. */
async function resolveBillingEmail(tenantId) {
  const db = scopedDb().for(workerContext({ tenantId }));
  const user = await db.table('users').where({ status: 'active' }).orderBy('id').first();
  return user ? user.email : null;
}

/**
 * Ensures the current period has an invoice to collect — one row per
 * (subscription, period_start), `UNIQUE(subscription_id, period_start)`
 * making a double-create under a concurrent sweep run structurally
 * impossible (an `ER_DUP_ENTRY` on the second attempt, caught and treated
 * as "already exists" — the same defensive shape `ensurePrimaryFolio`'s
 * own sibling functions elsewhere in this codebase already use).
 */
async function ensureCurrentInvoice(db, subscription) {
  const where = { tenant_id: subscription.tenant_id, subscription_id: subscription.id, period_start: subscription.current_period_start };
  const existing = await db.platform().table('subscription_invoices').where(where).first();
  if (existing) return existing;

  try {
    const plan = await db.reference().table('plans').where({ id: subscription.plan_id }).first();
    await db.platform().table('subscription_invoices').insert({
      tenant_id: subscription.tenant_id,
      subscription_id: subscription.id,
      amount: plan.price,
      currency: plan.currency,
      status: 'open',
      period_start: subscription.current_period_start,
      period_end: subscription.current_period_end,
      due_at: subscription.current_period_start,
    });
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
  }
  return db.platform().table('subscription_invoices').where(where).first();
}

/**
 * One tenant's own billing cycle, one sweep tick. Structured as several
 * short transactions rather than one long one — see this file's own
 * header ("ARCHITECTURE.md §7") for why the real gateway call cannot sit
 * inside either database step.
 */
async function processTenantBillingCycle({ tenantId, now = new Date() }) {
  const bootstrapDb = scopedDb().for(systemContext());

  // Step 1 — lock the subscription, ensure this period's invoice exists,
  // and decide whether a charge attempt is due right now. Committed before
  // any gateway call.
  const step1 = await bootstrapDb.transaction(async (trx) => {
    const subscription = await trx.platform().table('subscriptions').where({ tenant_id: tenantId }).forUpdate().first();
    if (!subscription || subscription.status === 'canceled') return { action: 'skip' };
    if (new Date(subscription.current_period_start) > now) return { action: 'skip' }; // not due yet

    const invoice = await ensureCurrentInvoice(trx, subscription);
    if (invoice.status !== 'open') return { action: 'skip' }; // already paid/void/uncollectible

    // A concurrent sweep tick's own step 1 can commit (creating an
    // INITIATED payment row) BEFORE its step 2/3 ever resolves the
    // outcome — the invoice itself stays 'open' the whole time the
    // gateway call is in flight, since it only flips once
    // `applyChargeOutcome` runs. Without this check, a second tick that
    // acquires the subscription's row lock in between would see the SAME
    // still-'open' invoice, the SAME not-yet-incremented attempt_count,
    // and start a SECOND real charge attempt against the same invoice —
    // a genuine double-charge race, caught by this module's own
    // real-concurrency mutation test, not by inspection.
    const inFlight = await trx.platform().table('subscription_payments').where({ subscription_invoice_id: invoice.id }).whereIn('status', ['INITIATED', 'PENDING']).first();
    if (inFlight) return { action: 'skip' };

    if (!isDunningAttemptDue(invoice, now)) return { action: 'skip' };

    const reference = `billing-charge-${generateUlid()}`;
    const [paymentId] = await trx.platform().table('subscription_payments').insert({
      tenant_id: tenantId,
      subscription_invoice_id: invoice.id,
      idempotency_key: reference,
      provider: 'paystack',
      provider_reference: reference,
      amount: invoice.amount,
      currency: invoice.currency,
      status: 'INITIATED',
    });

    return { action: 'charge', subscription, invoice, paymentId: String(paymentId), reference };
  });

  if (step1.action !== 'charge') return step1;

  // Step 2 — the real gateway call, deliberately outside any transaction.
  const email = await resolveBillingEmail(tenantId);
  let outcome;
  try {
    const result = await gateway.chargeAuthorization({
      email: email ?? `billing+tenant-${tenantId}@planmsys.invalid`,
      amount: step1.invoice.amount,
      currency: step1.invoice.currency,
      authorizationCode: step1.subscription.payment_method_authorization_code,
      reference: step1.reference,
    });
    outcome = { success: result.status === 'success', providerPaymentId: result.providerPaymentId, gatewayResponse: result.gatewayResponse };
  } catch (error) {
    outcome = { success: false, providerPaymentId: null, gatewayResponse: error.message };
  }

  // Step 3 — apply the outcome. See `applyChargeOutcome`'s own header for
  // why this is naturally idempotent against a later webhook re-delivery.
  return applyChargeOutcome({ tenantId, paymentId: step1.paymentId, ...outcome });
}

/**
 * The escalating retry-stage wording — confirmed with the user: "a
 * tenant-facing email notification at each retry stage... escalating in
 * urgency, with a final warning before suspension actually triggers."
 * Indexed by how many attempts have now failed (1..4 — the 5th and final
 * failure gets `billing_subscription_suspended` instead of an entry here,
 * since there is no further retry left to describe). Kept as data next to
 * where the outbox payload is built, not in `dunning.js` — that file's own
 * charter is schedule math, never presentation copy.
 */
const DUNNING_URGENCY_STAGES = [
  {
    label: 'Payment failed',
    message:
      'We were unable to process your subscription payment. This is fully automatic — we will retry automatically over the next two weeks, and your account stays completely usable in the meantime.',
  },
  {
    label: 'Second attempt failed',
    message: 'Your subscription payment has failed again. Please check that the card on file is still valid and has sufficient funds.',
  },
  {
    label: 'Third attempt failed',
    message: 'This is your third failed payment attempt. Please update your payment method soon to avoid any interruption to your account.',
  },
  {
    label: 'Final warning',
    message:
      'Your subscription payment has now failed four times. If the next scheduled retry also fails, your account will be suspended (read-only, your data untouched) until a valid payment method is added.',
  },
];

/**
 * Applies a charge outcome to a `subscription_payments` row — called from
 * BOTH `processTenantBillingCycle`'s own synchronous path (immediately
 * after the gateway call returns) and `receiveBillingWebhook` (a later,
 * independent confirmation of the same event). The `WHERE status IN
 * ('INITIATED','PENDING')` conditional UPDATE is what makes calling this
 * twice for the same payment safe — a webhook arriving after the
 * synchronous path already applied the SAME outcome affects zero rows and
 * does nothing further, the same "affected-row-count is the proof" idiom
 * this codebase's own `trial-expiry.js`/`platform/service.js` already use.
 */
async function applyChargeOutcome({ tenantId, paymentId, success, providerPaymentId, gatewayResponse }) {
  const db = scopedDb().for(systemContext());
  let notify = null; // set inside the transaction, dispatched (best-effort) only after it commits
  const result = await db.transaction(async (trx) => {
    const claimed = await trx
      .platform()
      .table('subscription_payments')
      .where({ id: paymentId, tenant_id: tenantId })
      .whereIn('status', ['INITIATED', 'PENDING'])
      .update(
        success
          ? { status: 'CAPTURED', captured_at: new Date(), provider_payment_id: providerPaymentId }
          : { status: 'FAILED', failed_at: new Date(), failure_reason: gatewayResponse ? String(gatewayResponse).slice(0, 500) : null }
      );
    if (claimed === 0) return { action: 'already_applied' };

    const payment = await trx.platform().table('subscription_payments').where({ id: paymentId }).first();
    const invoice = await trx.platform().table('subscription_invoices').where({ id: payment.subscription_invoice_id }).forUpdate().first();
    const subscription = await trx.platform().table('subscriptions').where({ id: invoice.subscription_id }).forUpdate().first();
    const tenantDb = trx.platform().withContext(workerContext({ tenantId }));
    const tenant = await tenantDb.table('tenants').where({ id: tenantId }).first();

    if (success) {
      await trx.platform().table('subscription_invoices').where({ id: invoice.id }).update({ status: 'paid', paid_at: new Date() });
      const newPeriodStart = invoice.period_end;
      await trx.platform().table('subscriptions').where({ id: subscription.id }).update({
        status: 'active',
        consecutive_failed_attempts: 0,
        current_period_start: newPeriodStart,
        current_period_end: addOneMonth(newPeriodStart),
      });

      // Trial-to-paid conversion, the unified mechanism this whole design
      // commits to (see `subscriptions`' own migration header): the first
      // SUCCESSFUL charge against a still-`trial` tenant is what actually
      // converts it, not the moment a card was added.
      if (tenant.status === 'trial') {
        await tenantDb.table('tenants').where({ id: tenantId }).update({ status: 'active', plan_id: subscription.plan_id });
        await recordAuditEntry(tenantDb, { entityType: 'tenants', entityId: tenantId, action: 'trial_converted', source: 'job', beforeState: { status: 'trial' }, afterState: { status: 'active' } });
      }

      await recordAuditEntry(tenantDb, { entityType: 'subscription_payments', entityId: paymentId, action: 'captured', source: 'job', afterState: { amount: payment.amount } });
      return { action: 'captured' };
    }

    const newAttemptCount = invoice.attempt_count + 1;
    await trx.platform().table('subscription_invoices').where({ id: invoice.id }).update({ attempt_count: newAttemptCount });
    await trx.platform().table('subscriptions').where({ id: subscription.id }).update({
      status: 'past_due',
      consecutive_failed_attempts: subscription.consecutive_failed_attempts + 1,
    });
    await recordAuditEntry(tenantDb, { entityType: 'subscription_payments', entityId: paymentId, action: 'failed', source: 'job', afterState: { reason: gatewayResponse } });

    // Confirmed with the user: a real retry-and-notify sequence, not
    // suspension on the first failure — an escalating email at every
    // retry stage, via the outbox pattern, `tenants.status` untouched
    // (`past_due` stays fully operational) the whole time. Both reads stay
    // on `tenantDb` — the SAME connection this transaction already holds
    // locks on — rather than opening a second one for what would otherwise
    // be an unrelated plain read (this codebase's own repeated
    // cross-connection-deadlock lesson, `src/modules/signup/service.js`'s
    // own header).
    const notificationProperty = await tenantDb.table('properties').orderBy('id').first();
    const notificationPropertyId = notificationProperty ? notificationProperty.id : null;
    const billingUser = await tenantDb.table('users').where({ status: 'active' }).orderBy('id').first();
    const recipientEmail = billingUser ? billingUser.email : null;

    if (isDunningExhausted(newAttemptCount)) {
      await trx.platform().table('subscription_invoices').where({ id: invoice.id }).update({ status: 'uncollectible' });
      // The same raw conditional UPDATE `src/jobs/trial-expiry.js` already
      // established for "a job suspends a tenant" — `platform/service.js`'s
      // own `suspendTenant` structurally rejects a SYSTEM-audience caller
      // (see that accessor's own header), so this bypasses it the same
      // way that job already does, rather than widening that function's
      // contract for a second caller. Suspension still only ever degrades
      // to the EXISTING read-only pattern (`src/shared/tenant-lifecycle.js`)
      // — a tenant's data is untouched, reads still succeed — never a hard
      // lockout, and fires automatically with no human approval gate: the
      // four escalating notifications already sent are the real safety
      // mechanism, per the user's own explicit "a manual checkpoint won't
      // scale or get reliably checked."
      const suspended = await tenantDb.table('tenants').where({ id: tenantId }).whereIn('status', ['trial', 'active']).update({ status: 'suspended' });
      if (suspended > 0) {
        await recordAuditEntry(tenantDb, { entityType: 'tenants', entityId: tenantId, action: 'billing_suspended', source: 'job', afterState: { status: 'suspended' }, reason: 'Subscription payment retries exhausted.' });
      }
      if (recipientEmail) {
        await writeOutboxEvent({
          trx: tenantDb,
          eventType: 'billing.subscription_suspended',
          aggregateType: 'tenants',
          aggregateId: tenantId,
          propertyId: notificationPropertyId,
          payload: { recipientEmail, tenantName: tenant.name, attemptCount: newAttemptCount },
        });
        notify = { tenantId };
      }
      return { action: 'exhausted_suspended' };
    }

    if (recipientEmail) {
      const stage = DUNNING_URGENCY_STAGES[newAttemptCount - 1];
      await writeOutboxEvent({
        trx: tenantDb,
        eventType: 'billing.payment_failed',
        aggregateType: 'subscription_invoices',
        aggregateId: invoice.id,
        propertyId: notificationPropertyId,
        payload: {
          recipientEmail,
          tenantName: tenant.name,
          urgencyLabel: stage.label,
          message: stage.message,
          amount: invoice.amount,
          currency: invoice.currency,
          nextRetryDate: nextAttemptDate(invoice.due_at, newAttemptCount),
        },
      });
      notify = { tenantId };
    }

    return { action: 'failed_will_retry' };
  });

  // ARCHITECTURE.md §13/§14: best-effort reactive dispatch trigger, fired
  // only after the transaction that wrote the outbox row has committed —
  // never inside it (the identical placement `runIdempotentMutation`
  // already establishes for the HTTP path). A Redis outage must never
  // fail the billing cycle itself; the periodic sweep is the durable
  // fallback.
  if (notify) {
    enqueueOutboxDispatch({ tenantId: notify.tenantId }).catch((error) => {
      console.error('Failed to enqueue outbox dispatch for a billing notification (will be caught by the periodic sweep):', error);
    });
  }
  return result;
}

// ---------------------------------------------------------------------
// Webhook — verify / persist / deduplicate / process idempotently / audit
// ---------------------------------------------------------------------

/**
 * ARCHITECTURE.md §7's mandatory webhook pipeline, applied here exactly as
 * `cashiering/service.js`'s own `receivePaystackWebhook` counterpart
 * already does: verify the signature before anything else touches the
 * payload, persist the raw event unconditionally (so a processing bug
 * never loses the record of what the gateway actually sent), deduplicate
 * on `(provider, provider_event_id)`, and only THEN process — by
 * resolving the event's own `reference` back to a `subscription_payments`
 * row and calling the exact same `applyChargeOutcome` the synchronous
 * job path calls, which is what makes a redundant delivery of an
 * already-applied event a genuine no-op rather than a double-charge/
 * double-conversion risk.
 */
async function receiveBillingWebhook({ rawBody, signatureHeader, payload }) {
  const verified = gateway.verifyWebhookSignature({ rawBody, signatureHeader });
  const providerEventId = webhookEventKey({ event: payload?.event, id: payload?.data?.id, fallback: payload?.data?.reference ?? generateUlid() });

  // Attribute a SIGNED event to the tenant it concerns; an unsigned request
  // names references of its own choosing, so nothing it says is attributed.
  const reference = payload?.data?.reference;
  const localPayment = verified && reference ? await findSubscriptionPaymentByReference(reference) : null;

  // Persist FIRST (API.md §7). An unsigned request is kept as evidence but can
  // never block or alter a later signed event with the same id, and a signed
  // redelivery of an event that was persisted but never finalized is processed
  // again instead of being deduplicated away — see `src/shared/webhook-events.js`.
  const persisted = await persistWebhookEvent({
    events: subscriptionWebhookEvents,
    provider: 'paystack',
    providerEventId,
    payload,
    verified,
    attribution: localPayment ? { tenant_id: localPayment.tenant_id, related_subscription_payment_id: localPayment.id } : {},
  });

  if (!verified) return { verified: false };
  if (!persisted.needsProcessing) return { deduplicated: true };

  const { outcome } = await processBillingWebhookEvent({ eventId: persisted.id });
  return { verified: true, outcome };
}

/** A fresh PLATFORM_SCOPED table builder for the event table — `persistWebhookEvent`/`finalizeWebhookEvent` want one per call. */
function subscriptionWebhookEvents() {
  return scopedDb().for(systemContext()).platform().table('subscription_webhook_events');
}

function findSubscriptionPaymentByReference(reference) {
  return scopedDb().for(systemContext()).platform().table('subscription_payments').where({ provider: 'paystack', provider_reference: reference }).first();
}

/** The only Paystack events that may change a subscription payment. Anything else is recorded and ignored. */
const BILLING_WEBHOOK_CHARGE_EVENTS = new Set(['charge.success', 'charge.failed']);
const OPEN_SUBSCRIPTION_PAYMENT_STATUSES = new Set(['INITIATED', 'PENDING']);
const SETTLED_SUBSCRIPTION_PAYMENT_STATUSES = new Set(['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED']);

/**
 * Decides ONE persisted billing webhook event — ARCHITECTURE.md §7: the webhook
 * is a hint, Paystack's own record is the truth.
 *
 * A valid HMAC proves who SENT the event, not that what it claims is what
 * Paystack holds. Nothing in the body (status, amount, currency) is trusted:
 * this asks Paystack for its record of the transaction, compares it to the
 * LOCAL `subscription_payments` row (`classifyGatewayRecord`) and only then
 * calls `applyChargeOutcome` — the same function the synchronous charge path
 * uses, untouched. Without this, a validly-signed but false `charge.success`
 * could mark an invoice paid, advance a subscription period, or convert a
 * trial tenant to active.
 *
 * The verify call runs with NO database transaction open (ARCHITECTURE.md
 * §6.4). Keyed by the persisted event row and safe to call any number of
 * times: the inline attempt, a Paystack redelivery and the retry sweep
 * (`src/jobs/payment-webhooks.js`) all land here. Outcomes are the same set
 * the guest-payment processor records; see `cashiering/service.js`'s
 * `processPaymentWebhookEvent`.
 *
 * The event of a card-verification checkout (`billing_payment_method_checkouts`)
 * legitimately matches no `subscription_payments` row and is recorded as
 * `ignored`/`unknown_reference`.
 */
async function decideBillingWebhookEvent({ eventId, now = new Date() }) {
  const events = subscriptionWebhookEvents;
  const event = await events().where({ id: eventId }).first();
  if (!event) return { outcome: null, skipped: true };
  if (event.outcome != null || !event.verified) return { outcome: event.outcome, skipped: true };

  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
  const eventType = payload?.event;
  const reference = payload?.data?.reference;

  const finalize = async (outcome, detail, attribution) => {
    await finalizeWebhookEvent({ events, id: event.id, outcome, detail, attribution, now });
    return { outcome };
  };

  if (!BILLING_WEBHOOK_CHARGE_EVENTS.has(eventType)) return finalize('ignored', { reason: 'event_not_handled', event: eventType ?? null });

  const payment = reference ? await findSubscriptionPaymentByReference(reference) : null;
  if (!payment) return finalize('ignored', { reason: 'unknown_reference' });

  const attribution = { tenant_id: payment.tenant_id, related_subscription_payment_id: payment.id };

  if (SETTLED_SUBSCRIPTION_PAYMENT_STATUSES.has(payment.status)) return finalize('ignored', { reason: 'already_settled', paymentStatus: payment.status }, attribution);

  const terminalUnpaid = !OPEN_SUBSCRIPTION_PAYMENT_STATUSES.has(payment.status);
  if (terminalUnpaid && eventType === 'charge.failed') return finalize('ignored', { reason: 'already_terminal', paymentStatus: payment.status }, attribution);

  const defer = async (reason) => {
    const result = await deferWebhookEvent({ events, id: event.id, attemptCount: event.attempt_count, reason, now });
    if (result === 'deferred_exhausted') {
      await recordBillingWebhookAudit({ payment, action: 'gateway_webhook_deferred_exhausted', detail: { eventId: event.id, reason } });
    }
    return { outcome: result };
  };

  let record;
  try {
    record = await gateway.verifyTransaction({ reference: payment.provider_reference });
  } catch (error) {
    if (interpretGatewayError(error) === 'record_not_found') {
      // Not decided on the first look (read-after-write lag, a rotated key): retry a few
      // times, and only a persistent 404 is a rejection.
      if (event.attempt_count < RECORD_NOT_FOUND_GRACE_ATTEMPTS) return defer('record_not_found');
      const detail = { code: 'RECORD_NOT_FOUND', message: 'Paystack has no transaction with this reference.', httpStatus: 404 };
      await recordBillingWebhookAudit({ payment, action: 'gateway_webhook_rejected', detail: { eventId: event.id, ...detail } });
      return finalize('rejected', detail, attribution);
    }
    // Paystack unreachable, rate-limited, or a bad/missing key: not a verdict.
    // Loud, because a misconfigured key must never look like a quiet rejection.
    console.error(`[billing-webhook] could not verify ${payment.provider_reference} with Paystack (event ${event.id}): ${error?.message ?? error}`);
    return defer(`verify_failed: ${error?.message ?? 'unknown error'}`);
  }

  const result = classifyGatewayRecord({
    record,
    local: { reference: payment.provider_reference, amount: payment.amount, currency: payment.currency },
  });

  if (result.verdict === 'mismatch') {
    const detail = { code: result.reasons[0].code, reasons: result.reasons, expected: result.expected, observed: result.observed };
    console.error(`[billing-webhook] REJECTED signed event ${event.id} for ${payment.provider_reference}: ${result.reasons.map((r) => r.code).join(', ')}`);
    await recordBillingWebhookAudit({ payment, action: 'gateway_webhook_rejected', detail: { eventId: event.id, ...detail } });
    return finalize('rejected', detail, attribution);
  }

  if (result.verdict === 'not_final') {
    if (terminalUnpaid) return finalize('ignored', { reason: 'already_terminal', paymentStatus: payment.status }, attribution);
    return defer(`transaction_not_final: ${record.status}`);
  }

  if (terminalUnpaid) {
    if (result.verdict === 'failed') return finalize('ignored', { reason: 'already_terminal', paymentStatus: payment.status }, attribution);
    // Paystack confirms a matching payment but locally it was already failed —
    // money is at Paystack with nothing applied. Flag it; do not re-open a
    // dunning decision automatically.
    const detail = { reason: 'paid_after_terminal', paymentStatus: payment.status, providerPaymentId: record.providerPaymentId };
    await recordBillingWebhookAudit({ payment, action: 'gateway_webhook_needs_review', detail: { eventId: event.id, ...detail } });
    return finalize('needs_review', detail, attribution);
  }

  try {
    await applyChargeOutcome({
      tenantId: payment.tenant_id,
      paymentId: payment.id,
      success: result.verdict === 'confirmed',
      providerPaymentId: record.providerPaymentId ?? null,
      gatewayResponse: record.gatewayResponse ?? null,
    });
  } catch (error) {
    console.error(`[billing-webhook] applying event ${event.id} for ${payment.provider_reference} failed: ${error?.message ?? error}`);
    return defer(`apply_failed: ${error?.message ?? 'unknown error'}`);
  }

  return finalize('applied', { appliedStatus: result.verdict === 'confirmed' ? 'success' : 'failed', paystackStatus: record.status }, attribution);
}

/**
 * The public entry point for deciding one persisted billing event: the inline
 * webhook attempt, a Paystack redelivery and the retry sweep all call this. It
 * NEVER throws — an unexpected error is logged and the event is deferred under
 * the normal attempt cap (`deferred_exhausted` after `MAX_ATTEMPTS`), so a
 * poison event can neither 500 the webhook (API.md §7: only a failure to
 * persist is non-2xx) nor loop in the sweep forever.
 */
async function processBillingWebhookEvent({ eventId, now = new Date() }) {
  try {
    return await decideBillingWebhookEvent({ eventId, now });
  } catch (error) {
    console.error(`[billing-webhook] unexpected error deciding event ${eventId}: ${error?.message ?? error}`);
    try {
      const event = await subscriptionWebhookEvents().where({ id: eventId }).first();
      if (event && event.outcome == null) {
        await deferWebhookEvent({ events: subscriptionWebhookEvents, id: event.id, attemptCount: event.attempt_count, reason: `unexpected_error: ${error?.message ?? 'unknown'}`, now });
      }
    } catch (deferError) {
      console.error(`[billing-webhook] could not defer event ${eventId}: ${deferError?.message ?? deferError}`);
    }
    return { outcome: null, error: true };
  }
}

/** One `audit_log` row for a webhook decision that deserves a human's attention. Written before the event is finalized, so a crash retries rather than losing it. */
async function recordBillingWebhookAudit({ payment, action, detail }) {
  await scopedDb()
    .for(workerContext({ tenantId: payment.tenant_id }))
    .transaction((trx) =>
      recordAuditEntry(trx, {
        entityType: 'subscription_payments',
        entityId: payment.id,
        action,
        source: 'integration',
        afterState: detail,
        reason: 'A signed gateway webhook could not be applied as-is; see the event row outcome.',
      })
    );
}

module.exports = {
  getBillingOverview,
  listPlans,
  listInvoices,
  listPaymentsForInvoice,
  startAddPaymentMethodCheckout,
  completeAddPaymentMethod,
  resolveBillingEmail,
  ensureCurrentInvoice,
  processTenantBillingCycle,
  applyChargeOutcome,
  receiveBillingWebhook,
  processBillingWebhookEvent,
  addOneMonth,
  today,
};
