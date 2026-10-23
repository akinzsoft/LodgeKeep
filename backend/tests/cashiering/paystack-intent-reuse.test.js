'use strict';

/**
 * Pressing Card / digital again on a folio must not add a new INITIATED row each time: an unpaid payment for the
 * same folio and amount (fresh, under 30 minutes) is reopened. The portal's own intent path is not affected.
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

describe('Folio card payment: pressing the button again reuses the unpaid payment', () => {
  const t = useTestApp();
  let ctx;
  let token;
  let counter = 0;
  const key = () => `reu-${Date.now().toString(36)}-${(counter += 1)}`;

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


  const url = (folioId) => `/cashiering/folios/${folioId}/payments/paystack`;
  const send = (folioId, amount = '1000.00') => post(url(folioId), { amount, currency: 'NGN', guest_email: 'g@example.com' });
  beforeEach(() => {
    paystack.initializeTransaction.mockReset();
    paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.com/ac_1', accessCode: 'ac_1' });
  });

  // Jest's sandbox lets strict-mode code assign to an undeclared variable (it creates a global) where Node throws
  // "ReferenceError: x is not defined". So these tests also check that the route leaves no stray global behind.
  const strayGlobals = () => ['reused', 'deposit', 'resolved'].filter((name) => Object.prototype.hasOwnProperty.call(globalThis, name));
  beforeEach(() => {
    delete globalThis.reused;
  });

  it('first press, nothing to reuse: one new INITIATED->PENDING payment, the shape the launcher reads, and no stray globals', async () => {
    const folioId = await folioWithBalance('1000.00');
    const res = await send(folioId);
    expect(res.status).toBe(201);
    // The frontend flattens `data` and `meta`: it needs id, status, accessCode and authorizationUrl.
    expect(res.body.data).toEqual(expect.objectContaining({ id: expect.anything(), status: 'PENDING', amount: '1000.00' }));
    expect(res.body.data).not.toHaveProperty('reused');
    expect(res.body.meta).toEqual({ authorizationUrl: 'https://checkout.paystack.com/ac_1', accessCode: 'ac_1' });
    expect(await paymentCount(folioId)).toBe(1);
    const audits = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: res.body.data.id });
    expect(audits.map((a) => a.action).sort()).toEqual(['initiate_paystack_payment', 'start_checkout']);
    expect(strayGlobals()).toEqual([]);
  });

  it('the reuse path has the same response shape and leaves no stray globals', async () => {
    const folioId = await folioWithBalance('1000.00');
    const first = await send(folioId);
    const again = await send(folioId);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.body.data).not.toHaveProperty('reused');
    expect(again.body.meta).toEqual({ authorizationUrl: 'https://checkout.paystack.com/ac_1', accessCode: 'ac_1' });
    expect(strayGlobals()).toEqual([]);
  });

  it('retrying the SAME idempotency key (a stored replay) works and does not touch Paystack again', async () => {
    const folioId = await folioWithBalance('1000.00');
    const sameKey = () => t.request.post(`/api/v1${url(folioId)}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'reu-fixed-key-1').send({ amount: '1000.00', currency: 'NGN', guest_email: 'g@example.com' });
    const first = await sameKey();
    delete globalThis.reused;
    const replay = await sameKey();
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await paymentCount(folioId)).toBe(1);
    expect(strayGlobals()).toEqual([]);
  });

  it('a second press with a NEW idempotency key reuses the pending payment: one row, the same Paystack transaction', async () => {
    const folioId = await folioWithBalance('1000.00');
    const first = await send(folioId);
    expect(first.status).toBe(201);
    const second = await send(folioId);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await paymentCount(folioId)).toBe(1);
    // Paystack was asked once; the second answer is the stored access code and the hosted page for it.
    expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
    expect(second.body.meta.accessCode).toBe('ac_1');
    expect(second.body.meta.authorizationUrl).toBe('https://checkout.paystack.com/ac_1');
    // Only the first press is audited as an initiation.
    const audits = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: first.body.data.id, action: 'initiate_paystack_payment' });
    expect(audits).toHaveLength(1);
  });

  it('also reuses a payment that never reached Paystack (still INITIATED)', async () => {
    const folioId = await folioWithBalance('1000.00');
    paystack.initializeTransaction.mockRejectedValueOnce(new Error('network down'));
    const failed = await send(folioId);
    expect(failed.status).toBe(202);
    const retry = await send(folioId);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(failed.body.data.id);
    expect(await paymentCount(folioId)).toBe(1);
  });

  it('a different amount, another folio, a finished payment or an old one gets its own row', async () => {
    const folioId = await folioWithBalance('1000.00');
    const base = await send(folioId, '1000.00');
    const other = await send(folioId, '500.00');
    expect(other.body.data.id).not.toBe(base.body.data.id);

    const otherFolio = await folioWithBalance('1000.00');
    expect((await send(otherFolio)).body.data.id).not.toBe(base.body.data.id);

    await t.trx('payments').where({ id: base.body.data.id }).update({ status: 'FAILED' });
    const afterFail = await send(folioId, '1000.00');
    expect(afterFail.body.data.id).not.toBe(base.body.data.id);

    await t.trx('payments').where({ id: afterFail.body.data.id }).update({ created_at: new Date(Date.now() - 31 * 60 * 1000) });
    const afterAge = await send(folioId, '1000.00');
    expect(afterAge.body.data.id).not.toBe(afterFail.body.data.id);
  });
});
