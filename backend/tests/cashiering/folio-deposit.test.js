'use strict';

/**
 * A guest DEPOSIT: paying more than the folio owes (or anything on a settled folio) leaves a credit (a negative
 * balance). And the amount validation every folio payment path now shares (`assertPaymentAmount`): positive, at most
 * 2 decimals, under the ceiling, the folio's currency. Before it, a NEGATIVE amount posted as a charge. The API is
 * driven directly throughout, since the screen's field is no longer the only guard.
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
  return { ...actual, __mockAdapter: mockAdapter, resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })) };
});

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { assertPaymentAmount } = require('../../src/shared/payment-amount');
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;

const BUSINESS_DATE = '2027-08-01';

describe('Guest deposits and folio payment amount validation', () => {
  const t = useTestApp();
  let ctx;
  let token;
  let counter = 0;
  const key = () => `dep-${Date.now().toString(36)}-${(counter += 1)}`;

  const post = (url, body) => t.request.post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()).send(body ?? {});

  async function folioWithBalance(amount) {
    counter += 1;
    const [id] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      reservation_id: ctx.a.reservations[0].id,
      folio_number: `DP${String(counter).padStart(6, '0')}`,
      status: 'open',
      balance: amount,
      currency: 'NGN',
      billed_to: 'Deposit Guest',
    });
    if (amount !== '0.00') {
      await t.trx('folio_line_items').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        folio_id: id,
        type: 'adjustment',
        description: 'Test balance',
        amount,
        currency: 'NGN',
        business_date: BUSINESS_DATE,
      });
    }
    return id;
  }
  const balanceOf = async (folioId) => (await t.trx('folios').where({ id: folioId }).first('balance')).balance;
  const paymentCount = async (folioId) => Number((await t.trx('payments').where({ folio_id: folioId }).count({ n: '*' }).first()).n);

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
    const [userId] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `dep-cashier-${Date.now().toString(36)}@example.com`, first_name: 'Cash', last_name: 'Ier', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, user_id: userId, role: 'cashier' });
    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });
  });
  beforeEach(() => jest.clearAllMocks());

  describe('assertPaymentAmount', () => {
    it('accepts positive amounts with up to 2 decimals', () => {
      expect(assertPaymentAmount('50000')).toBe('50000');
      expect(assertPaymentAmount('0.01')).toBe('0.01');
      expect(assertPaymentAmount(120.5)).toBe('120.5');
      expect(assertPaymentAmount('10000000.00')).toBe('10000000.00');
    });
    it.each([[''], [null], [undefined], ['abc'], ['-5.00'], ['0'], ['0.00'], ['10.001'], ['1e3'], ['1,000'], ['10000000.01'], [{}], [[5]]])('rejects %p', (value) => {
      expect(() => assertPaymentAmount(value)).toThrow(/amount/);
    });
    it('honours MAX_PAYMENT_AMOUNT and ignores a garbage value', () => {
      process.env.MAX_PAYMENT_AMOUNT = '500.00';
      try {
        expect(() => assertPaymentAmount('500.01')).toThrow();
        expect(assertPaymentAmount('500.00')).toBe('500.00');
        process.env.MAX_PAYMENT_AMOUNT = 'lots';
        expect(assertPaymentAmount('9000000')).toBe('9000000');
        expect(() => assertPaymentAmount('10000001')).toThrow();
      } finally {
        delete process.env.MAX_PAYMENT_AMOUNT;
      }
    });
  });

  describe.each([['cash'], ['terminal']])('%s deposits', (method) => {
    const url = (folioId) => `/cashiering/folios/${folioId}/payments/${method}`;

    it('an overpayment is kept as a credit, and audited as a deposit', async () => {
      const folioId = await folioWithBalance('25000.00');
      const res = await post(url(folioId), { amount: '50000.00', currency: 'NGN' });
      expect(res.status).toBe(201);
      expect(await balanceOf(folioId)).toBe('-25000.00');
      const audit = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: res.body.data.id }).first();
      expect(JSON.parse(JSON.stringify(audit.after_state)).deposit).toBe(true);
    });

    it('a payment on a zero-balance folio is a pure advance deposit', async () => {
      const folioId = await folioWithBalance('0.00');
      expect((await post(url(folioId), { amount: '10000.00', currency: 'NGN' })).status).toBe(201);
      expect(await balanceOf(folioId)).toBe('-10000.00');
    });

    it('paying exactly the balance is not flagged as a deposit', async () => {
      const folioId = await folioWithBalance('300.00');
      const res = await post(url(folioId), { amount: '300.00', currency: 'NGN' });
      expect(res.status).toBe(201);
      expect(await balanceOf(folioId)).toBe('0.00');
      const audit = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: res.body.data.id }).first();
      expect(JSON.parse(JSON.stringify(audit.after_state)).deposit).toBeUndefined();
    });

    it.each([['-5000.00'], ['0.00'], ['0'], ['12.345'], ['abc'], ['10000000.01'], ['-0.01']])('direct API call with amount %p is refused and writes nothing', async (amount) => {
      const folioId = await folioWithBalance('100.00');
      const res = await post(url(folioId), { amount, currency: 'NGN' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_AMOUNT');
      expect(await balanceOf(folioId)).toBe('100.00');
      expect(await paymentCount(folioId)).toBe(0);
      expect(await t.trx('folio_line_items').where({ folio_id: folioId, type: 'payment' }).count({ n: '*' }).first().then((r) => Number(r.n))).toBe(0);
    });

    it('refuses a currency other than the folio\'s', async () => {
      const folioId = await folioWithBalance('100.00');
      const res = await post(url(folioId), { amount: '100.00', currency: 'USD' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_CURRENCY_MISMATCH');
      expect(await balanceOf(folioId)).toBe('100.00');
    });
  });

  describe('Paystack deposits', () => {
    const url = (folioId) => `/cashiering/folios/${folioId}/payments/paystack`;
    beforeEach(() => {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.com/x', accessCode: 'ac_1' });
    });

    it('starts a checkout for MORE than the balance, and for a zero-balance folio', async () => {
      const owing = await folioWithBalance('1000.00');
      const over = await post(url(owing), { amount: '5000.00', currency: 'NGN', guest_email: 'g@example.com' });
      expect(over.status).toBe(201);
      expect(over.body.data.amount).toBe('5000.00');
      expect(paystack.initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: '5000.00' }));
      const audit = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: over.body.data.id, action: 'initiate_paystack_payment' }).first();
      expect(JSON.parse(JSON.stringify(audit.after_state)).deposit).toBe(true);

      const zero = await folioWithBalance('0.00');
      expect((await post(url(zero), { amount: '2000.00', currency: 'NGN', guest_email: 'g@example.com' })).status).toBe(201);
    });

    it.each([['-100.00'], ['0.00'], ['1.999'], ['10000000.01']])('refuses amount %p before any payment row or gateway call', async (amount) => {
      const folioId = await folioWithBalance('100.00');
      const res = await post(url(folioId), { amount, currency: 'NGN', guest_email: 'g@example.com' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_AMOUNT');
      expect(await paymentCount(folioId)).toBe(0);
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    });

    it('refuses a currency other than the folio\'s', async () => {
      const folioId = await folioWithBalance('100.00');
      const res = await post(url(folioId), { amount: '100.00', currency: 'USD', guest_email: 'g@example.com' });
      expect(res.status).toBe(400);
      expect(await paymentCount(folioId)).toBe(0);
    });
  });

  describe('partial refund of a deposit', () => {
    it('refunds part of an overpayment, leaving the rest as credit, and refuses a bad or too-large amount', async () => {
      const folioId = await folioWithBalance('25000.00');
      const paid = (await post(`/cashiering/folios/${folioId}/payments/cash`, { amount: '50000.00', currency: 'NGN' })).body.data;
      expect(await balanceOf(folioId)).toBe('-25000.00');

      for (const bad of ['-10.00', '0', '5.555', 'x']) {
        const r = await post(`/cashiering/payments/${paid.id}/refund`, { amount: bad, reason: 'bad' });
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('VALIDATION_INVALID_AMOUNT');
      }
      expect((await post(`/cashiering/payments/${paid.id}/refund`, { amount: '50000.01', reason: 'too much' })).status).toBe(422);
      expect(await balanceOf(folioId)).toBe('-25000.00');

      const part = await post(`/cashiering/payments/${paid.id}/refund`, { amount: '20000.00', reason: 'Guest took part of the deposit back' });
      expect(part.status).toBe(201);
      expect(await balanceOf(folioId)).toBe('-5000.00');
      expect((await t.trx('payments').where({ id: paid.id }).first()).status).toBe('PARTIALLY_REFUNDED');

      const rest = await post(`/cashiering/payments/${paid.id}/refund`, { amount: '5000.00', reason: 'The leftover credit' });
      expect(rest.status).toBe(201);
      expect(await balanceOf(folioId)).toBe('0.00');
    });
  });
});
