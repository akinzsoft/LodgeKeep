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
const { NoActivePlanError, CardVerificationFailedError, InvoiceNotFoundError } = require('./errors');
const gateway = require('./paystack-gateway');

const CARD_VERIFICATION_AMOUNT = process.env.BILLING_CARD_VERIFICATION_AMOUNT || '50.00';

/** A staff-scoped read of the tenant's own row — `tenants` is TENANT_SCOPED with scopeRoot 'tenant', so this always resolves to exactly the caller's own tenant. */
async function getOwnTenant({ context }) {
  return scopedDb().for(context).table('tenants').first();
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
 */
async function startAddPaymentMethodCheckout({ context, email, callbackUrl }) {
  const tenant = await getOwnTenant({ context });
  const reference = `billing-card-${generateUlid()}`;
  const { authorizationUrl, accessCode } = await gateway.initializeTransaction({
    email,
    amount: CARD_VERIFICATION_AMOUNT,
    currency: tenant.base_currency,
    reference,
    callbackUrl,
  });
  return { authorizationUrl, accessCode, reference };
}

/**
 * Verifies the checkout above, captures the reusable authorization, and
 * upserts the tenant's ONE `subscriptions` row (see that table's own
 * migration header — one row per tenant, no history). Naturally idempotent
 * on repeat calls with the same `reference` — Paystack's own `/verify`
 * endpoint is itself idempotent, and re-applying the identical
 * authorization data to the same row changes nothing on a second call — so
 * this deliberately carries no Idempotency-Key requirement, the same
 * "verification is naturally safe to repeat" reasoning
 * `cashiering/controller.js`'s own `verifyPayment` already established.
 */
async function completeAddPaymentMethod({ context, reference, requestId, ip, userAgent }) {
  const verification = await gateway.verifyTransaction({ reference });
  if (verification.status !== 'success' || !verification.authorization.authorizationCode) {
    throw new CardVerificationFailedError(verification.status);
  }

  // The verification charge itself was never a real subscription payment —
  // reverse it now that the authorization is safely captured. Best-effort:
  // a refund failure must not lose the captured card, so it is logged, not
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
  const providerEventId = payload?.data?.id ? String(payload.data.id) : (payload?.data?.reference ?? generateUlid());

  const db = scopedDb().for(systemContext());
  let inserted;
  try {
    const [id] = await db.platform().table('subscription_webhook_events').insert({
      provider: 'paystack',
      provider_event_id: providerEventId,
      payload: JSON.stringify(payload ?? {}),
      verified,
    });
    inserted = id;
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return { deduplicated: true }; // already recorded — API.md §7's "answer 200 on persistence" still applies at the controller
    throw error;
  }

  if (!verified) return { verified: false };

  const eventType = payload?.event;
  const reference = payload?.data?.reference;
  if ((eventType === 'charge.success' || eventType === 'charge.failed') && reference) {
    const payment = await db.platform().table('subscription_payments').where({ provider: 'paystack', provider_reference: reference }).first();
    if (payment) {
      await applyChargeOutcome({
        tenantId: payment.tenant_id,
        paymentId: payment.id,
        success: eventType === 'charge.success',
        providerPaymentId: payload.data.id ? String(payload.data.id) : null,
        gatewayResponse: payload.data.gateway_response ?? null,
      });
      await db.platform().table('subscription_webhook_events').where({ id: inserted }).update({ tenant_id: payment.tenant_id, processed_at: new Date(), related_subscription_payment_id: payment.id });
    }
  }

  return { verified: true };
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
  addOneMonth,
  today,
};
