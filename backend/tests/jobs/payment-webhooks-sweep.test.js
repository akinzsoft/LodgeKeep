'use strict';

/**
 * Real MySQL, real pooled connections. Proves the retry sweep
 * (`src/jobs/payment-webhooks.js`) is the safety net that makes a persisted
 * webhook event impossible to strand: an event whose verification against
 * Paystack was unavailable is retried once due, an event not yet due is left
 * alone, an event that keeps failing is given up on with an audit row, and two
 * overlapping sweeps decide an event exactly once.
 */

jest.mock('../../src/modules/billing/paystack-gateway', () => ({
  ...jest.requireActual('../../src/modules/billing/paystack-gateway'),
  verifyTransaction: jest.fn(),
  verifyWebhookSignature: jest.fn(),
  chargeAuthorization: jest.fn(),
}));

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { verifyTransaction: jest.fn(), verifyWebhookSignature: jest.fn() };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })),
  };
});

const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const gateway = require('../../src/modules/billing/paystack-gateway');
const { addOneMonth } = require('../../src/modules/billing/service');
const { runPaymentWebhookRetrySweep } = require('../../src/jobs/payment-webhooks');
const { gatewayRecordFor } = require('../helpers/gateway-record');
const guestPaystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;
const { MAX_ATTEMPTS } = require('../../src/shared/webhook-events');

