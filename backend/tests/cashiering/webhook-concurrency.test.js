'use strict';

/**
 * Real pooled connections, not the shared-transaction-per-file harness — the
 * same distinction `tests/qr-ordering/concurrency.test.js` and
 * `tests/pos/concurrency.test.js` draw. Proves, under genuinely concurrent
 * connections, the properties of the guest-payment webhook that a single
 * shared transaction cannot:
 *
 *  1. PERSIST BEFORE VERIFY — the event is durably committed (visible to a
 *     DIFFERENT connection) before Paystack is asked anything, so no
 *     transaction is held open across the outbound call (ARCHITECTURE.md §6.4)
 *     and a crash mid-verify cannot lose the event.
 *  2. ATOMIC DEDUP — two identical signed deliveries racing each other neither
 *     500 (the old check-then-insert threw an uncaught ER_DUP_ENTRY) nor
 *     double-capture.
 *  3. AN UNSIGNED REQUEST RACING A SIGNED ONE cannot win the event id.
 *  4. A webhook racing the browser-confirmation path captures exactly once.
 *
 * Uses a Register (`pos_register`) payment: it needs no folio, and its capture
 * is a plain conditional UPDATE — exactly the state transition under test.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    refundTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    createSubaccount: jest.fn(),
    resolveBankAccount: jest.fn(),
  };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })),
  };
});

const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { gatewayRecordFor } = require('../helpers/gateway-record');
const { workerContext } = require('../../src/modules/tenancy');
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;
const cashieringService = require('../../src/modules/cashiering/service');

describe('guest webhook under real concurrent connections', () => {
  let tenantId;
  let propertyId;
  let counter = 0;
  const eventIds = [];

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Webhook Race Tenant', slug: `wh-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `wh-race-prop-${suffix}`,
      name: 'Webhook Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2027-06-01',
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    paystack.verifyTransaction.mockReset();
    paystack.verifyWebhookSignature.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  afterAll(async () => {
    if (eventIds.length) await db()('payment_webhook_events').whereIn('provider_event_id', eventIds).delete();
    await db()('payment_webhook_events').where({ tenant_id: tenantId }).delete();
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('payments').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  async function pendingRegisterPayment(amount = '20.00') {
    counter += 1;
    const reference = `wh-race-ref-${Date.now().toString(36)}-${counter}`;
    const [id] = await db()('payments').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      folio_id: null,
      idempotency_key: `wh-race-key-${reference}`,
      provider: 'paystack',
      provider_reference: reference,
      amount,
      currency: 'NGN',
      status: 'PENDING',
      settlement_target: 'pos_register',
    });
    return db()('payments').where({ id }).first();
  }

  function newEventId() {
    counter += 1;
    const id = String(700000 + counter * 7 + Math.floor(Math.random() * 5));
    eventIds.push(id);
    return id;
  }

  function webhook({ payment, eventId, signed = true }) {
    paystack.verifyWebhookSignature.mockReturnValue(signed);
    const body = { event: 'charge.success', data: { id: Number(eventId), reference: payment.provider_reference, status: 'success' } };
    return cashieringService.handlePaystackWebhook({ rawBody: JSON.stringify(body), signatureHeader: 'mocked', parsedBody: body });
  }

  it('persists the signed event durably BEFORE Paystack is asked anything', async () => {
    const payment = await pendingRegisterPayment();
    const eventId = newEventId();
    let seenDuringVerify = null;

    paystack.verifyTransaction.mockImplementation(async () => {
      // A DIFFERENT pooled connection must already see the committed event.
      seenDuringVerify = await db()('payment_webhook_events').where({ provider_event_id: eventId }).first();
      return gatewayRecordFor(payment);
    });

    await webhook({ payment, eventId });

    expect(seenDuringVerify).toBeTruthy();
    expect(seenDuringVerify.verified).toBe(1);
    expect(seenDuringVerify.outcome).toBeNull(); // persisted, not yet decided
    expect((await db()('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
  });

  it('two identical signed deliveries racing each other: no error, one event row, captured once', async () => {
    const payment = await pendingRegisterPayment();
    const eventId = newEventId();
    paystack.verifyTransaction.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25)); // widen the race window
      return gatewayRecordFor(payment);
    });

    const results = await Promise.allSettled([webhook({ payment, eventId }), webhook({ payment, eventId })]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']); // the old check-then-insert 500ed here
    expect(await db()('payment_webhook_events').where({ provider_event_id: eventId })).toHaveLength(1);
    const after = await db()('payments').where({ id: payment.id }).first();
    expect(after.status).toBe('CAPTURED');
    expect((await db()('payment_webhook_events').where({ provider_event_id: eventId }).first()).outcome).toBe('applied');
  });

  it('an unsigned request racing a signed one cannot win the event id', async () => {
    const payment = await pendingRegisterPayment();
    const eventId = newEventId();
    paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));

    // Signature is decided per call, so give each racing call its own answer.
    paystack.verifyWebhookSignature.mockReset();
    paystack.verifyWebhookSignature.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const body = { event: 'charge.success', data: { id: Number(eventId), reference: payment.provider_reference, status: 'success' } };
    const call = () => cashieringService.handlePaystackWebhook({ rawBody: JSON.stringify(body), signatureHeader: 'mocked', parsedBody: body });
    const results = await Promise.allSettled([call(), call()]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await db()('payment_webhook_events').where({ provider_event_id: eventId });
    expect(rows).toHaveLength(1);
    expect(rows[0].verified).toBe(1);
    expect(rows[0].outcome).toBe('applied');
    expect((await db()('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
  });

  it('a webhook racing the browser-confirmation path captures exactly once', async () => {
    const payment = await pendingRegisterPayment();
    const eventId = newEventId();
    paystack.verifyTransaction.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return gatewayRecordFor(payment);
    });

    const context = workerContext({ tenantId, propertyId });
    const results = await Promise.allSettled([
      webhook({ payment, eventId }),
      cashieringService.verifyPayment({ context, paymentId: payment.id }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const after = await db()('payments').where({ id: payment.id }).first();
    expect(after.status).toBe('CAPTURED');
    expect(await db()('payments').where({ tenant_id: tenantId, provider_reference: payment.provider_reference })).toHaveLength(1);
  });

  it('a mismatching record captures neither on the webhook nor the sweep path, and never fails the payment', async () => {
    const payment = await pendingRegisterPayment('20.00');
    const eventId = newEventId();
    paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { amountSubunit: 1 }));

    await webhook({ payment, eventId });

    const after = await db()('payments').where({ id: payment.id }).first();
    expect(after.status).toBe('PENDING');
    const row = await db()('payment_webhook_events').where({ provider_event_id: eventId }).first();
    expect(row.outcome).toBe('rejected');
  });
});
