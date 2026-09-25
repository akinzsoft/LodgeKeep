'use strict';

/**
 * Security audit finding: the subscription-billing webhook validated the HMAC
 * but never checked Paystack's own record. A validly-signed, FALSE
 * `charge.success` could mark an invoice paid, advance a subscription period
 * or convert a trial tenant to active.
 *
 * These tests prove a validly-signed event whose contents do not match
 * Paystack's record cannot capture a subscription payment, and cover the
 * processing state machine (rejected / ignored / deferred / needs_review),
 * unsigned-request poisoning of the dedup key, and redelivery.
 *
 * `verifyWebhookSignature` is mocked (true = validly signed); `verifyTransaction`
 * is Paystack's own record and is what each test controls.
 */

jest.mock('../../src/modules/billing/paystack-gateway', () => ({
  ...jest.requireActual('../../src/modules/billing/paystack-gateway'),
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  refundTransaction: jest.fn(),
  chargeAuthorization: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const gateway = require('../../src/modules/billing/paystack-gateway');
const billingService = require('../../src/modules/billing/service');

describe('Billing webhook — verified against Paystack’s own record', () => {
  const t = useTestApp();
  let ctx;
  let counter = 0;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    gateway.verifyTransaction.mockReset();
    gateway.verifyWebhookSignature.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  /** An open 50,000.00 NGN invoice for tenant a with an INITIATED payment against it. */
  async function pendingSubscriptionPayment({ tenantStatus } = {}) {
    counter += 1;
    const subscriptionId = ctx.a.subscriptions[0].id;
    if (tenantStatus) await t.trx('tenants').where({ id: ctx.a.id }).update({ status: tenantStatus });
    const [invoiceId] = await t.trx('subscription_invoices').insert({
      tenant_id: ctx.a.id,
      subscription_id: subscriptionId,
      amount: '50000.00',
      currency: 'NGN',
      status: 'open',
      // (subscription_id, period_start) is unique: give every invoice its own period.
      period_start: isoDay(counter),
      period_end: isoDay(counter + 1),
      due_at: '2028-01-01',
    });
    const reference = `wv-billing-ref-${counter}`;
    const [paymentId] = await t.trx('subscription_payments').insert({
      tenant_id: ctx.a.id,
      subscription_invoice_id: invoiceId,
      idempotency_key: `wv-billing-key-${counter}`,
      provider: 'paystack',
      provider_reference: reference,
      amount: '50000.00',
      currency: 'NGN',
      status: 'INITIATED',
    });
    return { invoiceId, paymentId, reference };
  }

  function isoDay(offsetDays) {
    return new Date(Date.UTC(2030, 0, 1 + offsetDays)).toISOString().slice(0, 10);
  }

  function record(reference, overrides = {}) {
    return { status: 'success', reference, providerPaymentId: '810001', amountSubunit: 5000000, currency: 'NGN', gatewayResponse: 'Successful', authorization: {}, ...overrides };
  }

  function nextEventId() {
    counter += 1;
    return 810000 + counter;
  }

  async function postWebhook({ reference, eventId = nextEventId(), event = 'charge.success', signed = true, body } = {}) {
    gateway.verifyWebhookSignature.mockReturnValue(signed);
    const res = await t.request
      .post('/api/v1/webhooks/billing-paystack')
      .set('x-paystack-signature', 'mocked')
      .send(body ?? { event, data: { id: eventId, reference, gateway_response: 'Successful' } });
    return { res, eventId };
  }

  async function eventRow(eventId) {
    const row = await t.trx('subscription_webhook_events').where({ provider: 'paystack', provider_event_id: String(eventId) }).first();
    if (row && typeof row.outcome_detail === 'string') row.outcome_detail = JSON.parse(row.outcome_detail);
    return row;
  }

  async function snapshotBilling({ invoiceId, paymentId }) {
    return {
      payment: (await t.trx('subscription_payments').where({ id: paymentId }).first()).status,
      invoice: (await t.trx('subscription_invoices').where({ id: invoiceId }).first()).status,
      subscription: await t.trx('subscriptions').where({ id: ctx.a.subscriptions[0].id }).first(),
      tenant: await t.trx('tenants').where({ id: ctx.a.id }).first(),
      outbox: await t.trx('outbox_events').where({ tenant_id: ctx.a.id }).where('event_type', 'like', 'billing.%'),
    };
  }

  describe('a validly-signed event whose contents do not match Paystack’s record cannot capture', () => {
    it.each([
      ['a lower amount', { amountSubunit: 1 }, 'AMOUNT_MISMATCH'],
      ['a different currency', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
      ['a different reference', { reference: 'someone-elses-ref' }, 'REFERENCE_MISMATCH'],
      ['no amount at all', { amountSubunit: undefined }, 'AMOUNT_MISSING'],
    ])('rejects %s and changes nothing about the invoice, subscription, tenant or outbox', async (_label, override, code) => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment();
      const before = await snapshotBilling({ invoiceId, paymentId });
      gateway.verifyTransaction.mockResolvedValue(record(reference, override));

      const { res, eventId } = await postWebhook({ reference });
      expect(res.status).toBe(200);

      const after = await snapshotBilling({ invoiceId, paymentId });
      expect(after.payment).toBe('INITIATED');
      expect(after.invoice).toBe('open');
      expect(after.subscription.status).toBe(before.subscription.status);
      expect(after.subscription.current_period_start).toEqual(before.subscription.current_period_start);
      expect(after.subscription.current_period_end).toEqual(before.subscription.current_period_end);
      expect(after.tenant.status).toBe(before.tenant.status);
      expect(after.tenant.plan_id).toEqual(before.tenant.plan_id);
      expect(after.outbox).toHaveLength(before.outbox.length);

      const row = await eventRow(eventId);
      expect(row.verified).toBe(1);
      expect(row.outcome).toBe('rejected');
      expect(row.outcome_detail.code).toBe(code);
      expect(row.processed_at).not.toBeNull();
      expect(String(row.related_subscription_payment_id)).toBe(String(paymentId));
      expect(await t.trx('audit_log').where({ entity_type: 'subscription_payments', entity_id: String(paymentId), action: 'gateway_webhook_rejected' }).first()).toBeTruthy();
    });

    it('a forged charge.success for a trial tenant does not convert it to active', async () => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment({ tenantStatus: 'trial' });
      await t.trx('tenants').where({ id: ctx.a.id }).update({ plan_id: null });
      gateway.verifyTransaction.mockResolvedValue(record(reference, { status: 'failed' }));

      await postWebhook({ reference });

      const after = await snapshotBilling({ invoiceId, paymentId });
      expect(after.tenant.status).toBe('trial'); // never converted by a forged success
      expect(after.tenant.plan_id).toBeNull();
      expect(after.invoice).not.toBe('paid');
      await t.trx('tenants').where({ id: ctx.a.id }).update({ status: 'active' });
    });

    it('defers a first Paystack 404, and only a persistent 404 rejects', async () => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment();
      gateway.verifyTransaction.mockRejectedValue(Object.assign(new Error('not found'), { details: { httpStatus: 404 } }));

      const { eventId } = await postWebhook({ reference });
      let row = await eventRow(eventId);
      expect(row.outcome).toBeNull(); // not decided on the first look
      expect(row.attempt_count).toBe(1);

      await t.trx('subscription_webhook_events').where({ id: row.id }).update({ attempt_count: 3 });
      expect((await billingService.processBillingWebhookEvent({ eventId: row.id })).outcome).toBe('rejected');
      const after = await snapshotBilling({ invoiceId, paymentId });
      expect(after.payment).toBe('INITIATED');
      row = await eventRow(eventId);
      expect(row.outcome_detail.code).toBe('RECORD_NOT_FOUND');
    });
  });

  describe('the applied outcome comes from Paystack’s record', () => {
    it('captures when the record matches, marks the invoice paid and finalises the event', async () => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment();
      gateway.verifyTransaction.mockResolvedValue(record(reference));

      const { eventId } = await postWebhook({ reference });

      const after = await snapshotBilling({ invoiceId, paymentId });
      expect(after.payment).toBe('CAPTURED');
      expect(after.invoice).toBe('paid');
      const row = await eventRow(eventId);
      expect(row.outcome).toBe('applied');
      expect(row.outcome_detail.appliedStatus).toBe('success');
    });

    it('applies a FAILED outcome from the record even though the body claimed success', async () => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment();
      gateway.verifyTransaction.mockResolvedValue(record(reference, { status: 'failed' }));
      const { eventId } = await postWebhook({ reference });
      const after = await snapshotBilling({ invoiceId, paymentId });
      expect(after.payment).toBe('FAILED');
      expect(after.invoice).not.toBe('paid');
      expect((await eventRow(eventId)).outcome_detail.appliedStatus).toBe('failed');
    });

    it('records but ignores events that are not charge events, under their own key', async () => {
      const { paymentId, reference } = await pendingSubscriptionPayment();
      const refundId = nextEventId();
      await postWebhook({ body: { event: 'refund.processed', data: { id: refundId, reference } } });
      expect(gateway.verifyTransaction).not.toHaveBeenCalled();
      expect((await t.trx('subscription_payments').where({ id: paymentId }).first()).status).toBe('INITIATED');
      const row = await eventRow(`refund.processed:${refundId}`);
      expect(row.outcome).toBe('ignored');
      expect(row.outcome_detail.reason).toBe('event_not_handled');
    });

    it('ignores a card-verification checkout event that matches no subscription payment', async () => {
      const { eventId } = await postWebhook({ reference: 'card-verification-checkout-ref' });
      expect(gateway.verifyTransaction).not.toHaveBeenCalled();
      const row = await eventRow(eventId);
      expect(row.outcome).toBe('ignored');
      expect(row.outcome_detail.reason).toBe('unknown_reference');
    });
  });

  describe('a transaction Paystack has not finalised, or cannot be asked about, is retried — never decided', () => {
    it('leaves a not-final transaction open and schedules a retry', async () => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment();
      gateway.verifyTransaction.mockResolvedValue(record(reference, { status: 'ongoing' }));
      const { eventId } = await postWebhook({ reference });
      expect((await snapshotBilling({ invoiceId, paymentId })).payment).toBe('INITIATED');
      const row = await eventRow(eventId);
      expect(row.outcome).toBeNull();
      expect(row.attempt_count).toBe(1);
      expect(row.next_attempt_at).not.toBeNull();
    });

    it('defers on a Paystack outage with 200, then applies once a good record is available', async () => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment();
      gateway.verifyTransaction.mockRejectedValue(Object.assign(new Error('timed out'), { details: { timedOut: true } }));
      const { res, eventId } = await postWebhook({ reference });
      expect(res.status).toBe(200);
      let row = await eventRow(eventId);
      expect(row.outcome).toBeNull();
      expect(row.attempt_count).toBe(1);

      gateway.verifyTransaction.mockResolvedValue(record(reference));
      const result = await billingService.processBillingWebhookEvent({ eventId: row.id });
      expect(result.outcome).toBe('applied');
      expect((await snapshotBilling({ invoiceId, paymentId })).payment).toBe('CAPTURED');
      row = await eventRow(eventId);
      expect(row.outcome).toBe('applied');
    });

    it('gives up after the maximum attempts with an audit row', async () => {
      const { paymentId, reference } = await pendingSubscriptionPayment();
      gateway.verifyTransaction.mockRejectedValue(Object.assign(new Error('boom'), { details: { httpStatus: 503 } }));
      const { eventId } = await postWebhook({ reference });
      let row = await eventRow(eventId);
      await t.trx('subscription_webhook_events').where({ id: row.id }).update({ attempt_count: 11 });
      const result = await billingService.processBillingWebhookEvent({ eventId: row.id });
      expect(result.outcome).toBe('deferred_exhausted');
      row = await eventRow(eventId);
      expect(row.outcome).toBe('deferred_exhausted');
      expect(await t.trx('audit_log').where({ entity_id: String(paymentId), action: 'gateway_webhook_deferred_exhausted' }).first()).toBeTruthy();
    });
  });

  describe('dedup and unsigned requests', () => {
    it('never calls Paystack for an unsigned event, and attributes nothing to a tenant', async () => {
      const { reference } = await pendingSubscriptionPayment();
      const { eventId } = await postWebhook({ reference, signed: false });
      expect(gateway.verifyTransaction).not.toHaveBeenCalled();
      const row = await eventRow(eventId);
      expect(row.verified).toBe(0);
      expect(row.tenant_id).toBeNull();
      expect(row.related_subscription_payment_id).toBeNull();
      expect(row.next_attempt_at).toBeNull();
    });

    it('a signed event still processes after an unsigned one squatted the same event id', async () => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment();
      const eventId = nextEventId();
      await postWebhook({ reference, eventId, signed: false });
      expect((await eventRow(eventId)).verified).toBe(0);

      gateway.verifyTransaction.mockResolvedValue(record(reference));
      await postWebhook({ reference, eventId, signed: true });

      const row = await eventRow(eventId);
      expect(row.verified).toBe(1);
      expect(row.outcome).toBe('applied');
      expect((await snapshotBilling({ invoiceId, paymentId })).payment).toBe('CAPTURED');
      expect(await t.trx('subscription_webhook_events').where({ provider_event_id: String(eventId) })).toHaveLength(1);
    });

    it('verifies once: a redelivery of an already-decided event is deduplicated', async () => {
      const { reference } = await pendingSubscriptionPayment();
      gateway.verifyTransaction.mockResolvedValue(record(reference));
      const eventId = nextEventId();
      await postWebhook({ reference, eventId });
      await postWebhook({ reference, eventId });
      expect(gateway.verifyTransaction).toHaveBeenCalledTimes(1);
    });

    it('a signed redelivery of a persisted-but-never-finalised event is processed, not dropped', async () => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment();
      const eventId = nextEventId();
      gateway.verifyTransaction.mockRejectedValue(Object.assign(new Error('down'), { details: { httpStatus: 503 } }));
      await postWebhook({ reference, eventId });
      expect((await eventRow(eventId)).outcome).toBeNull();

      gateway.verifyTransaction.mockResolvedValue(record(reference));
      await postWebhook({ reference, eventId });
      expect((await snapshotBilling({ invoiceId, paymentId })).payment).toBe('CAPTURED');
    });
  });

  describe('a payment made after the local payment was already failed', () => {
    it('is flagged for review and leaves the invoice and subscription alone', async () => {
      const { invoiceId, paymentId, reference } = await pendingSubscriptionPayment();
      await t.trx('subscription_payments').where({ id: paymentId }).update({ status: 'FAILED', failed_at: new Date() });
      gateway.verifyTransaction.mockResolvedValue(record(reference));

      const { eventId } = await postWebhook({ reference });

      expect((await snapshotBilling({ invoiceId, paymentId })).payment).toBe('FAILED');
      expect((await snapshotBilling({ invoiceId, paymentId })).invoice).toBe('open');
      const row = await eventRow(eventId);
      expect(row.outcome).toBe('needs_review');
      expect(row.outcome_detail.reason).toBe('paid_after_terminal');
      expect(await t.trx('audit_log').where({ entity_id: String(paymentId), action: 'gateway_webhook_needs_review' }).first()).toBeTruthy();
    });
  });
});
