'use strict';

/**
 * Refund reconciliation, real pooled connections. A Paystack refund intent left PENDING (accepted, not finished) or with
 * an unknown outcome (the call timed out) must be settled from Paystack's own record without ever risking a double
 * refund: a clear "processed"/"failed" is applied through ONE function whichever path sees it first (the refund call
 * itself, the sweep, a refund webhook, a manager), and an unclear answer releases nothing.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = {
    refundTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    fetchRefund: jest.fn(),
    listRefundsForTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn(),
  };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })),
  };
});

const dbModule = require('../../src/db');
const { db } = require('../helpers/db');
const { scopedDb } = require('../../src/db');
const { sumMoney } = require('../../src/shared/money');
const paystack = require('../../src/modules/cashiering/paystack-adapter');
const adapter = paystack.__mockAdapter;
const service = require('../../src/modules/cashiering/service');
const { runRefundReconciliationSweep } = require('../../src/jobs/payment-webhooks');
const { seedRaceTenant, ledgerBalance, storedBalance } = require('../helpers/folio-race');

describe('refund reconciliation (real connections)', () => {
  let t;
  let n = 0;
  const key = () => `rr-key-${Date.now().toString(36)}-${(n += 1)}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const later = () => new Date(Date.now() + 10 * 60_000);
  const inTx = (fn) => scopedDb().for(t.context).transaction(fn);

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    t = await seedRaceTenant({ label: 'reconcile' });
  });
  beforeEach(() => {
    for (const fn of Object.values(adapter)) fn.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.REFUND_RECONCILE_MIN_AGE_MINUTES;
  });
  afterEach(() => console.error.mockRestore());
  afterAll(async () => {
    await db()('refund_reconciliations').where({ tenant_id: t.tenantId }).delete();
    await db()('payment_webhook_events').where({ tenant_id: t.tenantId }).delete();
    await t.cleanup();
    dbModule.__resetForTesting();
  });

  /** A folio carrying one captured Paystack payment of 100.00, with the Paystack transaction id on record. */
  async function paystackPayment(amount = '100.00') {
    const { folioId } = await t.addReservationWithFolio();
    await inTx((trx) => service.postCharge({ trx, folioId, type: 'pos_charge', description: 'c', amount, userId: null }));
    const owed = await storedBalance(folioId);
    n += 1;
    const [id] = await db()('payments').insert({
      tenant_id: t.tenantId,
      property_id: t.propertyId,
      folio_id: folioId,
      idempotency_key: key(),
      provider: 'paystack',
      provider_reference: `rr-ps-${Date.now().toString(36)}-${n}`,
      provider_payment_id: String(880000 + n),
      amount: owed,
      currency: 'NGN',
      status: 'CAPTURED',
      captured_at: new Date(),
    });
    await db()('folio_line_items').insert({ tenant_id: t.tenantId, property_id: t.propertyId, folio_id: folioId, type: 'payment', description: 'Paystack payment', amount: `-${owed}`, currency: 'NGN', payment_method: 'paystack', payment_id: id, business_date: '2027-06-01' });
    await inTx((trx) => service.recomputeFolioBalance({ trx, folioId }));
    return { folioId, payment: await db()('payments').where({ id }).first() };
  }

  const refund = (paymentId, extra = {}) => service.refundPayment({ context: t.context, paymentId, reason: 'guest left', idempotencyKey: key(), userId: null, ...extra });

  /** A refund Paystack accepted but has not finished. */
  async function pendingRefund(extra = {}) {
    const ctx = await paystackPayment();
    adapter.refundTransaction.mockResolvedValueOnce({ status: 'pending', refundId: `R${(n += 1)}` });
    const intent = await refund(ctx.payment.id, extra);
    expect(intent.status).toBe('PENDING');
    return { ...ctx, intent };
  }

  /** A refund whose call timed out: PENDING, no refund id. */
  async function unknownRefund() {
    const ctx = await paystackPayment();
    adapter.refundTransaction.mockRejectedValueOnce(new paystack.GatewayRequestError('paystack', 'the request timed out', { timedOut: true }));
    await expect(refund(ctx.payment.id)).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_ERROR' });
    const intent = await db()('payments').where({ parent_payment_id: ctx.payment.id }).first();
    expect(intent.status).toBe('PENDING');
    expect(intent.provider_payment_id).toBeNull();
    return { ...ctx, intent };
  }

  const row = (id) => db()('payments').where({ id }).first();
  const recon = (id) => db()('refund_reconciliations').where({ payment_id: id }).first();
  const refundLines = (folioId) => db()('folio_line_items').where({ folio_id: folioId, type: 'refund' }).whereNull('voided_at');
  const sweepOne = async (intentId, now = later()) => (await runRefundReconciliationSweep(now)).find((r) => String(r.paymentId) === String(intentId));

  describe('the sweep settles from Paystack\'s own record', () => {
    it('a PENDING refund Paystack has processed: CAPTURED, the folio refund line posted, the original REFUNDED, balance exact', async () => {
      const { folioId, payment, intent } = await pendingRefund();
      adapter.fetchRefund.mockResolvedValue({ status: 'processed', refundId: intent.provider_payment_id });
      const result = await sweepOne(intent.id);
      expect(result).toMatchObject({ skipped: false, result: 'processed', applied: true });
      expect((await row(intent.id)).status).toBe('CAPTURED');
      expect((await row(payment.id)).status).toBe('REFUNDED');
      expect(await refundLines(folioId)).toHaveLength(1);
      expect(await storedBalance(folioId)).toBe(await ledgerBalance(folioId));
      const audit = await db()('audit_log').where({ entity_type: 'payments', entity_id: intent.id, action: 'refund_reconciled' }).first();
      expect(audit).toBeDefined();
    });

    it('a partial refund Paystack has processed: PARTIALLY_REFUNDED', async () => {
      const ctx = await paystackPayment();
      adapter.refundTransaction.mockResolvedValueOnce({ status: 'pending', refundId: 'RP1' });
      const intent = await refund(ctx.payment.id, { amount: '30.00' });
      adapter.fetchRefund.mockResolvedValue({ status: 'processed', refundId: 'RP1' });
      await sweepOne(intent.id);
      expect((await row(ctx.payment.id)).status).toBe('PARTIALLY_REFUNDED');
      expect(sumMoney((await refundLines(ctx.folioId)).map((l) => l.amount))).toBe('30.00');
    });

    it.each(['failed', 'reversed'])('a refund Paystack reports %s: FAILED, the amount is released, the key is free, a manager is told', async (status) => {
      const { payment, intent } = await pendingRefund();
      adapter.fetchRefund.mockResolvedValue({ status, refundId: intent.provider_payment_id });
      const result = await sweepOne(intent.id);
      expect(result).toMatchObject({ result: 'failed', applied: true });
      const after = await row(intent.id);
      expect(after.status).toBe('FAILED');
      expect(after.idempotency_key).toMatch(/~failed-/);
      expect((await row(payment.id)).status).toBe('CAPTURED'); // untouched: the guest was not repaid
      expect(await db()('folio_line_items').where({ payment_id: intent.id })).toHaveLength(0);
      // The reserved amount is free again: the same refund can be sent.
      adapter.refundTransaction.mockResolvedValueOnce({ status: 'processed', refundId: 'again' });
      expect((await refund(payment.id)).status).toBe('CAPTURED');
      const alert = await db()('in_app_notifications').where({ tenant_id: t.tenantId }).andWhere('dedup_key', `refund-attention:${intent.id}:failed`).first();
      expect(alert).toBeUndefined(); // no manager exists on this fixture tenant; the alert is addressed by role, so nobody to hold it
    });

    it('still pending at Paystack: left alone, the amount stays reserved, the check is recorded', async () => {
      const { payment, intent } = await pendingRefund();
      adapter.fetchRefund.mockResolvedValue({ status: 'processing', refundId: intent.provider_payment_id });
      await sweepOne(intent.id);
      expect((await row(intent.id)).status).toBe('PENDING');
      expect(await recon(intent.id)).toMatchObject({ attempts: 1, last_result: 'pending' });
      await expect(refund(payment.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE_REFUND_EXCEEDS_CAPTURED_AMOUNT' });
    });

    it('Paystack cannot be reached: nothing is released, the check is recorded as unreachable', async () => {
      const { payment, intent } = await pendingRefund();
      adapter.fetchRefund.mockRejectedValue(new paystack.GatewayRequestError('paystack', 'connection reset', { network: true }));
      await sweepOne(intent.id);
      expect((await row(intent.id)).status).toBe('PENDING');
      expect(await recon(intent.id)).toMatchObject({ attempts: 1, last_result: 'unreachable' });
      await expect(refund(payment.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE_REFUND_EXCEEDS_CAPTURED_AMOUNT' });
    });

    it('an unrecognised Paystack status is not a decision: nothing changes', async () => {
      const { intent } = await pendingRefund();
      adapter.fetchRefund.mockResolvedValue({ status: 'quantum', refundId: intent.provider_payment_id });
      await sweepOne(intent.id);
      expect((await row(intent.id)).status).toBe('PENDING');
      expect(await recon(intent.id)).toMatchObject({ last_result: 'ambiguous' });
    });

    it('a refund younger than the minimum age is not touched', async () => {
      const { intent } = await pendingRefund();
      adapter.fetchRefund.mockResolvedValue({ status: 'processed', refundId: intent.provider_payment_id });
      expect(await sweepOne(intent.id, new Date())).toBeUndefined();
      expect((await row(intent.id)).status).toBe('PENDING');
    });

    it('a supermarket online refund is left to its own sweep', async () => {
      const { intent } = await pendingRefund();
      await db()('payments').where({ id: intent.id }).update({ settlement_target: 'supermarket_sale' });
      adapter.fetchRefund.mockResolvedValue({ status: 'processed', refundId: intent.provider_payment_id });
      expect(await sweepOne(intent.id)).toBeUndefined();
      expect((await row(intent.id)).status).toBe('PENDING');
    });

    it('a tenant being purged is skipped', async () => {
      const { intent } = await pendingRefund();
      await db()('tenants').where({ id: t.tenantId }).update({ status: 'purging' });
      try {
        adapter.fetchRefund.mockResolvedValue({ status: 'processed', refundId: intent.provider_payment_id });
        expect(await sweepOne(intent.id)).toBeUndefined();
      } finally {
        await db()('tenants').where({ id: t.tenantId }).update({ status: 'active' });
      }
    });
  });

  describe('an outcome-unknown refund (no refund id) is found among the transaction\'s refunds', () => {
    const listing = (intent, payment, overrides = {}) => ({
      refundId: 'L1',
      status: 'processed',
      amountSubunit: Number(intent.amount.replace('.', '')),
      createdAt: new Date().toISOString(),
      ...overrides,
    });

    it('exactly one matching refund, processed: applied, and its id recorded', async () => {
      const { folioId, payment, intent } = await unknownRefund();
      adapter.listRefundsForTransaction.mockResolvedValue([listing(intent, payment)]);
      await sweepOne(intent.id);
      const after = await row(intent.id);
      expect(after.status).toBe('CAPTURED');
      expect(after.provider_payment_id).toBe('L1');
      expect(await refundLines(folioId)).toHaveLength(1);
      expect(adapter.listRefundsForTransaction).toHaveBeenCalledWith({ transactionId: payment.provider_payment_id });
    });

    it('no refund of that amount at Paystack: NOT released (the listing may lag) — recorded as not_found', async () => {
      const { payment, intent } = await unknownRefund();
      adapter.listRefundsForTransaction.mockResolvedValue([]);
      await sweepOne(intent.id);
      expect((await row(intent.id)).status).toBe('PENDING');
      expect(await recon(intent.id)).toMatchObject({ last_result: 'not_found' });
      await expect(refund(payment.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE_REFUND_EXCEEDS_CAPTURED_AMOUNT' });
    });

    it('two possible refunds of the same amount: ambiguous, nothing decided', async () => {
      const { payment, intent } = await unknownRefund();
      adapter.listRefundsForTransaction.mockResolvedValue([listing(intent, payment, { refundId: 'A' }), listing(intent, payment, { refundId: 'B' })]);
      await sweepOne(intent.id);
      expect((await row(intent.id)).status).toBe('PENDING');
      expect(await recon(intent.id)).toMatchObject({ last_result: 'ambiguous' });
    });

    it('a refund already claimed by another local refund, or older than the intent, is not a match', async () => {
      const { payment, intent } = await unknownRefund();
      adapter.listRefundsForTransaction.mockResolvedValue([listing(intent, payment, { createdAt: new Date(Date.now() - 3_600_000).toISOString() })]);
      await sweepOne(intent.id);
      expect(await recon(intent.id)).toMatchObject({ last_result: 'not_found' });
      expect((await row(intent.id)).status).toBe('PENDING');
    });

    it('two local refunds of the same amount waiting, one listed: ambiguous (cannot tell which)', async () => {
      const first = await unknownRefund();
      // A second same-amount intent on the same original, inserted directly (the service would refuse to over-refund).
      await db()('payments').where({ id: first.intent.id }).update({ amount: '40.00' });
      const [secondId] = await db()('payments').insert({
        tenant_id: t.tenantId, property_id: t.propertyId, folio_id: first.folioId, idempotency_key: key(), provider: 'paystack',
        provider_reference: `rr-second-${n}`, amount: '40.00', currency: 'NGN', status: 'PENDING', parent_payment_id: first.payment.id,
      });
      adapter.listRefundsForTransaction.mockResolvedValue([{ refundId: 'ONLY', status: 'processed', amountSubunit: 4000, createdAt: new Date().toISOString() }]);
      await sweepOne(first.intent.id);
      expect((await row(first.intent.id)).status).toBe('PENDING');
      expect(await recon(first.intent.id)).toMatchObject({ last_result: 'ambiguous' });
      await db()('refund_reconciliations').where({ payment_id: secondId }).delete();
      await db()('payments').where({ id: secondId }).delete();
    });
  });

  describe('the same refund is applied once, whoever sees it', () => {
    async function deliver(payment, intent, eventId, type = 'refund.processed') {
      adapter.verifyWebhookSignature.mockReturnValue(true);
      const body = { event: type, data: { id: eventId, transaction_reference: payment.provider_reference } };
      return service.handlePaystackWebhook({ rawBody: JSON.stringify(body), signatureHeader: 'mocked', parsedBody: body });
    }

    it('a refund.processed webhook is a hint: Paystack is asked, then the refund is applied', async () => {
      const { folioId, payment, intent } = await pendingRefund();
      adapter.fetchRefund.mockResolvedValue({ status: 'processed', refundId: intent.provider_payment_id });
      await deliver(payment, intent, intent.provider_payment_id);
      expect(adapter.fetchRefund).toHaveBeenCalled();
      expect((await row(intent.id)).status).toBe('CAPTURED');
      expect(await refundLines(folioId)).toHaveLength(1);
    });

    it('a webhook claiming "processed" while Paystack\'s record says otherwise changes nothing', async () => {
      const { payment, intent } = await pendingRefund();
      adapter.fetchRefund.mockResolvedValue({ status: 'pending', refundId: intent.provider_payment_id });
      await deliver(payment, intent, intent.provider_payment_id);
      expect((await row(intent.id)).status).toBe('PENDING');
    });

    it('a refund webhook for nothing in flight is ignored', async () => {
      const ctx = await paystackPayment();
      await deliver(ctx.payment, {}, '424242');
      const event = await db()('payment_webhook_events').where({ provider_event_id: 'refund.processed:424242' }).first();
      expect(event.outcome).toBe('ignored');
      await db()('payment_webhook_events').where({ id: event.id }).delete();
    });

    it('webhook and sweep racing on real connections: exactly one folio refund line, one reconciliation audit row', async () => {
      for (let round = 0; round < 4; round += 1) {
        const { folioId, payment, intent } = await pendingRefund();
        adapter.fetchRefund.mockImplementation(async () => {
          await sleep(60);
          return { status: 'processed', refundId: intent.provider_payment_id };
        });
        const results = await Promise.allSettled([deliver(payment, intent, `${intent.provider_payment_id}`), runRefundReconciliationSweep(later())]);
        expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
        expect((await row(intent.id)).status).toBe('CAPTURED');
        expect(await refundLines(folioId)).toHaveLength(1);
        expect(await db()('audit_log').where({ entity_type: 'payments', entity_id: intent.id, action: 'refund_reconciled' })).toHaveLength(1);
        expect(await storedBalance(folioId)).toBe(await ledgerBalance(folioId));
        expect((await row(payment.id)).status).toBe('REFUNDED');
      }
    });

    it('two sweeps (overlapping ticks) and two webhooks at once: still once', async () => {
      const { folioId, payment, intent } = await pendingRefund();
      adapter.fetchRefund.mockImplementation(async () => {
        await sleep(40);
        return { status: 'processed', refundId: intent.provider_payment_id };
      });
      await Promise.allSettled([
        runRefundReconciliationSweep(later()),
        runRefundReconciliationSweep(later()),
        deliver(payment, intent, intent.provider_payment_id, 'refund.processed'),
        deliver(payment, intent, intent.provider_payment_id, 'refund.pending'),
      ]);
      expect(await refundLines(folioId)).toHaveLength(1);
      expect(await storedBalance(folioId)).toBe(await ledgerBalance(folioId));
    });

    it('a sweep that settles the refund while the refund call itself is still waiting: the late answer changes nothing', async () => {
      const ctx = await paystackPayment();
      // The refund call answers slowly; meanwhile the sweep (told it is 10 minutes later) finds the refund at Paystack.
      adapter.refundTransaction.mockImplementation(async () => {
        await sleep(400);
        return { status: 'processed', refundId: 'SLOW' };
      });
      adapter.listRefundsForTransaction.mockResolvedValue([{ refundId: 'SLOW', status: 'processed', amountSubunit: Number(ctx.payment.amount.replace('.', '')), createdAt: new Date().toISOString() }]);
      const call = refund(ctx.payment.id);
      await sleep(150);
      const [, called] = await Promise.all([runRefundReconciliationSweep(later()), call]);
      expect(called.status).toBe('CAPTURED');
      expect(await refundLines(ctx.folioId)).toHaveLength(1);
      expect(await storedBalance(ctx.folioId)).toBe(await ledgerBalance(ctx.folioId));
    });

    it('a definitive refusal arriving after a sweep already settled the refund does not walk it back', async () => {
      const ctx = await paystackPayment();
      adapter.refundTransaction.mockImplementation(async () => {
        await sleep(300);
        throw new paystack.GatewayRequestError('paystack', 'Transaction not found', { httpStatus: 404 });
      });
      adapter.listRefundsForTransaction.mockResolvedValue([{ refundId: 'RACE', status: 'processed', amountSubunit: Number(ctx.payment.amount.replace('.', '')), createdAt: new Date().toISOString() }]);
      const call = refund(ctx.payment.id);
      await sleep(120);
      await runRefundReconciliationSweep(later());
      await expect(call).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_ERROR' });
      const intent = await db()('payments').where({ parent_payment_id: ctx.payment.id }).first();
      expect(intent.status).toBe('CAPTURED');
    });
  });

  describe('locking', () => {
    it('settling a refund waits for the refunded payment\'s row lock, then applies once', async () => {
      const { folioId, payment, intent } = await pendingRefund();
      adapter.fetchRefund.mockResolvedValue({ status: 'processed', refundId: intent.provider_payment_id });
      const holder = await db().transaction();
      try {
        await holder('payments').where({ id: payment.id }).forUpdate().first(); // another request holds the payment
        let finished = false;
        const running = service.reconcileRefundIntent({ context: t.context, intentId: intent.id, source: 'sweep' }).then((r) => {
          finished = true;
          return r;
        });
        await sleep(500);
        expect(finished).toBe(false); // it is queued behind the lock, not racing past it
        expect((await row(intent.id)).status).toBe('PENDING');
        await holder.commit();
        const result = await running;
        expect(result).toMatchObject({ result: 'processed', applied: true });
      } finally {
        if (!holder.isCompleted()) await holder.rollback();
      }
      expect(await refundLines(folioId)).toHaveLength(1);
    });

    it('settleRefundIntent re-reads the intent UNDER the lock: one that another request claimed meanwhile is not applied again', async () => {
      const { folioId, intent } = await pendingRefund();
      const holder = await db().transaction();
      try {
        // Another request has the intent and has just claimed it (not yet committed).
        await holder('payments').where({ id: intent.id }).forUpdate().first();
        await holder('payments').where({ id: intent.id }).update({ status: 'CAPTURED', captured_at: new Date() });
        const running = inTx((trx) => service.settleRefundIntent({ trx, intentId: intent.id, outcome: 'processed', refundId: intent.provider_payment_id }));
        await sleep(400);
        await holder.commit();
        expect((await running).applied).toBe(false);
      } finally {
        if (!holder.isCompleted()) await holder.rollback();
      }
      expect(await refundLines(folioId)).toHaveLength(0);
    });

    it('a supermarket online refund is never reconciled here, however it is reached', async () => {
      const { intent } = await pendingRefund();
      await db()('payments').where({ id: intent.id }).update({ settlement_target: 'supermarket_sale' });
      adapter.fetchRefund.mockResolvedValue({ status: 'processed', refundId: intent.provider_payment_id });
      const result = await service.reconcileRefundIntent({ context: t.context, intentId: intent.id, source: 'webhook' });
      expect(result.skipped).toBe(true);
      expect((await row(intent.id)).status).toBe('PENDING');
    });
  });

  describe('late errors from the refund call', () => {
    it('a timeout arriving after a sweep already settled the refund does not walk it back to "unknown"', async () => {
      const ctx = await paystackPayment();
      adapter.refundTransaction.mockImplementation(async () => {
        await sleep(300);
        throw new paystack.GatewayRequestError('paystack', 'the request timed out', { timedOut: true });
      });
      adapter.listRefundsForTransaction.mockResolvedValue([{ refundId: 'TO1', status: 'processed', amountSubunit: Number(ctx.payment.amount.replace('.', '')), createdAt: new Date().toISOString() }]);
      const call = refund(ctx.payment.id);
      await sleep(120);
      await runRefundReconciliationSweep(later());
      await expect(call).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_ERROR' });
      const intent = await db()('payments').where({ parent_payment_id: ctx.payment.id }).first();
      expect(intent.status).toBe('CAPTURED');
      expect(intent.failure_reason).toBeNull();
      expect(await db()('audit_log').where({ entity_type: 'payments', entity_id: intent.id, action: 'refund_outcome_unknown' })).toHaveLength(0);
    });

    it('a refund Paystack lists that another local refund already claimed is not matched again', async () => {
      const { payment, intent } = await unknownRefund();
      // Another refund of the same payment (a different amount) already holds Paystack refund L9.
      await db()('payments').insert({
        tenant_id: t.tenantId, property_id: t.propertyId, folio_id: payment.folio_id, idempotency_key: key(), provider: 'paystack',
        provider_reference: `rr-claimed-${n}`, provider_payment_id: 'L9', amount: intent.amount, currency: 'NGN', status: 'CAPTURED', parent_payment_id: payment.id,
      });
      adapter.listRefundsForTransaction.mockResolvedValue([{ refundId: 'L9', status: 'processed', amountSubunit: Number(intent.amount.replace('.', '')), createdAt: new Date().toISOString() }]);
      await sweepOne(intent.id);
      expect((await row(intent.id)).status).toBe('PENDING');
      expect(await recon(intent.id)).toMatchObject({ last_result: 'not_found' });
    });
  });

  describe('stuck refunds and the clear action', () => {
    const ageIntent = (id, minutes) => db()('payments').where({ id }).update({ created_at: new Date(Date.now() - minutes * 60_000) });
    const checkUnreachable = async (intent, times) => {
      adapter.fetchRefund.mockRejectedValue(new paystack.GatewayRequestError('paystack', 'down', { network: true }));
      for (let i = 0; i < times; i += 1) {
        await db()('refund_reconciliations').where({ payment_id: intent.id }).update({ last_checked_at: new Date(Date.now() - 3_600_000) });
        await sweepOne(intent.id, new Date(Date.now() + (i + 1) * 3_600_000));
      }
    };
    const clear = (paymentId, extra = {}) => service.clearStuckRefund({ context: t.context, paymentId, reason: 'checked with the acquirer: never sent', userId: null, ...extra });

    it('refused until reconciliation has checked enough times', async () => {
      const { intent } = await pendingRefund();
      await ageIntent(intent.id, 120);
      await checkUnreachable(intent, 2);
      await expect(clear(intent.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE_REFUND_NOT_STUCK' });
      expect((await row(intent.id)).status).toBe('PENDING');
    });

    it('refused while the refund is too recent, even after enough checks', async () => {
      const { intent } = await pendingRefund();
      await checkUnreachable(intent, 3);
      await expect(clear(intent.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE_REFUND_NOT_STUCK' });
    });

    it('refused when the last answer from Paystack was "still pending" (Paystack has it)', async () => {
      const { intent } = await pendingRefund();
      await ageIntent(intent.id, 120);
      adapter.fetchRefund.mockResolvedValue({ status: 'pending', refundId: intent.provider_payment_id });
      for (let i = 0; i < 3; i += 1) {
        await db()('refund_reconciliations').where({ payment_id: intent.id }).update({ last_checked_at: new Date(Date.now() - 3_600_000) });
        await sweepOne(intent.id, new Date(Date.now() + (i + 1) * 3_600_000));
      }
      await expect(clear(intent.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE_REFUND_NOT_STUCK' });
    });

    it('after 3 failed checks and 30+ minutes: cleared — FAILED, the amount released, the key free, audited with the reason', async () => {
      const { payment, intent } = await pendingRefund();
      await ageIntent(intent.id, 120);
      await checkUnreachable(intent, 3);
      const approve = jest.fn();
      const result = await clear(intent.id, { approve });
      expect(result.cleared).toBe(true);
      expect(approve).toHaveBeenCalledTimes(1);
      const after = await row(intent.id);
      expect(after.status).toBe('FAILED');
      expect(after.failure_reason).toMatch(/Cleared by a manager/);
      expect(after.idempotency_key).toMatch(/~failed-/);
      expect(await recon(intent.id)).toMatchObject({ last_result: 'cleared' });
      const audit = await db()('audit_log').where({ entity_type: 'payments', entity_id: intent.id, action: 'refund_stuck_cleared' }).first();
      expect(audit.reason).toBe('checked with the acquirer: never sent');
      adapter.refundTransaction.mockResolvedValueOnce({ status: 'processed', refundId: 'fresh' });
      expect((await refund(payment.id)).status).toBe('CAPTURED');
    });

    it('a reason is mandatory', async () => {
      const { intent } = await pendingRefund();
      await expect(service.clearStuckRefund({ context: t.context, paymentId: intent.id, reason: '  ', userId: null })).rejects.toMatchObject({ code: 'VALIDATION_MISSING_FIELD' });
    });

    it('if Paystack turns out to have processed it, clearing APPLIES the refund instead (never a double refund)', async () => {
      const { folioId, payment, intent } = await pendingRefund();
      await ageIntent(intent.id, 120);
      await checkUnreachable(intent, 3);
      adapter.fetchRefund.mockReset();
      adapter.fetchRefund.mockResolvedValue({ status: 'processed', refundId: intent.provider_payment_id });
      const approve = jest.fn();
      const result = await clear(intent.id, { approve });
      expect(result).toMatchObject({ cleared: false, resolved: 'processed' });
      expect(approve).not.toHaveBeenCalled();
      expect((await row(intent.id)).status).toBe('CAPTURED');
      expect((await row(payment.id)).status).toBe('REFUNDED');
      expect(await refundLines(folioId)).toHaveLength(1);
    });

    it('if Paystack now says it is pending, clearing is refused', async () => {
      const { intent } = await pendingRefund();
      await ageIntent(intent.id, 120);
      await checkUnreachable(intent, 3);
      adapter.fetchRefund.mockReset();
      adapter.fetchRefund.mockResolvedValue({ status: 'pending', refundId: intent.provider_payment_id });
      await expect(clear(intent.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE_REFUND_NOT_STUCK' });
      expect((await row(intent.id)).status).toBe('PENDING');
    });

    it('clear racing a sweep that finds the refund processed: applied once, never both cleared and refunded', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { folioId, intent } = await pendingRefund();
        await ageIntent(intent.id, 120);
        await checkUnreachable(intent, 3);
        adapter.fetchRefund.mockReset();
        adapter.fetchRefund.mockImplementation(async () => {
          await sleep(50);
          return { status: 'processed', refundId: intent.provider_payment_id };
        });
        const outcomes = await Promise.allSettled([clear(intent.id, { approve: jest.fn() }), runRefundReconciliationSweep(later())]);
        expect(outcomes.filter((o) => o.status === 'rejected' && !/NOT_STUCK/.test(String(o.reason?.code)))).toEqual([]);
        expect((await row(intent.id)).status).toBe('CAPTURED');
        expect(await refundLines(folioId)).toHaveLength(1);
      }
    });

    it('listing a folio\'s payments shows an in-flight refund\'s reconciliation, and only that row gains the field', async () => {
      const { folioId, intent } = await pendingRefund();
      await ageIntent(intent.id, 120);
      await checkUnreachable(intent, 3);
      const payments = await service.listPaymentsForFolio({ context: t.context, folioId });
      const stuck = payments.find((p) => String(p.id) === String(intent.id));
      expect(stuck.refundReconciliation).toMatchObject({ attempts: 3, lastResult: 'unreachable', canClear: true });
      expect(payments.filter((p) => p.refundReconciliation)).toHaveLength(1);
    });
  });
});
