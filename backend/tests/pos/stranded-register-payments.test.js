'use strict';

/**
 * Stranded Register card payments: Paystack captured the money but the tab never settled
 * (the cashier's settle call did not complete). The sweep alerts managers once per payment; the
 * Register banner lists them. Detection only: nothing is settled or refunded here.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { initializeTransaction: jest.fn(), verifyTransaction: jest.fn(), refundTransaction: jest.fn(), verifyWebhookSignature: jest.fn() };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })),
  };
});

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const { insertMenuItem } = require('../helpers/catalogue');
const { runStrandedRegisterPaymentSweep } = require('../../src/jobs/payment-webhooks');

const TYPE = 'payments.register_payment_unsettled';

describe('stranded Register card payments', () => {
  const t = useTestApp();
  let ctx;
  let token;
  let counter = 0;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-03-01' });
    const userId = ctx.a.users[1].id;
    const propertyId = ctx.a.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role: 'pos_operator' });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role: 'pos_operator' });
    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  });

  beforeEach(() => {
    jest.resetAllMocks();
    paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay', accessCode: 'acc', reference: 'r' });
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
  });

  const minutesAgo = (n) => new Date(Date.now() - n * 60_000);

  /** An open tab with a captured card payment, captured `capturedMinutesAgo` ago. */
  async function strandedTab(capturedMinutesAgo = 30) {
    counter += 1;
    const suffix = `${Date.now()}-${counter}`;
    const propertyId = ctx.a.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `ST-${suffix}`, name: 'Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `T-${suffix}` });
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Beer', category: 'Drinks', price: '20.00' });
    const auth = { Authorization: `Bearer ${token}` };
    const opened = await t.request.post('/api/v1/pos/orders').set(auth).send({ outlet_id: outletId, terminal_id: terminalId, table_label: `Table ${counter}` }).expect(201);
    const orderId = opened.body.data.id;
    await t.request.post(`/api/v1/pos/orders/${orderId}/items`).set(auth).send({ menu_item_id: menuItemId, quantity: 1 }).expect(200);
    const started = await t.request.post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).set(auth).set('Idempotency-Key', `st-${suffix}`).send({ tender: 'card' }).expect(201);
    const paymentId = started.body.data.id;
    await t.trx('payments').where({ id: paymentId }).update({ status: 'CAPTURED', captured_at: minutesAgo(capturedMinutesAgo) });
    return { orderId, paymentId, outletId };
  }

  const alertsFor = async (paymentId) =>
    t.trx('in_app_notifications').where({ type: TYPE, tenant_id: ctx.a.id }).andWhere('dedup_key', `register-captured-unsettled:${paymentId}`);

  const banner = async (outletId) => {
    const res = await t.request.get(`/api/v1/pos/stranded-payments?outlet_id=${outletId}`).set('Authorization', `Bearer ${token}`).expect(200);
    return res.body.data;
  };

  it('alerts managers exactly once for a stranded payment, however often the sweep runs', async () => {
    const { paymentId, orderId } = await strandedTab();

    await runStrandedRegisterPaymentSweep();
    const first = await alertsFor(paymentId);
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((row) => String(row.user_id))).toContain(String(ctx.a.users[0].id)); // the manager
    expect(first.map((row) => String(row.user_id))).not.toContain(String(ctx.a.users[1].id)); // not the pos operator
    const payload = typeof first[0].payload === 'string' ? JSON.parse(first[0].payload) : first[0].payload;
    expect(payload).toMatchObject({ paymentId: String(paymentId), orderId: String(orderId), amount: '23.00', currency: 'NGN' });

    await runStrandedRegisterPaymentSweep();
    await runStrandedRegisterPaymentSweep();
    expect((await alertsFor(paymentId)).length).toBe(first.length);
  });

  it('does not alert for a recent capture, a settled tab, a refunded payment or a pending one', async () => {
    const recent = await strandedTab(2);
    const settled = await strandedTab();
    const refunded = await strandedTab();
    const pending = await strandedTab();
    await t.request
      .post(`/api/v1/pos/orders/${settled.orderId}/settle`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `settle-${settled.paymentId}`)
      .send({ settlements: [{ method: 'card', payment_id: settled.paymentId }] })
      .expect(200);
    await t.trx('payments').where({ id: refunded.paymentId }).update({ status: 'REFUNDED' });
    await t.trx('payments').where({ id: pending.paymentId }).update({ status: 'PENDING', captured_at: null });

    await runStrandedRegisterPaymentSweep();

    for (const { paymentId } of [recent, settled, refunded, pending]) expect(await alertsFor(paymentId)).toHaveLength(0);
  });

  it('does not alert for a payment linked to a standing settlement even if the tab is still open, but does once that settlement is voided', async () => {
    const { orderId, paymentId, outletId } = await strandedTab();
    await t.request
      .post(`/api/v1/pos/orders/${orderId}/settle`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `settle-${paymentId}`)
      .send({ settlements: [{ method: 'card', payment_id: paymentId }] })
      .expect(200);
    // The tab is still open (for example another check on a split bill is unpaid).
    await t.trx('pos_orders').where({ id: orderId }).update({ status: 'open' });

    await runStrandedRegisterPaymentSweep();
    expect(await alertsFor(paymentId)).toHaveLength(0);
    expect(await banner(outletId)).toEqual([]);

    await t.trx('pos_order_settlements').where({ payment_id: paymentId }).update({ voided_at: new Date() });
    await runStrandedRegisterPaymentSweep();
    expect((await alertsFor(paymentId)).length).toBeGreaterThan(0);
    expect((await banner(outletId)).map((row) => String(row.id))).toEqual([String(paymentId)]);
  });

  it('a payment that becomes old enough is alerted on a later sweep', async () => {
    const { paymentId } = await strandedTab(2);
    await runStrandedRegisterPaymentSweep();
    expect(await alertsFor(paymentId)).toHaveLength(0);
    await t.trx('payments').where({ id: paymentId }).update({ captured_at: minutesAgo(20) });
    await runStrandedRegisterPaymentSweep();
    expect((await alertsFor(paymentId)).length).toBeGreaterThan(0);
  });

  describe('the Register banner endpoint', () => {
    it('lists stranded payments for the outlet only, and drops one after it is settled or refunded', async () => {
      const a = await strandedTab();
      const other = await strandedTab();
      const recent = await strandedTab(1);

      const listed = await banner(a.outletId);
      expect(listed.map((row) => String(row.id))).toEqual([String(a.paymentId)]);
      expect(listed[0]).toMatchObject({ pos_order_id: a.orderId, amount: '23.00', currency: 'NGN' });
      expect((await banner(recent.outletId)).map((row) => row.id)).toEqual([]); // too recent to call stranded

      await t.request
        .post(`/api/v1/pos/orders/${a.orderId}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `settle-${a.paymentId}`)
        .send({ settlements: [{ method: 'card', payment_id: a.paymentId }] })
        .expect(200);
      expect(await banner(a.outletId)).toEqual([]);

      expect((await banner(other.outletId)).map((row) => String(row.id))).toEqual([String(other.paymentId)]);
      await t.trx('payments').where({ id: other.paymentId }).update({ status: 'REFUNDED' });
      expect(await banner(other.outletId)).toEqual([]);
    });

    it('does not show another tenant\'s stranded payments, and needs the Register permission', async () => {
      const mine = await strandedTab();
      const otherToken = signAccessToken({ aud: 'staff', sub: String(ctx.b.users[0].id), tenant_id: String(ctx.b.id), property_id: String(ctx.b.properties[0].id) });
      const res = await t.request.get(`/api/v1/pos/stranded-payments?outlet_id=${mine.outletId}`).set('Authorization', `Bearer ${otherToken}`);
      expect([200, 403, 404]).toContain(res.status);
      if (res.status === 200) expect(res.body.data).toEqual([]);
      await t.request.get('/api/v1/pos/stranded-payments').expect(401);
    });
  });
});
