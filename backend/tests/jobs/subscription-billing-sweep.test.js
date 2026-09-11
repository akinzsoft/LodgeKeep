'use strict';

/**
 * Real pooled connections, not the shared-transaction-per-file harness —
 * the same distinction every other atomicity/concurrency suite in this
 * codebase already draws (tests/reservations/concurrency.test.js,
 * tests/platform/atomicity.test.js, tests/jobs/trial-expiry-sweep.test.js).
 * Proves `processTenantBillingCycle`/`applyChargeOutcome` (PLAN.md
 * Phase 5) — successful renewal, trial conversion, failed-charge dunning,
 * dunning exhaustion suspending the tenant, and — per the user's own
 * explicit "mutation-tested atomicity proof on anything transactional"
 * instruction — that two genuinely concurrent sweep ticks against the SAME
 * due subscription produce exactly ONE real gateway charge, never two.
 */

jest.mock('../../src/modules/billing/paystack-gateway', () => ({
  chargeAuthorization: jest.fn(),
}));

const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const gateway = require('../../src/modules/billing/paystack-gateway');
const { processTenantBillingCycle, addOneMonth } = require('../../src/modules/billing/service');

describe('processTenantBillingCycle (PLAN.md Phase 5, real MySQL)', () => {
  const tenantIds = [];
  let planId;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    const plan = await db()('plans').where({ code: 'standard' }).first('id');
    planId = plan.id;
  });

  afterEach(async () => {
    jest.clearAllMocks();
    while (tenantIds.length) {
      const id = tenantIds.pop();
      const subscription = await db()('subscriptions').where({ tenant_id: id }).first('id');
      if (subscription) {
        const invoices = await db()('subscription_invoices').where({ tenant_id: id }).select('id');
        for (const invoice of invoices) {
          await db()('subscription_payments').where({ subscription_invoice_id: invoice.id }).delete();
        }
        await db()('subscription_invoices').where({ tenant_id: id }).delete();
        await db()('subscriptions').where({ tenant_id: id }).delete();
      }
      await db()('outbox_events').where({ tenant_id: id }).delete();
      await db()('audit_log').where({ tenant_id: id }).delete();
      await db()('users').where({ tenant_id: id }).delete();
      await db()('properties').where({ tenant_id: id }).delete();
      await db()('tenants').where({ id }).delete();
    }
  });

  afterAll(() => {
    dbModule.__resetForTesting();
  });

  async function makeTenantWithSubscription({ tenantStatus = 'active', subscriptionStatus = 'active', currentPeriodStart, consecutiveFailedAttempts = 0, withBillingContact = false } = {}) {
    const slug = `billing-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [tenantId] = await db()('tenants').insert({
      name: 'Billing Sweep Test Hotels',
      slug,
      status: tenantStatus,
      trial_ends_at: tenantStatus === 'trial' ? currentPeriodStart : null,
    });
    tenantIds.push(tenantId);

    const [subscriptionId] = await db()('subscriptions').insert({
      tenant_id: tenantId,
      plan_id: planId,
      status: subscriptionStatus,
      current_period_start: currentPeriodStart,
      current_period_end: addOneMonth(currentPeriodStart),
      payment_method_provider: 'paystack',
      payment_method_authorization_code: 'AUTH_sweep_test',
      consecutive_failed_attempts: consecutiveFailedAttempts,
    });

    // `applyChargeOutcome`'s own notification path resolves the tenant's
    // first active user (the "email of record") and first property (to
    // route through the existing PROPERTY_SCOPED template/delivery
    // infrastructure) — only seeded here for the tests that actually
    // assert on a real `outbox_events` row; every other test in this file
    // deliberately has neither, proving the notification code path
    // degrades to a silent no-op rather than erroring when there's no one
    // to notify.
    if (withBillingContact) {
      await db()('properties').insert({ tenant_id: tenantId, slug: `${slug}-prop`, name: 'Sweep Test Property', timezone: 'Africa/Lagos', base_currency: 'NGN' });
      await db()('users').insert({ tenant_id: tenantId, email: `billing-contact-${slug}@example.test`, password_hash: 'x', first_name: 'Billing', last_name: 'Contact' });
    }

    return { tenantId, subscriptionId };
  }

  it('a successful charge creates the invoice, marks it paid, advances the period, and resets the failure counter', async () => {
    const { tenantId, subscriptionId } = await makeTenantWithSubscription({ currentPeriodStart: '2027-01-01' });
    gateway.chargeAuthorization.mockResolvedValue({ status: 'success', providerPaymentId: 'PSK_1', gatewayResponse: 'Successful' });

    const outcome = await processTenantBillingCycle({ tenantId, now: new Date('2027-01-01T00:00:00Z') });

    expect(outcome.action).toBe('captured');
    const invoice = await db()('subscription_invoices').where({ subscription_id: subscriptionId }).first();
    expect(invoice.status).toBe('paid');
    expect(invoice.period_start).toBe('2027-01-01');
    const subscription = await db()('subscriptions').where({ id: subscriptionId }).first();
    expect(subscription.status).toBe('active');
    expect(subscription.current_period_start).toBe('2027-02-01'); // advanced past the just-paid period
    expect(subscription.consecutive_failed_attempts).toBe(0);
    expect(gateway.chargeAuthorization).toHaveBeenCalledTimes(1);
  });

  it('the first successful charge against a still-trial tenant converts it to active and sets its plan_id', async () => {
    const { tenantId } = await makeTenantWithSubscription({ tenantStatus: 'trial', currentPeriodStart: '2027-01-01' });
    gateway.chargeAuthorization.mockResolvedValue({ status: 'success', providerPaymentId: 'PSK_2', gatewayResponse: 'Successful' });

    await processTenantBillingCycle({ tenantId, now: new Date('2027-01-01T00:00:00Z') });

    const tenant = await db()('tenants').where({ id: tenantId }).first();
    expect(tenant.status).toBe('active');
    expect(String(tenant.plan_id)).toBe(String(planId));
    const conversionEntry = await db()('audit_log').where({ tenant_id: tenantId, action: 'trial_converted' }).first();
    expect(conversionEntry).toBeTruthy();
  });

  it('a failed charge bumps the invoice attempt_count and the subscription into past_due, without exhausting the schedule on the first failure', async () => {
    const { tenantId, subscriptionId } = await makeTenantWithSubscription({ currentPeriodStart: '2027-02-01' });
    gateway.chargeAuthorization.mockResolvedValue({ status: 'failed', gatewayResponse: 'Insufficient funds' });

    const outcome = await processTenantBillingCycle({ tenantId, now: new Date('2027-02-01T00:00:00Z') });

    expect(outcome.action).toBe('failed_will_retry');
    const invoice = await db()('subscription_invoices').where({ subscription_id: subscriptionId }).first();
    expect(invoice.status).toBe('open');
    expect(invoice.attempt_count).toBe(1);
    const subscription = await db()('subscriptions').where({ id: subscriptionId }).first();
    expect(subscription.status).toBe('past_due');
    expect(subscription.consecutive_failed_attempts).toBe(1);
    const tenant = await db()('tenants').where({ id: tenantId }).first();
    expect(tenant.status).toBe('active'); // dunning in progress — grace period, no suspension yet
  });

  it('a due retry is skipped when not enough days have passed since the last attempt (day 0/3/7/10/14 cadence)', async () => {
    const { tenantId, subscriptionId } = await makeTenantWithSubscription({ currentPeriodStart: '2027-03-01' });
    gateway.chargeAuthorization.mockResolvedValue({ status: 'failed', gatewayResponse: 'Insufficient funds' });

    // Day 0: first attempt, fails.
    await processTenantBillingCycle({ tenantId, now: new Date('2027-03-01T00:00:00Z') });
    expect(gateway.chargeAuthorization).toHaveBeenCalledTimes(1);

    // Day 1: not yet due for the second attempt (day 3).
    const skipped = await processTenantBillingCycle({ tenantId, now: new Date('2027-03-02T00:00:00Z') });
    expect(skipped.action).toBe('skip');
    expect(gateway.chargeAuthorization).toHaveBeenCalledTimes(1); // still just the one attempt

    // Day 3: the retry is now due.
    const retried = await processTenantBillingCycle({ tenantId, now: new Date('2027-03-04T00:00:00Z') });
    expect(retried.action).toBe('failed_will_retry');
    expect(gateway.chargeAuthorization).toHaveBeenCalledTimes(2);

    const invoice = await db()('subscription_invoices').where({ subscription_id: subscriptionId }).first();
    expect(invoice.attempt_count).toBe(2);
  });

  it('every failed retry (before exhaustion) writes an escalating tenant-facing notification via the outbox pattern', async () => {
    const { tenantId, subscriptionId } = await makeTenantWithSubscription({ currentPeriodStart: '2027-05-01', withBillingContact: true });
    gateway.chargeAuthorization.mockResolvedValue({ status: 'failed', gatewayResponse: 'Insufficient funds' });

    await processTenantBillingCycle({ tenantId, now: new Date('2027-05-01T00:00:00Z') }); // day 0, 1st failure
    const firstNotice = await db()('outbox_events').where({ tenant_id: tenantId, event_type: 'billing.payment_failed' }).first();
    expect(firstNotice).toBeTruthy();
    const firstPayload = firstNotice.payload;
    expect(firstPayload.urgencyLabel).toBe('Payment failed');
    expect(firstPayload.nextRetryDate).toBe('2027-05-04'); // day 3
    expect(firstPayload.recipientEmail).toContain('billing-contact-');

    await processTenantBillingCycle({ tenantId, now: new Date('2027-05-04T00:00:00Z') }); // day 3, 2nd failure
    await processTenantBillingCycle({ tenantId, now: new Date('2027-05-08T00:00:00Z') }); // day 7, 3rd failure
    const finalWarning = await processTenantBillingCycle({ tenantId, now: new Date('2027-05-11T00:00:00Z') }); // day 10, 4th failure
    expect(finalWarning.action).toBe('failed_will_retry');

    const notices = await db()('outbox_events').where({ tenant_id: tenantId, event_type: 'billing.payment_failed' }).orderBy('id');
    expect(notices).toHaveLength(4);
    const labels = notices.map((row) => row.payload.urgencyLabel);
    expect(labels).toEqual(['Payment failed', 'Second attempt failed', 'Third attempt failed', 'Final warning']);
    expect(notices[3].payload.nextRetryDate).toBe('2027-05-15'); // day 14 — the final warning still names the last scheduled retry

    const invoice = await db()('subscription_invoices').where({ subscription_id: subscriptionId }).first();
    expect(invoice.attempt_count).toBe(4);
    const tenant = await db()('tenants').where({ id: tenantId }).first();
    expect(tenant.status).toBe('active'); // still no suspension — the schedule isn't exhausted yet
  });

  it('a tenant with no active user or property yet degrades to a silent no-op for the notification, without failing the billing cycle itself', async () => {
    const { tenantId } = await makeTenantWithSubscription({ currentPeriodStart: '2027-05-20' }); // withBillingContact: false — deliberately no one to notify
    gateway.chargeAuthorization.mockResolvedValue({ status: 'failed', gatewayResponse: 'Insufficient funds' });

    const outcome = await processTenantBillingCycle({ tenantId, now: new Date('2027-05-20T00:00:00Z') });

    expect(outcome.action).toBe('failed_will_retry'); // the real, financial part of the cycle still succeeded
    expect(await db()('outbox_events').where({ tenant_id: tenantId })).toHaveLength(0);
  });

  it('dunning exhaustion (the 5th failure, at day 14) marks the invoice uncollectible, suspends the tenant (read-only, never a hard lockout), and sends the final suspension notice instead of a further retry email', async () => {
    const { tenantId, subscriptionId } = await makeTenantWithSubscription({ currentPeriodStart: '2027-04-01', withBillingContact: true });
    gateway.chargeAuthorization.mockResolvedValue({ status: 'failed', gatewayResponse: 'Insufficient funds' });

    await processTenantBillingCycle({ tenantId, now: new Date('2027-04-01T00:00:00Z') }); // day 0
    await processTenantBillingCycle({ tenantId, now: new Date('2027-04-04T00:00:00Z') }); // day 3
    await processTenantBillingCycle({ tenantId, now: new Date('2027-04-08T00:00:00Z') }); // day 7
    await processTenantBillingCycle({ tenantId, now: new Date('2027-04-11T00:00:00Z') }); // day 10 — the "final warning"
    const exhausted = await processTenantBillingCycle({ tenantId, now: new Date('2027-04-15T00:00:00Z') }); // day 14

    expect(exhausted.action).toBe('exhausted_suspended');
    const invoice = await db()('subscription_invoices').where({ subscription_id: subscriptionId }).first();
    expect(invoice.status).toBe('uncollectible');
    expect(invoice.attempt_count).toBe(5);
    const tenant = await db()('tenants').where({ id: tenantId }).first();
    // Automatic, no human approval gate, per the user's own explicit
    // instruction — and degrades to the EXISTING read-only pattern, never
    // a hard lockout: `suspended` is fully reachable at login and every
    // read still succeeds (tests/auth/tenant-lifecycle.test.js's own
    // suite proves the read/write split itself; this test only proves
    // the STATUS transition actually fires here).
    expect(tenant.status).toBe('suspended');
    const suspendEntry = await db()('audit_log').where({ tenant_id: tenantId, action: 'billing_suspended' }).first();
    expect(suspendEntry).toBeTruthy();
    expect(gateway.chargeAuthorization).toHaveBeenCalledTimes(5);

    // Four escalating retry emails, then ONE distinct final suspension
    // notice — never a 5th "we'll retry" email once there is no retry left.
    const retryNotices = await db()('outbox_events').where({ tenant_id: tenantId, event_type: 'billing.payment_failed' });
    expect(retryNotices).toHaveLength(4);
    const suspendNotice = await db()('outbox_events').where({ tenant_id: tenantId, event_type: 'billing.subscription_suspended' }).first();
    expect(suspendNotice).toBeTruthy();
    expect(suspendNotice.payload.attemptCount).toBe(5);
  });

  it('mutation test: two genuinely concurrent sweep ticks against the SAME due subscription produce exactly one real charge attempt, never two', async () => {
    const { tenantId, subscriptionId } = await makeTenantWithSubscription({ currentPeriodStart: '2027-06-01' });
    gateway.chargeAuthorization.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ status: 'success', providerPaymentId: 'PSK_race', gatewayResponse: 'Successful' }), 50))
    );

    // Two overlapping ticks (not two tenants) racing the same due
    // subscription — the scenario a real deploy with more than one worker
    // process, or a slow tick overlapping the next scheduled one, produces.
    // `processTenantBillingCycle`'s own step 1 (`SELECT ... FOR UPDATE`)
    // is what serializes this: the second call's lock wait means it sees
    // the invoice/subscription state the FIRST call already committed by
    // the time it acquires the lock, so it never inserts a second
    // `subscription_payments` intent row for the same period.
    await Promise.all([
      processTenantBillingCycle({ tenantId, now: new Date('2027-06-01T00:00:00Z') }),
      processTenantBillingCycle({ tenantId, now: new Date('2027-06-01T00:00:00Z') }),
    ]);

    expect(gateway.chargeAuthorization).toHaveBeenCalledTimes(1);
    const invoices = await db()('subscription_invoices').where({ subscription_id: subscriptionId });
    expect(invoices).toHaveLength(1);
    const payments = await db()('subscription_payments').where({ subscription_invoice_id: invoices[0].id });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('CAPTURED');
  });

  it('a webhook re-delivering an already-applied outcome is a genuine no-op — the period is never advanced twice', async () => {
    const { applyChargeOutcome } = require('../../src/modules/billing/service');
    const { tenantId, subscriptionId } = await makeTenantWithSubscription({ currentPeriodStart: '2027-07-01' });
    gateway.chargeAuthorization.mockResolvedValue({ status: 'success', providerPaymentId: 'PSK_webhook', gatewayResponse: 'Successful' });

    await processTenantBillingCycle({ tenantId, now: new Date('2027-07-01T00:00:00Z') });
    const subscriptionAfterFirst = await db()('subscriptions').where({ id: subscriptionId }).first();
    expect(subscriptionAfterFirst.current_period_start).toBe('2027-08-01');

    // subscription_payments rows carry no direct subscription_id column
    // (they FK to subscription_invoices) — resolve via the invoice.
    const invoice = await db()('subscription_invoices').where({ subscription_id: subscriptionId }).first();
    const [paymentRow] = await db()('subscription_payments').where({ subscription_invoice_id: invoice.id }).select('id');

    // The exact same outcome, redelivered — the webhook's own real shape.
    const replay = await applyChargeOutcome({ tenantId, paymentId: paymentRow.id, success: true, providerPaymentId: 'PSK_webhook', gatewayResponse: 'Successful' });
    expect(replay.action).toBe('already_applied');

    const subscriptionAfterReplay = await db()('subscriptions').where({ id: subscriptionId }).first();
    expect(subscriptionAfterReplay.current_period_start).toBe('2027-08-01'); // unchanged — not advanced a second time
  });
});
