'use strict';

/**
 * Isolation pin for the supermarket online-sale work: the "paid after it was
 * cancelled" handling (record the capture, flag it for a refund) belongs to the
 * Register and supermarket checkouts ONLY. A cancelled guest QR-order payment
 * or a cancelled folio payment that Paystack later reports as paid is still
 * treated exactly as before: the local payment stays cancelled and the webhook
 * is flagged for review (money at Paystack, ledger untouched).
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { initializeTransaction: jest.fn(), verifyTransaction: jest.fn(), refundTransaction: jest.fn(), verifyWebhookSignature: jest.fn(), createSubaccount: jest.fn(), resolveBankAccount: jest.fn() };
  return { ...actual, __mockAdapter: mockAdapter, resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })) };
});

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { gatewayRecordFor } = require('../helpers/gateway-record');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const cashieringService = require('../../src/modules/cashiering/service');

describe('late capture of a cancelled hotel payment', () => {
  const t = useTestApp();
  let ctx;
  let counter = 0;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => console.error.mockRestore());

  async function cancelledPayment(target) {
    counter += 1;
    const fields = { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, idempotency_key: `late-iso-${Date.now()}-${counter}`, provider: 'paystack', provider_reference: `late-iso-ref-${Date.now()}-${counter}`, amount: '50.00', currency: 'NGN', status: 'CANCELLED', settlement_target: target };
    if (target === 'folio') fields.folio_id = ctx.a.folios[0].id;
    else fields.pos_order_id = ctx.a.posOrders[0].id;
    const [id] = await t.trx('payments').insert(fields);
    return t.trx('payments').where({ id }).first();
  }

  async function lateWebhook(payment) {
    paystack.verifyWebhookSignature.mockReturnValue(true);
    paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
    const body = { event: 'charge.success', data: { id: 900000 + counter, reference: payment.provider_reference, status: 'success' } };
    await cashieringService.handlePaystackWebhook({ rawBody: JSON.stringify(body), signatureHeader: 'mocked', parsedBody: body });
    return t.trx('payment_webhook_events').where({ provider_event_id: String(900000 + counter) }).first();
  }

  it.each(['pos_order', 'folio'])('a cancelled %s payment stays cancelled and is only flagged', async (target) => {
    const payment = await cancelledPayment(target);
    const event = await lateWebhook(payment);
    expect(event.outcome).toBe('needs_review');
    const after = await t.trx('payments').where({ id: payment.id }).first();
    expect(after.status).toBe('CANCELLED');
    expect(after.captured_at).toBeNull();
    expect(after.failure_reason).toBeNull();
  });
});
