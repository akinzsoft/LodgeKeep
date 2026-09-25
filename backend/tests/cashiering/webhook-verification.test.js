'use strict';

/**
 * Security audit finding: "The Paystack webhook validates HMAC but never
 * independently verifies the transaction against Paystack's own records."
 *
 * A valid signature proves who SENT an event, not that its contents match what
 * Paystack actually holds. These tests prove a validly-signed event whose
 * contents do NOT match Paystack's record cannot capture a payment, and cover
 * the state machine around it: rejected / ignored / deferred / needs_review,
 * unsigned-request poisoning of the dedup key, and redelivery.
 *
 * `verifyWebhookSignature` is mocked (true = validly signed) exactly as in
 * `cashiering.test.js`; `verifyTransaction` is Paystack's own record and is
 * what each test controls. Every "must not capture" case asserts the payment
 * is not CAPTURED, no folio credit was posted and the folio balance is unchanged.
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

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { gatewayRecordFor } = require('../helpers/gateway-record');
const { GatewayRequestError } = require('../../src/modules/cashiering/paystack-adapter');
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;
const cashieringService = require('../../src/modules/cashiering/service');

describe('Paystack webhook — verified against Paystack’s own record (guest payments)', () => {
  const t = useTestApp();
  let ctx;
  let idem = 0;
  let folioCounter = 0;
  let eventCounter = 8000;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-01-10' });
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

  function tokenFor() {
    return signAccessToken({
      aud: 'staff',
      sub: String(ctx.a.users[0].id),
      tenant_id: String(ctx.a.id),
      property_id: String(ctx.a.properties[0].id),
    });
  }

  /** A folio owing `amount`, and a real INITIATED/PENDING Paystack payment against it for the same amount. */
  async function pendingPayment(amount = '20.00') {
    folioCounter += 1;
    const [folioId] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      reservation_id: ctx.a.reservations[0].id,
      folio_number: `WV${String(folioCounter).padStart(6, '0')}`,
      status: 'open',
      balance: amount,
      currency: 'NGN',
      billed_to: 'Guest',
    });
    await t.trx('folio_line_items').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      folio_id: folioId,
      type: 'adjustment',
      description: 'Test fixture balance',
      amount,
      currency: 'NGN',
      business_date: '2027-01-10',
    });
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay/x', accessCode: 'x', reference }));
    idem += 1;
    const res = await t.request
      .post(`/api/v1/cashiering/folios/${folioId}/payments/paystack`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .set('Idempotency-Key', `wv-key-${idem}`)
      .send({ amount, currency: 'NGN', guest_email: 'guest@example.com' });
    expect(res.status).toBe(201);
    const payment = await t.trx('payments').where({ id: res.body.data.id }).first();
    return { folioId, payment };
  }

  function nextEventId() {
    eventCounter += 1;
    return eventCounter;
  }

  async function postWebhook({ payment, eventId = nextEventId(), event = 'charge.success', signed = true, body } = {}) {
    paystack.verifyWebhookSignature.mockReturnValue(signed);
    const res = await t.request
      .post('/api/v1/webhooks/paystack')
      .set('x-paystack-signature', 'mocked')
      .send(body ?? { event, data: { id: eventId, reference: payment.provider_reference, status: 'success' } });
    return { res, eventId };
  }

  async function eventRow(eventId) {
    const row = await t.trx('payment_webhook_events').where({ provider_event_id: String(eventId) }).first();
    if (row && typeof row.outcome_detail === 'string') row.outcome_detail = JSON.parse(row.outcome_detail);
    return row;
  }

  async function expectNotCaptured({ folioId, payment, balance = '20.00' }) {
    const after = await t.trx('payments').where({ id: payment.id }).first();
    expect(after.status).not.toBe('CAPTURED');
    expect(await t.trx('folio_line_items').where({ payment_id: payment.id })).toHaveLength(0);
    expect((await t.trx('folios').where({ id: folioId }).first()).balance).toBe(balance);
    return after;
  }

  describe('a validly-signed event whose contents do not match Paystack’s record cannot capture', () => {
    it('rejects when Paystack collected less than the local amount', async () => {
      const { folioId, payment } = await pendingPayment('20.00');
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { amountSubunit: 1 }));

      const { res, eventId } = await postWebhook({ payment });
      expect(res.status).toBe(200);

      await expectNotCaptured({ folioId, payment });
      const row = await eventRow(eventId);
      expect(row.verified).toBe(1);
      expect(row.outcome).toBe('rejected');
      expect(row.outcome_detail.code).toBe('AMOUNT_MISMATCH');
      expect(row.outcome_detail.expected.amountSubunit).toBe('2000');
      expect(row.outcome_detail.observed.amountSubunit).toBe(1);
      expect(row.processed_at).not.toBeNull();
      expect(row.next_attempt_at).toBeNull();
      expect(String(row.related_payment_id)).toBe(String(payment.id));
    });

    it('rejects a different currency', async () => {
      const { folioId, payment } = await pendingPayment();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { currency: 'USD' }));
      const { eventId } = await postWebhook({ payment });
      await expectNotCaptured({ folioId, payment });
      expect((await eventRow(eventId)).outcome_detail.code).toBe('CURRENCY_MISMATCH');
    });

    it('rejects a record for a different transaction reference', async () => {
      const { folioId, payment } = await pendingPayment();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { reference: 'someone-elses-transaction' }));
      const { eventId } = await postWebhook({ payment });
      await expectNotCaptured({ folioId, payment });
      expect((await eventRow(eventId)).outcome_detail.code).toBe('REFERENCE_MISMATCH');
    });

    it('defers a first Paystack 404 (lag / rotated key), and only a persistent 404 rejects without failing the payment', async () => {
      const { folioId, payment } = await pendingPayment();
      // The exact response the live sandbox sends for an unknown reference.
      paystack.verifyTransaction.mockRejectedValue(
        new GatewayRequestError('paystack', 'Transaction reference not found.', { httpStatus: 400, body: { status: false, code: 'transaction_not_found' } })
      );

      const { res, eventId } = await postWebhook({ payment });
      expect(res.status).toBe(200);
      let row = await eventRow(eventId);
      expect(row.outcome).toBeNull(); // not decided on the first look
      expect(row.attempt_count).toBe(1);
      await expectNotCaptured({ folioId, payment });

      // Still 404 after the grace attempts: now it is a rejection.
      await t.trx('payment_webhook_events').where({ id: row.id }).update({ attempt_count: 3 });
      const result = await cashieringService.processPaymentWebhookEvent({ eventId: row.id });
      expect(result.outcome).toBe('rejected');
      const after = await expectNotCaptured({ folioId, payment });
      expect(after.status).not.toBe('FAILED'); // left open: a genuine payment could still arrive
      row = await eventRow(eventId);
      expect(row.outcome_detail.code).toBe('RECORD_NOT_FOUND');
    });

    it('recovers when a first 404 was only lag: the retry sees the record and captures', async () => {
      const { payment } = await pendingPayment();
      paystack.verifyTransaction.mockRejectedValueOnce(new GatewayRequestError('paystack', 'not found yet', { httpStatus: 404 }));
      const { eventId } = await postWebhook({ payment });
      const row = await eventRow(eventId);
      expect(row.outcome).toBeNull();

      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
      expect((await cashieringService.processPaymentWebhookEvent({ eventId: row.id })).outcome).toBe('applied');
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
    });

    it('writes an audit_log row for a rejection so it can be alerted on', async () => {
      const { payment } = await pendingPayment();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { amountSubunit: 5 }));
      const { eventId } = await postWebhook({ payment });
      const audit = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: String(payment.id), action: 'gateway_webhook_rejected' }).first();
      expect(audit).toBeTruthy();
      expect(audit.source).toBe('integration');
      expect(String(audit.tenant_id)).toBe(String(ctx.a.id));
      const after = typeof audit.after_state === 'string' ? JSON.parse(audit.after_state) : audit.after_state;
      expect(after.code).toBe('AMOUNT_MISMATCH');
      expect(String(after.eventId)).toBe(String((await eventRow(eventId)).id));
    });

    it('does not capture even when the webhook body itself claims success with the right reference', async () => {
      const { folioId, payment } = await pendingPayment();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { status: 'abandoned' }));
      await postWebhook({
        payment,
        body: { event: 'charge.success', data: { id: nextEventId(), reference: payment.provider_reference, status: 'success', amount: 2000, currency: 'NGN' } },
      });
      await expectNotCaptured({ folioId, payment });
    });
  });

  describe('the applied outcome comes from Paystack’s record, never from the webhook body', () => {
    it('captures when the record matches, using the LOCAL amount for the folio credit', async () => {
      const { folioId, payment } = await pendingPayment('20.00');
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { providerPaymentId: '5501', channel: 'ussd' }));

      // The body lies about amount and currency; neither may matter.
      const eventId = 5501;
      const { res } = await postWebhook({
        payment,
        eventId,
        body: { event: 'charge.success', data: { id: eventId, reference: payment.provider_reference, status: 'success', amount: 999999, currency: 'USD', channel: 'card' } },
      });
      expect(res.status).toBe(200);

      const after = await t.trx('payments').where({ id: payment.id }).first();
      expect(after.status).toBe('CAPTURED');
      expect(after.provider_payment_id).toBe('5501');
      expect(after.provider_channel).toBe('ussd'); // from Paystack's record, not the body
      const lines = await t.trx('folio_line_items').where({ payment_id: payment.id });
      expect(lines).toHaveLength(1);
      expect(lines[0].amount).toBe('-20.00');
      expect((await t.trx('folios').where({ id: folioId }).first()).balance).toBe('0.00');

      const row = await eventRow(eventId);
      expect(row.outcome).toBe('applied');
      expect(row.outcome_detail.appliedStatus).toBe('success');
      expect(row.processed_at).not.toBeNull();
    });

    it('marks the payment FAILED from the record even when the body claimed success', async () => {
      const { payment } = await pendingPayment();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { status: 'failed' }));
      const { eventId } = await postWebhook({ payment });
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('FAILED');
      const row = await eventRow(eventId);
      expect(row.outcome).toBe('applied');
      expect(row.outcome_detail.appliedStatus).toBe('failed');
    });

    it('only acts on charge events: a refund notice no longer FAILs a payment', async () => {
      const { folioId, payment } = await pendingPayment();
      const refundId = nextEventId();
      const { res } = await postWebhook({
        payment,
        body: { event: 'refund.processed', data: { id: refundId, reference: payment.provider_reference, status: 'processed' } },
      });
      expect(res.status).toBe(200);
      const after = await expectNotCaptured({ folioId, payment });
      expect(after.status).not.toBe('FAILED');
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      // A non-charge event is keyed under its own namespace, so it can never claim a transaction id.
      const row = await eventRow(`refund.processed:${refundId}`);
      expect(row.outcome).toBe('ignored');
      expect(row.outcome_detail.reason).toBe('event_not_handled');
    });

    it('a signed non-charge event with the same numeric id cannot block the genuine charge.success', async () => {
      const { payment } = await pendingPayment();
      const sharedId = nextEventId();
      await postWebhook({ payment, body: { event: 'refund.processed', data: { id: sharedId, reference: payment.provider_reference } } });

      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
      await postWebhook({ payment, eventId: sharedId });

      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
      expect((await eventRow(sharedId)).outcome).toBe('applied');
    });
  });

  describe('a transaction Paystack has not finalised, or cannot be asked about, is retried — never decided', () => {
    it('leaves an abandoned/ongoing transaction open and schedules a retry', async () => {
      const { folioId, payment } = await pendingPayment();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment, { status: 'ongoing' }));
      const { res, eventId } = await postWebhook({ payment });
      expect(res.status).toBe(200);
      const after = await expectNotCaptured({ folioId, payment });
      expect(after.status).not.toBe('FAILED');
      const row = await eventRow(eventId);
      expect(row.outcome).toBeNull();
      expect(row.attempt_count).toBe(1);
      expect(row.next_attempt_at).not.toBeNull();
      expect(row.processed_at).toBeNull();
    });

    it('answers 200 and defers when Paystack is unreachable, then captures once a good record is available', async () => {
      const { payment } = await pendingPayment();
      paystack.verifyTransaction.mockRejectedValue(new GatewayRequestError('paystack', 'the request timed out', { timedOut: true }));
      const { res, eventId } = await postWebhook({ payment });
      expect(res.status).toBe(200);

      let row = await eventRow(eventId);
      expect(row.outcome).toBeNull();
      expect(row.attempt_count).toBe(1);
      expect(row.outcome_detail.lastReason).toMatch(/verify_failed/);
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).not.toBe('CAPTURED');

      // The retry sweep (or a Paystack redelivery) later reaches the same processor.
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
      const result = await cashieringService.processPaymentWebhookEvent({ eventId: row.id });
      expect(result.outcome).toBe('applied');
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
      row = await eventRow(eventId);
      expect(row.outcome).toBe('applied');
    });

    it('treats a 401 (bad key) as transient, not as a rejection of a genuine payment', async () => {
      const { payment } = await pendingPayment();
      paystack.verifyTransaction.mockRejectedValue(new GatewayRequestError('paystack', 'Invalid key', { httpStatus: 401 }));
      const { eventId } = await postWebhook({ payment });
      const row = await eventRow(eventId);
      expect(row.outcome).toBeNull();
      expect(row.attempt_count).toBe(1);
    });

    it('gives up after the maximum attempts with deferred_exhausted and an audit row', async () => {
      const { payment } = await pendingPayment();
      paystack.verifyTransaction.mockRejectedValue(new GatewayRequestError('paystack', 'boom', { httpStatus: 503 }));
      const { eventId } = await postWebhook({ payment });
      let row = await eventRow(eventId);
      await t.trx('payment_webhook_events').where({ id: row.id }).update({ attempt_count: 11 });
      const result = await cashieringService.processPaymentWebhookEvent({ eventId: row.id });
      expect(result.outcome).toBe('deferred_exhausted');
      row = await eventRow(eventId);
      expect(row.outcome).toBe('deferred_exhausted');
      expect(row.processed_at).not.toBeNull();
      expect(await t.trx('audit_log').where({ entity_id: String(payment.id), action: 'gateway_webhook_deferred_exhausted' }).first()).toBeTruthy();
    });
  });

  describe('when Paystack is not asked at all', () => {
    it('never calls Paystack for an unsigned event', async () => {
      const { payment } = await pendingPayment();
      const { res, eventId } = await postWebhook({ payment, signed: false });
      expect(res.status).toBe(200);
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      const row = await eventRow(eventId);
      expect(row.verified).toBe(0);
      expect(row.outcome).toBeNull();
      expect(row.next_attempt_at).toBeNull();
      expect(row.tenant_id).toBeNull(); // nothing an unsigned caller names is attributed to a tenant
      expect(row.related_payment_id).toBeNull();
    });

    it('never calls Paystack for a payment that is already captured', async () => {
      const { payment } = await pendingPayment();
      await t.trx('payments').where({ id: payment.id }).update({ status: 'CAPTURED', captured_at: new Date() });
      const { eventId } = await postWebhook({ payment });
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      const row = await eventRow(eventId);
      expect(row.outcome).toBe('ignored');
      expect(row.outcome_detail.reason).toBe('already_settled');
    });

    it('ignores an event whose reference matches no local payment', async () => {
      const { res } = await postWebhook({ payment: { provider_reference: 'no-such-reference' } });
      expect(res.status).toBe(200);
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });

    it('verifies once: a redelivery of an already-decided event is deduplicated', async () => {
      const { payment } = await pendingPayment();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
      const eventId = nextEventId();
      await postWebhook({ payment, eventId });
      await postWebhook({ payment, eventId });
      await postWebhook({ payment, eventId });
      expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
      expect(await t.trx('folio_line_items').where({ payment_id: payment.id })).toHaveLength(1);
    });
  });

  describe('unsigned requests cannot poison the dedup key', () => {
    it('a signed event still processes after an unsigned one squatted the same event id', async () => {
      const { payment } = await pendingPayment();
      const eventId = nextEventId();

      await postWebhook({ payment, eventId, signed: false });
      expect((await eventRow(eventId)).verified).toBe(0);

      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
      const { res } = await postWebhook({ payment, eventId, signed: true });
      expect(res.status).toBe(200);

      const row = await eventRow(eventId);
      expect(row.verified).toBe(1);
      expect(row.outcome).toBe('applied');
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
      expect(await t.trx('payment_webhook_events').where({ provider_event_id: String(eventId) })).toHaveLength(1);
    });

    it('an unsigned request after a signed one changes nothing', async () => {
      const { payment } = await pendingPayment();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
      const eventId = nextEventId();
      await postWebhook({ payment, eventId, signed: true });
      await postWebhook({ payment, eventId, signed: false, body: { event: 'charge.success', data: { id: eventId, reference: 'forged' } } });
      const row = await eventRow(eventId);
      expect(row.verified).toBe(1);
      expect(row.outcome).toBe('applied');
      expect(JSON.stringify(row.payload)).not.toMatch(/forged/);
    });

    it('a signed redelivery of an event that was persisted but never finalised is processed, not dropped', async () => {
      const { payment } = await pendingPayment();
      const eventId = nextEventId();
      paystack.verifyTransaction.mockRejectedValue(new GatewayRequestError('paystack', 'down', { httpStatus: 503 }));
      await postWebhook({ payment, eventId });
      expect((await eventRow(eventId)).outcome).toBeNull();

      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
      await postWebhook({ payment, eventId }); // Paystack's own retry
      expect((await eventRow(eventId)).outcome).toBe('applied');
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
    });
  });

  describe('a payment made after the local payment was already failed', () => {
    it('is flagged for review and does not touch the ledger', async () => {
      const { folioId, payment } = await pendingPayment();
      await t.trx('payments').where({ id: payment.id }).update({ status: 'FAILED', failed_at: new Date() });
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));

      const { eventId } = await postWebhook({ payment });
      const after = await t.trx('payments').where({ id: payment.id }).first();
      expect(after.status).toBe('FAILED');
      expect(await t.trx('folio_line_items').where({ payment_id: payment.id })).toHaveLength(0);
      expect((await t.trx('folios').where({ id: folioId }).first()).balance).toBe('20.00');

      const row = await eventRow(eventId);
      expect(row.outcome).toBe('needs_review');
      expect(row.outcome_detail.reason).toBe('paid_after_terminal');
      expect(await t.trx('audit_log').where({ entity_id: String(payment.id), action: 'gateway_webhook_needs_review' }).first()).toBeTruthy();
    });

    it('does not verify a repeat charge.failed for an already-terminal payment', async () => {
      const { payment } = await pendingPayment();
      await t.trx('payments').where({ id: payment.id }).update({ status: 'FAILED', failed_at: new Date() });
      const { eventId } = await postWebhook({ payment, event: 'charge.failed' });
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      expect((await eventRow(eventId)).outcome).toBe('ignored');
    });
  });
  describe('signature verification failures', () => {
    it('answers with an error (so Paystack redelivers) rather than persisting a genuine event as unsigned', async () => {
      const { payment } = await pendingPayment();
      const { resolveAdapterForCurrency } = require('../../src/modules/cashiering/paystack-adapter');
      resolveAdapterForCurrency.mockRejectedValueOnce(new Error('database went away'));
      const eventId = nextEventId();

      const res = await t.request
        .post('/api/v1/webhooks/paystack')
        .set('x-paystack-signature', 'mocked')
        .send({ event: 'charge.success', data: { id: eventId, reference: payment.provider_reference, status: 'success' } });

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await eventRow(eventId)).toBeUndefined(); // nothing was persisted, so Paystack's redelivery is not deduplicated away
    });

    it('treats a genuinely unconfigured currency as unverifiable: persisted unsigned, never processed', async () => {
      const { payment } = await pendingPayment();
      const { resolveAdapterForCurrency, GatewayNotConfiguredError } = require('../../src/modules/cashiering/paystack-adapter');
      resolveAdapterForCurrency.mockRejectedValueOnce(new GatewayNotConfiguredError('paystack'));
      const { res, eventId } = await postWebhook({ payment });
      expect(res.status).toBe(200);
      const row = await eventRow(eventId);
      expect(row.verified).toBe(0);
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });
  });
});
