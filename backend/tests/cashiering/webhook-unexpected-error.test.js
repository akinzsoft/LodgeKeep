'use strict';

/**
 * A persisted webhook event whose decision throws UNEXPECTEDLY (here: the
 * record classifier itself blows up) must neither 500 the webhook — API.md §7:
 * only a failure to persist is non-2xx — nor loop in the retry sweep forever.
 * It is deferred under the normal attempt cap and ends `deferred_exhausted`.
 * Covers both webhook routes.
 */

jest.mock('../../src/shared/gateway-record', () => ({
  ...jest.requireActual('../../src/shared/gateway-record'),
  classifyGatewayRecord: jest.fn(() => {
    throw new Error('classifier exploded');
  }),
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

jest.mock('../../src/modules/billing/paystack-gateway', () => ({
  ...jest.requireActual('../../src/modules/billing/paystack-gateway'),
  verifyTransaction: jest.fn(),
  verifyWebhookSignature: jest.fn(),
  chargeAuthorization: jest.fn(),
}));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { gatewayRecordFor } = require('../helpers/gateway-record');
const { MAX_ATTEMPTS } = require('../../src/shared/webhook-events');
const cashieringService = require('../../src/modules/cashiering/service');
const billingService = require('../../src/modules/billing/service');
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;
const billingGateway = require('../../src/modules/billing/paystack-gateway');

describe('an unexpected error deciding a persisted webhook event', () => {
  const t = useTestApp();
  let ctx;
  let counter = 0;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it('guest route: answers 200, defers, and gives up at the attempt cap instead of looping', async () => {
    counter += 1;
    const payment = await t.trx('payments').where({ tenant_id: ctx.a.id, provider: 'paystack' }).first();
    // Use a fresh, open Register-style payment row for tenant a.
    const [paymentId] = await t.trx('payments').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      folio_id: payment?.folio_id ?? null,
      idempotency_key: `unexpected-${counter}`,
      provider: 'paystack',
      provider_reference: `unexpected-ref-${counter}`,
      amount: '20.00',
      currency: 'NGN',
      status: 'PENDING',
      settlement_target: 'pos_register',
    });
    const stored = await t.trx('payments').where({ id: paymentId }).first();
    paystack.verifyWebhookSignature.mockReturnValue(true);
    paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(stored));

    const eventId = 660000 + counter;
    const res = await t.request
      .post('/api/v1/webhooks/paystack')
      .set('x-paystack-signature', 'mocked')
      .send({ event: 'charge.success', data: { id: eventId, reference: stored.provider_reference, status: 'success' } });
    expect(res.status).toBe(200); // not a 500

    let row = await t.trx('payment_webhook_events').where({ provider_event_id: String(eventId) }).first();
    expect(row.outcome).toBeNull();
    expect(row.attempt_count).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();
    expect((await t.trx('payments').where({ id: paymentId }).first()).status).toBe('PENDING');

    // Every further attempt is counted; the last one gives up.
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await cashieringService.processPaymentWebhookEvent({ eventId: row.id });
      expect(result.outcome === null || result.outcome === 'deferred_exhausted').toBe(true);
    }
    row = await t.trx('payment_webhook_events').where({ id: row.id }).first();
    expect(row.outcome).toBe('deferred_exhausted');
    expect(row.attempt_count).toBeLessThanOrEqual(MAX_ATTEMPTS);
    expect(row.next_attempt_at).toBeNull(); // never picked up again
    expect((await t.trx('payments').where({ id: paymentId }).first()).status).toBe('PENDING');
  });

  it('billing route: answers 200, defers, and gives up at the attempt cap instead of looping', async () => {
    counter += 1;
    const subscriptionId = ctx.a.subscriptions[0].id;
    const day = (n) => new Date(Date.UTC(2032, 0, 1 + n)).toISOString().slice(0, 10);
    const [invoiceId] = await t.trx('subscription_invoices').insert({
      tenant_id: ctx.a.id,
      subscription_id: subscriptionId,
      amount: '50000.00',
      currency: 'NGN',
      status: 'open',
      period_start: day(counter),
      period_end: day(counter + 1),
      due_at: day(counter),
    });
    const reference = `unexpected-billing-ref-${counter}`;
    const [paymentId] = await t.trx('subscription_payments').insert({
      tenant_id: ctx.a.id,
      subscription_invoice_id: invoiceId,
      idempotency_key: `unexpected-billing-${counter}`,
      provider: 'paystack',
      provider_reference: reference,
      amount: '50000.00',
      currency: 'NGN',
      status: 'INITIATED',
    });
    billingGateway.verifyWebhookSignature.mockReturnValue(true);
    billingGateway.verifyTransaction.mockResolvedValue({ status: 'success', reference, providerPaymentId: '1', amountSubunit: 5000000, currency: 'NGN', authorization: {} });

    const eventId = 670000 + counter;
    const res = await t.request
      .post('/api/v1/webhooks/billing-paystack')
      .set('x-paystack-signature', 'mocked')
      .send({ event: 'charge.success', data: { id: eventId, reference } });
    expect(res.status).toBe(200);

    let row = await t.trx('subscription_webhook_events').where({ provider_event_id: String(eventId) }).first();
    expect(row.outcome).toBeNull();
    expect(row.attempt_count).toBe(1);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await billingService.processBillingWebhookEvent({ eventId: row.id });
    }
    row = await t.trx('subscription_webhook_events').where({ id: row.id }).first();
    expect(row.outcome).toBe('deferred_exhausted');
    expect(row.next_attempt_at).toBeNull();
    expect((await t.trx('subscription_payments').where({ id: paymentId }).first()).status).toBe('INITIATED');
  });
});