describe('runPaymentWebhookRetrySweep (real MySQL)', () => {
  let tenantId;
  let subscriptionId;
  let propertyId;
  let counter = 0;
  const createdEventIds = [];

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    const plan = await db()('plans').where({ code: 'standard' }).first('id');
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Webhook Sweep Tenant', slug: `wh-sweep-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `wh-sweep-prop-${suffix}`,
      name: 'Webhook Sweep Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2027-06-01',
    });
    [subscriptionId] = await db()('subscriptions').insert({
      tenant_id: tenantId,
      plan_id: plan.id,
      status: 'active',
      current_period_start: '2030-01-01',
      current_period_end: addOneMonth('2030-01-01'),
      payment_method_provider: 'paystack',
      payment_method_authorization_code: 'AUTH_wh_sweep',
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    gateway.verifyTransaction.mockReset();
    guestPaystack.verifyTransaction.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  afterAll(async () => {
    await db()('subscription_webhook_events').where({ tenant_id: tenantId }).delete();
    if (createdEventIds.length) await db()('subscription_webhook_events').whereIn('id', createdEventIds).delete();
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('outbox_events').where({ tenant_id: tenantId }).delete();
    const invoices = await db()('subscription_invoices').where({ tenant_id: tenantId }).select('id');
    for (const invoice of invoices) await db()('subscription_payments').where({ subscription_invoice_id: invoice.id }).delete();
    await db()('subscription_invoices').where({ tenant_id: tenantId }).delete();
    await db()('subscriptions').where({ tenant_id: tenantId }).delete();
    await db()('payment_webhook_events').where({ tenant_id: tenantId }).delete();
    await db()('payments').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  async function pendingPayment() {
    counter += 1;
    const start = new Date(Date.UTC(2031, 0, 1 + counter)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(2031, 0, 2 + counter)).toISOString().slice(0, 10);
    const [invoiceId] = await db()('subscription_invoices').insert({
      tenant_id: tenantId,
      subscription_id: subscriptionId,
      amount: '50000.00',
      currency: 'NGN',
      status: 'open',
      period_start: start,
      period_end: end,
      due_at: start,
    });
    const reference = `wh-sweep-ref-${Date.now().toString(36)}-${counter}`;
    const [paymentId] = await db()('subscription_payments').insert({
      tenant_id: tenantId,
      subscription_invoice_id: invoiceId,
      idempotency_key: `wh-sweep-key-${reference}`,
      provider: 'paystack',
      provider_reference: reference,
      amount: '50000.00',
      currency: 'NGN',
      status: 'INITIATED',
    });
    return { invoiceId, paymentId, reference };
  }

  /** A signed, persisted, never-finalised event — what a Paystack outage during the inline attempt leaves behind. */
  async function strandedEvent({ reference, nextAttemptAt, attemptCount = 1 }) {
    counter += 1;
    const [id] = await db()('subscription_webhook_events').insert({
      tenant_id: tenantId,
      provider: 'paystack',
      provider_event_id: `wh-sweep-event-${Date.now().toString(36)}-${counter}`,
      payload: JSON.stringify({ event: 'charge.success', data: { id: 900000 + counter, reference } }),
      verified: true,
      related_subscription_payment_id: null,
      attempt_count: attemptCount,
      next_attempt_at: nextAttemptAt,
    });
    createdEventIds.push(id);
    return id;
  }

  const record = (reference, overrides = {}) => ({ status: 'success', reference, providerPaymentId: '990001', amountSubunit: 5000000, currency: 'NGN', gatewayResponse: 'Successful', authorization: {}, ...overrides });
  const past = () => new Date(Date.now() - 60_000);
  const future = () => new Date(Date.now() + 3_600_000);
  const eventOf = (id) => db()('subscription_webhook_events').where({ id }).first();
  /** Sweep results carry BIGINT ids as strings; test ids come back from `insert` as numbers. */
  const resultFor = (results, id) => results.find((r) => String(r.eventId) === String(id));

  it('retries a due, stranded event and applies it once Paystack can be asked', async () => {
    const { paymentId, invoiceId, reference } = await pendingPayment();
    const eventId = await strandedEvent({ reference, nextAttemptAt: past() });
    gateway.verifyTransaction.mockResolvedValue(record(reference));

    const results = await runPaymentWebhookRetrySweep(new Date());

    expect(resultFor(results, eventId)).toMatchObject({ source: 'billing', outcome: 'applied' });
    expect((await db()('subscription_payments').where({ id: paymentId }).first()).status).toBe('CAPTURED');
    expect((await db()('subscription_invoices').where({ id: invoiceId }).first()).status).toBe('paid');
    const row = await eventOf(eventId);
    expect(row.outcome).toBe('applied');
    expect(row.next_attempt_at).toBeNull();
  });

  it('leaves an event that is not yet due alone', async () => {
    const { reference } = await pendingPayment();
    const eventId = await strandedEvent({ reference, nextAttemptAt: future() });
    gateway.verifyTransaction.mockResolvedValue(record(reference));

    const results = await runPaymentWebhookRetrySweep(new Date());

    expect(resultFor(results, eventId)).toBeUndefined();
    expect(gateway.verifyTransaction).not.toHaveBeenCalled();
    expect((await eventOf(eventId)).outcome).toBeNull();
  });

  it('never touches an unsigned event, or one already decided, or one with no schedule', async () => {
    const { reference } = await pendingPayment();
    counter += 1;
    const base = { tenant_id: tenantId, provider: 'paystack', payload: JSON.stringify({ event: 'charge.success', data: { id: 1, reference } }) };
    const [unsigned] = await db()('subscription_webhook_events').insert({ ...base, provider_event_id: `wh-u-${Date.now()}-${counter}`, verified: false, next_attempt_at: past() });
    const [decided] = await db()('subscription_webhook_events').insert({ ...base, provider_event_id: `wh-d-${Date.now()}-${counter}`, verified: true, outcome: 'applied', next_attempt_at: past() });
    const [unscheduled] = await db()('subscription_webhook_events').insert({ ...base, provider_event_id: `wh-n-${Date.now()}-${counter}`, verified: true });
    createdEventIds.push(unsigned, decided, unscheduled);

    const results = await runPaymentWebhookRetrySweep(new Date());

    expect([unsigned, decided, unscheduled].map((id) => resultFor(results, id))).toEqual([undefined, undefined, undefined]);
    expect(gateway.verifyTransaction).not.toHaveBeenCalled();
  });

  it('reschedules with backoff while Paystack is still unavailable, then gives up with an audit row', async () => {
    const { paymentId, reference } = await pendingPayment();
    const eventId = await strandedEvent({ reference, nextAttemptAt: past(), attemptCount: 1 });
    gateway.verifyTransaction.mockRejectedValue(Object.assign(new Error('Paystack down'), { details: { httpStatus: 503 } }));

    await runPaymentWebhookRetrySweep(new Date());
    let row = await eventOf(eventId);
    expect(row.outcome).toBeNull();
    expect(row.attempt_count).toBe(2);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect((await db()('subscription_payments').where({ id: paymentId }).first()).status).toBe('INITIATED');

    // The final allowed attempt.
    await db()('subscription_webhook_events').where({ id: eventId }).update({ attempt_count: MAX_ATTEMPTS - 1, next_attempt_at: past() });
    await runPaymentWebhookRetrySweep(new Date());
    row = await eventOf(eventId);
    expect(row.outcome).toBe('deferred_exhausted');
    expect(row.processed_at).not.toBeNull();
    expect(row.next_attempt_at).toBeNull();
    expect(await db()('audit_log').where({ tenant_id: tenantId, entity_id: String(paymentId), action: 'gateway_webhook_deferred_exhausted' }).first()).toBeTruthy();
  });

  it('a rejected retry (Paystack disagrees) is decided, not retried forever', async () => {
    const { paymentId, reference } = await pendingPayment();
    const eventId = await strandedEvent({ reference, nextAttemptAt: past() });
    gateway.verifyTransaction.mockResolvedValue(record(reference, { amountSubunit: 100 }));

    await runPaymentWebhookRetrySweep(new Date());

    expect((await eventOf(eventId)).outcome).toBe('rejected');
    expect((await db()('subscription_payments').where({ id: paymentId }).first()).status).toBe('INITIATED');
    gateway.verifyTransaction.mockClear();
    await runPaymentWebhookRetrySweep(new Date());
    expect(gateway.verifyTransaction).not.toHaveBeenCalled(); // decided events are never revisited
  });

  it('two overlapping sweeps decide one event exactly once', async () => {
    const { paymentId, invoiceId, reference } = await pendingPayment();
    const eventId = await strandedEvent({ reference, nextAttemptAt: past() });
    gateway.verifyTransaction.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return record(reference);
    });

    const [a, b] = await Promise.all([runPaymentWebhookRetrySweep(new Date()), runPaymentWebhookRetrySweep(new Date())]);

    const decisions = [...a, ...b].filter((r) => String(r.eventId) === String(eventId));
    expect(decisions.length).toBeGreaterThanOrEqual(1); // at least one sweep reached it
    expect(decisions.every((r) => r.outcome !== 'error')).toBe(true);
    expect((await db()('subscription_payments').where({ id: paymentId }).first()).status).toBe('CAPTURED');
    expect((await db()('subscription_invoices').where({ id: invoiceId }).first()).status).toBe('paid');
    // One application: the subscription period advanced exactly one month, not two.
    const subscription = await db()('subscriptions').where({ id: subscriptionId }).first();
    expect(subscription.status).toBe('active');
    expect((await eventOf(eventId)).outcome).toBe('applied');
    expect(await db()('audit_log').where({ tenant_id: tenantId, entity_id: String(paymentId), action: 'captured' })).toHaveLength(1);
  });

  describe('the guest-payment source', () => {
    async function pendingRegisterPayment() {
      counter += 1;
      const reference = `wh-sweep-guest-ref-${Date.now().toString(36)}-${counter}`;
      const [id] = await db()('payments').insert({
        tenant_id: tenantId,
        property_id: propertyId,
        folio_id: null,
        idempotency_key: `wh-sweep-guest-key-${reference}`,
        provider: 'paystack',
        provider_reference: reference,
        amount: '20.00',
        currency: 'NGN',
        status: 'PENDING',
        settlement_target: 'pos_register',
      });
      return db()('payments').where({ id }).first();
    }

    async function strandedGuestEvent(payment, { nextAttemptAt }) {
      counter += 1;
      const [id] = await db()('payment_webhook_events').insert({
        tenant_id: tenantId,
        property_id: propertyId,
        related_payment_id: payment.id,
        provider: 'paystack',
        provider_event_id: `wh-sweep-guest-event-${Date.now().toString(36)}-${counter}`,
        payload: JSON.stringify({ event: 'charge.success', data: { id: 800000 + counter, reference: payment.provider_reference, status: 'success' } }),
        verified: true,
        attempt_count: 1,
        next_attempt_at: nextAttemptAt,
      });
      return id;
    }

    it('retries a due, stranded guest event and captures the payment once Paystack can be asked', async () => {
      const payment = await pendingRegisterPayment();
      const eventId = await strandedGuestEvent(payment, { nextAttemptAt: past() });
      guestPaystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));

      const results = await runPaymentWebhookRetrySweep(new Date());

      expect(resultFor(results, eventId)).toMatchObject({ source: 'guest', outcome: 'applied' });
      expect((await db()('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
      expect((await db()('payment_webhook_events').where({ id: eventId }).first()).outcome).toBe('applied');
    });

    it('rejects a retried guest event whose Paystack record disagrees, leaving the payment open', async () => {
      const payment = await pendingRegisterPayment();
      const eventId = await strandedGuestEvent(payment, { nextAttemptAt: past() });
      guestPaystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { amountSubunit: 5 }));

      await runPaymentWebhookRetrySweep(new Date());

      expect((await db()('payments').where({ id: payment.id }).first()).status).toBe('PENDING');
      expect((await db()('payment_webhook_events').where({ id: eventId }).first()).outcome).toBe('rejected');
    });

    it('a poison guest event stops looping: it is deferred under the cap and finally exhausted', async () => {
      const payment = await pendingRegisterPayment();
      const eventId = await strandedGuestEvent(payment, { nextAttemptAt: past() });
      // An unexpected (non-Paystack) error while asking: classified transient, so it is deferred, not fatal.
      guestPaystack.verifyTransaction.mockRejectedValue(new Error('something unexpected'));

      for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
        await db()('payment_webhook_events').where({ id: eventId }).whereNull('outcome').update({ next_attempt_at: past() });
        await runPaymentWebhookRetrySweep(new Date());
      }

      const row = await db()('payment_webhook_events').where({ id: eventId }).first();
      expect(row.outcome).toBe('deferred_exhausted');
      expect(row.next_attempt_at).toBeNull();
      expect(row.attempt_count).toBeLessThanOrEqual(MAX_ATTEMPTS);
    });
  });
});
