'use strict';

/**
 * ONE Paystack webhook URL serves both integrations. These tests use REAL
 * HMAC-SHA512 signatures over the raw body (nothing about signing is mocked):
 * the guest key lives encrypted in `platform_payment_integrations`, the billing
 * key in `BILLING_PAYSTACK_SECRET_KEY`. Only Paystack's own record
 * (`verifyTransaction`, a network call) is mocked, in both modules.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const { decrypt } = require('../../src/shared/encryption');
  const verifyTransaction = jest.fn();
  return {
    ...actual,
    __verifyTransaction: verifyTransaction,
    resolveAdapterForCurrency: async (db, currency) => {
      const integration = await db.table('platform_payment_integrations').where({ currency, is_active: true }).first();
      if (!integration) throw new actual.GatewayNotConfiguredError('paystack');
      return { integration, adapter: { ...actual.buildAdapter(decrypt(integration.secret_key_encrypted)), verifyTransaction } };
    },
  };
});

jest.mock('../../src/modules/billing/paystack-gateway', () => ({
  ...jest.requireActual('../../src/modules/billing/paystack-gateway'),
  verifyTransaction: jest.fn(),
}));

const crypto = require('crypto');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { gatewayRecordFor } = require('../helpers/gateway-record');
const { encrypt } = require('../../src/shared/encryption');
const guestVerify = require('../../src/modules/cashiering/paystack-adapter').__verifyTransaction;
const billingGateway = require('../../src/modules/billing/paystack-gateway');
const dispatch = require('../../src/modules/paystack-webhook/dispatch');

const GUEST_KEY = 'sk_test_guest_dispatch_key';
const BILLING_KEY = 'sk_test_billing_dispatch_key';

function sign(key, body) {
  return crypto.createHmac('sha512', key).update(body).digest('hex');
}

describe('Paystack webhook — one URL, two integrations', () => {
  const t = useTestApp();
  let ctx;
  let counter = 0;
  const realBillingKey = process.env.BILLING_PAYSTACK_SECRET_KEY;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-01-10' });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    guestVerify.mockReset();
    billingGateway.verifyTransaction.mockReset();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    process.env.BILLING_PAYSTACK_SECRET_KEY = BILLING_KEY;
    await setGuestKey(GUEST_KEY);
  });

  afterEach(() => {
    console.info.mockRestore();
  });

  afterAll(() => {
    if (realBillingKey === undefined) delete process.env.BILLING_PAYSTACK_SECRET_KEY;
    else process.env.BILLING_PAYSTACK_SECRET_KEY = realBillingKey;
  });

  async function setGuestKey(key) {
    await t.trx('platform_payment_integrations').where({ currency: 'NGN', provider: 'paystack' }).update({ secret_key_encrypted: encrypt(key) });
  }

  async function guestPayment() {
    counter += 1;
    const [folioId] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      reservation_id: ctx.a.reservations[0].id,
      folio_number: `DP${String(counter).padStart(6, '0')}`,
      status: 'open',
      balance: '20.00',
      currency: 'NGN',
      billed_to: 'Guest',
    });
    const [paymentId] = await t.trx('payments').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      folio_id: folioId,
      idempotency_key: `dp-key-${counter}`,
      provider: 'paystack',
      provider_reference: `guest-ref-${counter}`,
      amount: '20.00',
      currency: 'NGN',
      status: 'INITIATED',
      settlement_target: 'folio',
    });
    return t.trx('payments').where({ id: paymentId }).first();
  }

  async function billingPayment() {
    counter += 1;
    const [invoiceId] = await t.trx('subscription_invoices').insert({
      tenant_id: ctx.a.id,
      subscription_id: ctx.a.subscriptions[0].id,
      amount: '50000.00',
      currency: 'NGN',
      status: 'open',
      period_start: new Date(Date.UTC(2031, 0, 1 + counter)).toISOString().slice(0, 10),
      period_end: new Date(Date.UTC(2031, 0, 2 + counter)).toISOString().slice(0, 10),
      due_at: '2032-01-01',
    });
    const reference = `billing-charge-DISPATCHTEST${counter}`;
    const [paymentId] = await t.trx('subscription_payments').insert({
      tenant_id: ctx.a.id,
      subscription_invoice_id: invoiceId,
      idempotency_key: `dp-billing-key-${counter}`,
      provider: 'paystack',
      provider_reference: reference,
      amount: '50000.00',
      currency: 'NGN',
      status: 'INITIATED',
    });
    return { paymentId, invoiceId, reference };
  }

  async function post({ body, key, path = '/api/v1/webhooks/paystack' }) {
    const raw = JSON.stringify(body);
    const signature = key ? sign(key, raw) : 'not-a-real-signature';
    return t.request.post(path).set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(raw);
  }

  const guestEvents = (id) => t.trx('payment_webhook_events').where({ provider_event_id: String(id) });
  const billingEvents = (id) => t.trx('subscription_webhook_events').where({ provider_event_id: String(id) });

  describe('routing', () => {
    it('a guest/POS event signed with the guest key is applied by the guest handler only', async () => {
      const payment = await guestPayment();
      guestVerify.mockResolvedValue(gatewayRecordFor(payment));
      const res = await post({ body: { event: 'charge.success', data: { id: 910001, reference: payment.provider_reference, status: 'success' } }, key: GUEST_KEY });
      expect(res.status).toBe(200);
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
      expect(await guestEvents(910001)).toHaveLength(1);
      expect(await billingEvents(910001)).toHaveLength(0);
    });

    it('a billing charge event signed with the billing key is applied by the billing handler only', async () => {
      const { paymentId, reference } = await billingPayment();
      billingGateway.verifyTransaction.mockResolvedValue({ status: 'success', reference, providerPaymentId: '1', amountSubunit: 5000000, currency: 'NGN', gatewayResponse: 'Successful', authorization: {} });
      const res = await post({ body: { event: 'charge.success', data: { id: 910002, reference, status: 'success' } }, key: BILLING_KEY });
      expect(res.status).toBe(200);
      expect((await t.trx('subscription_payments').where({ id: paymentId }).first()).status).toBe('CAPTURED');
      expect(await billingEvents(910002)).toHaveLength(1);
      expect(await guestEvents(910002)).toHaveLength(0);
    });

    it('a card-verification event (billing-card-*) goes to billing and not to the guest handler', async () => {
      const reference = 'billing-card-DISPATCHTEST01';
      billingGateway.verifyTransaction.mockResolvedValue({ status: 'success', reference, providerPaymentId: '2', amountSubunit: 5000, currency: 'NGN', gatewayResponse: 'Successful', authorization: {} });
      const res = await post({ body: { event: 'charge.success', data: { id: 910003, reference, status: 'success' } }, key: BILLING_KEY });
      expect(res.status).toBe(200);
      const [row] = await billingEvents(910003);
      expect(row.verified).toBe(1);
      expect(await guestEvents(910003)).toHaveLength(0);
    });

    it('a billing refund event (reference in transaction_reference) goes to billing', async () => {
      const res = await post({ body: { event: 'refund.processed', data: { id: 910004, transaction_reference: 'billing-card-DISPATCHTEST02' } }, key: BILLING_KEY });
      expect(res.status).toBe(200);
      // Non-charge events are stored under `<event>:<id>` (so they cannot claim a charge's key).
      expect(await billingEvents('refund.processed:910004')).toHaveLength(1);
      expect(await guestEvents('refund.processed:910004')).toHaveLength(0);
    });

    it('the legacy /webhooks/billing-paystack alias reaches the same dispatcher: a billing event works and a guest event is still handed to the guest handler', async () => {
      const { paymentId, reference } = await billingPayment();
      billingGateway.verifyTransaction.mockResolvedValue({ status: 'success', reference, providerPaymentId: '3', amountSubunit: 5000000, currency: 'NGN', gatewayResponse: 'Successful', authorization: {} });
      const viaAlias = await post({ body: { event: 'charge.success', data: { id: 910005, reference, status: 'success' } }, key: BILLING_KEY, path: '/api/v1/webhooks/billing-paystack' });
      expect(viaAlias.status).toBe(200);
      expect((await t.trx('subscription_payments').where({ id: paymentId }).first()).status).toBe('CAPTURED');

      const payment = await guestPayment();
      guestVerify.mockResolvedValue(gatewayRecordFor(payment));
      const guestViaAlias = await post({ body: { event: 'charge.success', data: { id: 910006, reference: payment.provider_reference, status: 'success' } }, key: GUEST_KEY, path: '/api/v1/webhooks/billing-paystack' });
      expect(guestViaAlias.status).toBe(200);
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
    });
  });

  describe('unknown events and bad signatures', () => {
    it('a signed event we hold nothing for is acknowledged 200 and logged by type and reference only', async () => {
      const res = await post({ body: { event: 'transfer.success', data: { id: 910010, reference: 'someone-elses-ref', secret_detail: 'card-data-xyz' } }, key: GUEST_KEY });
      expect(res.status).toBe(200);
      const logged = console.info.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('transfer.success');
      expect(logged).toContain('someone-elses-ref');
      expect(logged).not.toContain('card-data-xyz');
      expect(logged).not.toContain(GUEST_KEY);
      expect(logged).not.toContain(BILLING_KEY);
    });

    it('a bad signature is rejected 401, the event is kept as unverified evidence, and nothing is applied', async () => {
      const payment = await guestPayment();
      const res = await post({ body: { event: 'charge.success', data: { id: 910011, reference: payment.provider_reference, status: 'success' } }, key: null });
      expect(res.status).toBe(401);
      expect(guestVerify).not.toHaveBeenCalled();
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('INITIATED');
      const [row] = await guestEvents(910011);
      expect(row.verified).toBe(0);
    });

    it('a billing event signed with the WRONG key is rejected and not applied', async () => {
      const { paymentId, reference } = await billingPayment();
      const res = await post({ body: { event: 'charge.success', data: { id: 910012, reference, status: 'success' } }, key: 'sk_test_some_other_key' });
      expect(res.status).toBe(401);
      expect(billingGateway.verifyTransaction).not.toHaveBeenCalled();
      expect((await t.trx('subscription_payments').where({ id: paymentId }).first()).status).toBe('INITIATED');
    });

    it('a missing signature header is rejected', async () => {
      const res = await t.request.post('/api/v1/webhooks/paystack').send({ event: 'charge.success', data: { id: 910013, reference: 'x' } });
      expect(res.status).toBe(401);
    });
  });

  describe('replay', () => {
    it('a redelivered guest event is applied once', async () => {
      const payment = await guestPayment();
      guestVerify.mockResolvedValue(gatewayRecordFor(payment));
      const body = { event: 'charge.success', data: { id: 910020, reference: payment.provider_reference, status: 'success' } };
      expect((await post({ body, key: GUEST_KEY })).status).toBe(200);
      expect((await post({ body, key: GUEST_KEY })).status).toBe(200);
      expect(await guestEvents(910020)).toHaveLength(1);
      expect(await t.trx('folio_line_items').where({ payment_id: payment.id })).toHaveLength(1);
      expect(guestVerify).toHaveBeenCalledTimes(1);
    });

    it('a redelivered billing event is applied once', async () => {
      const { reference } = await billingPayment();
      billingGateway.verifyTransaction.mockResolvedValue({ status: 'success', reference, providerPaymentId: '4', amountSubunit: 5000000, currency: 'NGN', gatewayResponse: 'Successful', authorization: {} });
      const body = { event: 'charge.success', data: { id: 910021, reference, status: 'success' } };
      expect((await post({ body, key: BILLING_KEY })).status).toBe(200);
      expect((await post({ body, key: BILLING_KEY })).status).toBe(200);
      expect(await billingEvents(910021)).toHaveLength(1);
      expect(billingGateway.verifyTransaction).toHaveBeenCalledTimes(1);
      expect(await guestEvents(910021)).toHaveLength(0);
    });
  });

  describe('keys', () => {
    it('both integrations on the SAME live key: events still route by reference, each to one handler', async () => {
      process.env.BILLING_PAYSTACK_SECRET_KEY = GUEST_KEY;
      const payment = await guestPayment();
      guestVerify.mockResolvedValue(gatewayRecordFor(payment));
      const { paymentId, reference } = await billingPayment();
      billingGateway.verifyTransaction.mockResolvedValue({ status: 'success', reference, providerPaymentId: '5', amountSubunit: 5000000, currency: 'NGN', gatewayResponse: 'Successful', authorization: {} });

      expect((await post({ body: { event: 'charge.success', data: { id: 910030, reference: payment.provider_reference } }, key: GUEST_KEY })).status).toBe(200);
      expect((await post({ body: { event: 'charge.success', data: { id: 910031, reference } }, key: GUEST_KEY })).status).toBe(200);

      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
      expect((await t.trx('subscription_payments').where({ id: paymentId }).first()).status).toBe('CAPTURED');
      expect(await guestEvents(910030)).toHaveLength(1);
      expect(await billingEvents(910030)).toHaveLength(0);
      expect(await billingEvents(910031)).toHaveLength(1);
      expect(await guestEvents(910031)).toHaveLength(0);
    });

    it('two DIFFERENT keys: each event is verified against its own key, and neither key can apply the other integration’s events', async () => {
      const payment = await guestPayment();
      guestVerify.mockResolvedValue(gatewayRecordFor(payment));
      const { paymentId, reference } = await billingPayment();
      billingGateway.verifyTransaction.mockResolvedValue({ status: 'success', reference, providerPaymentId: '6', amountSubunit: 5000000, currency: 'NGN', gatewayResponse: 'Successful', authorization: {} });

      expect((await post({ body: { event: 'charge.success', data: { id: 910040, reference: payment.provider_reference } }, key: GUEST_KEY })).status).toBe(200);
      expect((await post({ body: { event: 'charge.success', data: { id: 910041, reference } }, key: BILLING_KEY })).status).toBe(200);
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
      expect((await t.trx('subscription_payments').where({ id: paymentId }).first()).status).toBe('CAPTURED');

      // Crossed keys: the guest key cannot APPLY a billing event, nor the billing key a guest event.
      // (Signed by one of our keys, so Paystack gets a 200 and stops retrying, but the owning handler
      // could not verify it and nothing changes.)
      const payment2 = await guestPayment();
      const billing2 = await billingPayment();
      expect((await post({ body: { event: 'charge.success', data: { id: 910042, reference: billing2.reference } }, key: GUEST_KEY })).status).toBe(200);
      expect((await post({ body: { event: 'charge.success', data: { id: 910043, reference: payment2.provider_reference } }, key: BILLING_KEY })).status).toBe(200);
      expect((await t.trx('subscription_payments').where({ id: billing2.paymentId }).first()).status).toBe('INITIATED');
      expect((await t.trx('payments').where({ id: payment2.id }).first()).status).toBe('INITIATED');
    });

    it('an unknown event signed with the BILLING key only is still acknowledged (any candidate key verifies)', async () => {
      const res = await post({ body: { event: 'customeridentification.success', data: { id: 910044 } }, key: BILLING_KEY });
      expect(res.status).toBe(200);
    });
  });

  describe('routeFor', () => {
    it('billing- references always go to billing, on either route', async () => {
      expect(await dispatch.routeFor({ reference: 'billing-charge-X', defaultOwner: 'guest' })).toBe('billing');
      expect(await dispatch.routeFor({ reference: 'billing-card-X', defaultOwner: 'billing' })).toBe('billing');
    });
    it('other references go to the guest handler on the main route', async () => {
      expect(await dispatch.routeFor({ reference: 'anything', defaultOwner: 'guest' })).toBe('guest');
      expect(await dispatch.routeFor({ reference: null, defaultOwner: 'guest' })).toBe('guest');
    });
  });
});
