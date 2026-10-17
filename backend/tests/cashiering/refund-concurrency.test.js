'use strict';

/**
 * F-04 (product audit): over-refund race, real pooled connections. Different Idempotency-Keys on purpose: a double
 * click after a page refresh, or two cashiers, each send their own key, so the idempotency layer cannot help.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { refundTransaction: jest.fn(), verifyTransaction: jest.fn() };
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
const { seedRaceTenant, ledgerBalance, storedBalance } = require('../helpers/folio-race');

describe('refunds under real concurrent connections (F-04)', () => {
  let t;
  let n = 0;
  const key = () => `rf-key-${Date.now().toString(36)}-${(n += 1)}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    t = await seedRaceTenant({ label: 'refund' });
  });
  beforeEach(() => {
    adapter.refundTransaction.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => console.error.mockRestore());
  afterAll(async () => {
    await t.cleanup();
    dbModule.__resetForTesting();
  });

  const inTx = (fn) => scopedDb().for(t.context).transaction(fn);

  /** A folio carrying one captured payment of `amount` (cash | terminal | paystack). */
  async function paidFolio(provider, amount = '100.00') {
    const { folioId } = await t.addReservationWithFolio();
    await inTx((trx) => service.postCharge({ trx, folioId, type: 'pos_charge', description: 'c', amount, userId: null }));
    const owed = await storedBalance(folioId);
    let payment;
    if (provider === 'cash') payment = await inTx((trx) => service.captureCashPayment({ trx, folioId, amount: owed, currency: 'NGN', idempotencyKey: key(), userId: null }));
    else if (provider === 'terminal') payment = await inTx((trx) => service.captureTerminalPayment({ trx, folioId, amount: owed, currency: 'NGN', idempotencyKey: key(), userId: null }));
    else {
      const [id] = await db()('payments').insert({
        tenant_id: t.tenantId,
        property_id: t.propertyId,
        folio_id: folioId,
        idempotency_key: key(),
        provider: 'paystack',
        provider_reference: `ps-${Date.now().toString(36)}-${(n += 1)}`,
        amount: owed,
        currency: 'NGN',
        status: 'CAPTURED',
        captured_at: new Date(),
      });
      await db()('folio_line_items').insert({ tenant_id: t.tenantId, property_id: t.propertyId, folio_id: folioId, type: 'payment', description: 'Paystack payment', amount: `-${owed}`, currency: 'NGN', payment_method: 'paystack', payment_id: id, business_date: '2027-06-01' });
      await inTx((trx) => service.recomputeFolioBalance({ trx, folioId }));
      payment = await db()('payments').where({ id }).first();
    }
    return { folioId, payment };
  }

  const refund = (paymentId, extra = {}) =>
    service.refundPayment({ context: t.context, paymentId, reason: 'test', idempotencyKey: key(), userId: null, ...extra });

  async function refundedTotal(paymentId, statuses = ['CAPTURED']) {
    const rows = await db()('payments').where({ parent_payment_id: paymentId }).whereIn('status', statuses);
    return sumMoney(rows.map((r) => r.amount));
  }

  describe.each(['cash', 'terminal'])('%s', (provider) => {
    it('two simultaneous full refunds with different keys: exactly one succeeds, never more refunded than captured', async () => {
      for (let round = 0; round < 5; round += 1) {
        const { folioId, payment } = await paidFolio(provider);
        const results = await Promise.allSettled([refund(payment.id), refund(payment.id)]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await refundedTotal(payment.id)).toBe('100.00');
        expect(await storedBalance(folioId)).toBe(await ledgerBalance(folioId));
        expect((await db()('payments').where({ id: payment.id }).first()).status).toBe('REFUNDED');
      }
    });

    it('two simultaneous partial refunds that together exceed the payment: the total never exceeds it', async () => {
      const { payment } = await paidFolio(provider);
      const results = await Promise.allSettled([refund(payment.id, { amount: '70.00' }), refund(payment.id, { amount: '70.00' })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await refundedTotal(payment.id)).toBe('70.00');
      expect((await db()('payments').where({ id: payment.id }).first()).status).toBe('PARTIALLY_REFUNDED');
    });
  });

  describe('paystack', () => {
    it('two simultaneous refunds: the gateway is asked exactly once', async () => {
      adapter.refundTransaction.mockImplementation(async () => {
        await sleep(150);
        return { status: 'processed', refundId: '1' };
      });
      const { folioId, payment } = await paidFolio('paystack');
      const results = await Promise.allSettled([refund(payment.id), refund(payment.id)]);
      expect(adapter.refundTransaction).toHaveBeenCalledTimes(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await refundedTotal(payment.id)).toBe('100.00');
      expect(await storedBalance(folioId)).toBe(await ledgerBalance(folioId));
    });

    it('the SAME Idempotency-Key sent twice at once: the gateway is asked exactly once', async () => {
      adapter.refundTransaction.mockImplementation(async () => {
        await sleep(150);
        return { status: 'processed', refundId: '1' };
      });
      const { payment } = await paidFolio('paystack');
      const sameKey = key();
      await Promise.allSettled([refund(payment.id, { idempotencyKey: sameKey }), refund(payment.id, { idempotencyKey: sameKey })]);
      expect(adapter.refundTransaction).toHaveBeenCalledTimes(1);
    });

    it('a refund Paystack accepted but has not processed still reserves its amount: a second full refund is refused', async () => {
      adapter.refundTransaction.mockResolvedValue({ status: 'pending', refundId: '9' });
      const { payment } = await paidFolio('paystack');
      const first = await refund(payment.id);
      expect(first.status).toBe('PENDING');
      await expect(refund(payment.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE_REFUND_EXCEEDS_CAPTURED_AMOUNT' });
      expect(adapter.refundTransaction).toHaveBeenCalledTimes(1);
    });

    it('a definitive refusal by Paystack (HTTP 4xx) marks the intent FAILED and releases the reserved amount', async () => {
      adapter.refundTransaction.mockRejectedValueOnce(new paystack.GatewayRequestError('paystack', 'Transaction not found', { httpStatus: 404 }));
      const { payment } = await paidFolio('paystack');
      const sameKey = key();
      await expect(refund(payment.id, { idempotencyKey: sameKey })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_ERROR' });
      const intents = await db()('payments').where({ parent_payment_id: payment.id });
      expect(intents.map((r) => r.status)).toEqual(['FAILED']);
      adapter.refundTransaction.mockResolvedValueOnce({ status: 'processed', refundId: '2' });
      // The retry reuses the SAME Idempotency-Key: the failed intent must not hold it.
      const retry = await refund(payment.id, { idempotencyKey: sameKey });
      expect(retry.status).toBe('CAPTURED');
    });

    it.each([
      ['a timeout', { timedOut: true }],
      ['a network error', { network: true }],
      ['an HTTP 502', { httpStatus: 502 }],
    ])('%s (outcome unknown): the amount STAYS reserved, the intent is flagged for reconciliation, and a retry is refused', async (_name, details) => {
      adapter.refundTransaction.mockRejectedValueOnce(new paystack.GatewayRequestError('paystack', 'unknown', details));
      const { payment } = await paidFolio('paystack');
      await expect(refund(payment.id)).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_ERROR' });
      const intents = await db()('payments').where({ parent_payment_id: payment.id });
      expect(intents).toHaveLength(1);
      expect(intents[0].status).toBe('PENDING');
      expect(intents[0].failure_reason).toMatch(/reconcil/i);
      const audit = await db()('audit_log').where({ entity_type: 'payments', entity_id: intents[0].id, action: 'refund_outcome_unknown' }).first();
      expect(audit).toBeDefined();
      await expect(refund(payment.id)).rejects.toMatchObject({ code: 'BUSINESS_RULE_REFUND_EXCEEDS_CAPTURED_AMOUNT' });
      expect(adapter.refundTransaction).toHaveBeenCalledTimes(1);
    });
  });

  it('lock order: refunds racing charges and payments on the same folio never deadlock and the balance stays exact', async () => {
    const codes = [];
    for (let round = 0; round < 4; round += 1) {
      const { folioId, payment } = await paidFolio('cash');
      const results = await Promise.allSettled([
        refund(payment.id, { amount: '40.00' }),
        refund(payment.id, { amount: '40.00' }),
        inTx((trx) => service.postCharge({ trx, folioId, type: 'pos_charge', description: 'x', amount: '5.00', userId: null })),
        inTx((trx) => service.captureCashPayment({ trx, folioId, amount: '3.00', currency: 'NGN', idempotencyKey: key(), userId: null })),
      ]);
      for (const r of results) if (r.status === 'rejected') codes.push(String(r.reason?.code ?? r.reason?.message));
      expect(await storedBalance(folioId)).toBe(await ledgerBalance(folioId));
    }
    expect(codes.filter((c) => /DEADLOCK/i.test(c))).toEqual([]);
  });
});
