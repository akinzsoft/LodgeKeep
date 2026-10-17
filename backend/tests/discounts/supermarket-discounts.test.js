'use strict';

/**
 * Discounts and comps at the supermarket till. There is no order before the sale, so a request is made against the
 * cart (the server prices it from the menu, never from the client) and the sale claims the approved request once.
 * Ambient tax: the hotel's 7.5% 'all' row never applies to a supermarket sale; this outlet's own 1.5% row does, so a
 * 200.00 cart is 203.00 and a 5% discount makes it 190.00 + 2.85 = 192.85.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    refundTransaction: jest.fn(),
    fetchRefund: jest.fn(),
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
const { managerApproval, setApprovalPin } = require('../helpers/approvals');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem } = require('../helpers/catalogue');
const { recordForStoredPayment } = require('../helpers/gateway-record');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const cashieringService = require('../../src/modules/cashiering/service');

describe('discounts at the supermarket till', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let counter = 0;
  let market;
  let rice; // 100.00
  let soap; // 50.00
  const users = {};

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId, tenantId = ctx.a.id, property = propertyId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(property) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `sd-${next()}`),
  });

  async function userWithRole(role, { pin = false } = {}) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'Tester', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    if (pin) await setApprovalPin(t.trx, { tenantId: ctx.a.id, userId: id });
    return id;
  }

  const cart = (extra = []) => [{ menu_item_id: rice, quantity: 2 }, ...extra]; // 200.00
  async function reasonId(code = 'promo') {
    await as(users.manager).get('/api/v1/discounts/reasons'); // seeds the defaults
    return String((await t.trx('discount_reasons').where({ tenant_id: ctx.a.id, property_id: propertyId, code }).first('id')).id);
  }
  async function requestDiscount(userId, body = {}) {
    // The reason is looked up first: a supertest request must be built and sent without another request in between.
    const defaultReason = await reasonId('promo');
    return as(userId).post('/api/v1/supermarket/discounts').send({ outlet_id: market.outletId, items: cart(), scope: 'order', type: 'percent', value: '5', reason_id: defaultReason, ...body });
  }
  const approve = async (requester, approver, id) => {
    const token = await managerApproval(t.request, { token: tokenFor(requester), approverUserId: approver, action: 'supermarket.discount_approval', targetId: id });
    return as(requester).post(`/api/v1/discounts/${id}/approve`).set('X-Manager-Approval', token).send({});
  };
  const sell = (userId, ids = [], body = {}) =>
    as(userId).post('/api/v1/supermarket/sales').send({ outlet_id: market.outletId, method: 'cash', items: cart(), discount_ids: ids, ...body });
  const discountRow = (id) => t.trx('discounts').where({ id }).first();

  beforeEach(() => {
    paystack.initializeTransaction.mockReset();
    paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.com/acc-1', accessCode: 'acc-1', reference: 'r' });
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
  });

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-09-01' });
    users.manager = await userWithRole('manager', { pin: true });
    users.admin = await userWithRole('admin', { pin: true });
    users.cashier = await userWithRole('pos_operator');
    users.cashier2 = await userWithRole('pos_operator');
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `SD${next()}`.slice(0, 30), name: 'Discount Mart', type: 'supermarket' });
    market = { outletId };
    await t.trx('taxes').insert({ tenant_id: ctx.a.id, property_id: propertyId, tax_code: 'SM_VAT_SD', name: 'Supermarket VAT', rate: '1.5000', effective_from: '2026-01-01', is_inclusive: false, calculation_method: 'percentage', applies_to: 'supermarket_sale' });
    [rice] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Rice', category: 'Groceries', price: '100.00' });
    [soap] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Soap', category: 'Groceries', price: '50.00' });
  });

  describe('a request is priced from the menu, not from the client', () => {
    test('within the limit it is active at once; the percent comes from the server-priced cart', async () => {
      const five = await requestDiscount(users.cashier, { type: 'fixed', value: '10', items: [{ menu_item_id: rice, quantity: 2, unit_price: '1.00', price: '1.00' }] });
      expect(five.status).toBe(201);
      expect(five.body.data).toMatchObject({ status: 'active', amount: '10.00', effective_percent: '5.00', pos_order_id: null });
      const six = await requestDiscount(users.cashier, { type: 'fixed', value: '12' });
      expect(six.body.data).toMatchObject({ status: 'pending_approval', approvalAction: 'supermarket.discount_approval', effective_percent: '6.00' });
    });

    test('refuses an empty or unpriceable cart, a product not in the cart, and a bad value', async () => {
      expect((await requestDiscount(users.cashier, { items: [] })).status).toBe(400);
      expect((await requestDiscount(users.cashier, { items: [{ menu_item_id: '99999999', quantity: 1 }] })).status).toBe(400);
      expect((await requestDiscount(users.cashier, { scope: 'line', menu_item_id: soap })).status).toBe(400);
      expect((await requestDiscount(users.cashier, { value: '-5' })).status).toBe(400);
    });

    test('a supermarket request needs the supermarket outlet and the supermarket.sales key', async () => {
      const bar = (await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `BR${next()}`.slice(0, 30), name: 'Not a mart', type: 'bar' }))[0];
      expect((await requestDiscount(users.cashier, { outlet_id: bar })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('selling with a discount', () => {
    test('VAT is worked out on the discounted amount, and the receipt lists the discount', async () => {
      const grant = await requestDiscount(users.cashier);
      expect(grant.body.data.status).toBe('active');
      const sale = await sell(users.cashier, [grant.body.data.id]);
      expect(sale.status).toBe(201);
      const receipt = sale.body.data;
      // 200.00 - 5% (10.00) = 190.00; VAT 1.5% = 2.85
      expect(receipt).toMatchObject({ subtotal: '190.00', tax_amount: '2.85', total: '192.85', gross: '200.00', discount_total: '10.00' });
      expect(receipt.discounts).toEqual([{ kind: 'discount', reason: 'Promotion', amount: '10.00' }]);
      expect(receipt.lines[0]).toMatchObject({ line_total: '200.00', line_net: '190.00', line_tax: '2.85' });
      expect((await discountRow(grant.body.data.id)).status).toBe('applied');
      expect(String((await discountRow(grant.body.data.id)).pos_order_id)).toBe(String(receipt.pos_order_id));
    });

    test("a request cannot be used on a bigger cart than the one it was priced for", async () => {
      const grant = await requestDiscount(users.cashier, { items: [{ menu_item_id: rice, quantity: 1 }] }); // 5% of 100.00 = 5.00
      expect(grant.body.data.amount).toBe('5.00');
      const sale = await sell(users.cashier, [grant.body.data.id], { items: [{ menu_item_id: rice, quantity: 10 }] }); // 1000.00
      expect(sale.status).toBe(201);
      expect(sale.body.data).toMatchObject({ gross: '1000.00', discount_total: '5.00', subtotal: '995.00' });
    });

    test('a sale without a discount has the old receipt shape', async () => {
      const sale = await sell(users.cashier, []);
      expect(sale.status).toBe(201);
      expect(sale.body.data).toMatchObject({ subtotal: '200.00', tax_amount: '3.00', total: '203.00' });
      expect(sale.body.data.discounts).toBeUndefined();
      expect(sale.body.data.discount_total).toBeUndefined();
    });

    test('a line discount splits the net over the lines by what each is worth after the discount', async () => {
      const grant = await requestDiscount(users.cashier, { items: cart([{ menu_item_id: soap, quantity: 1 }]), scope: 'line', menu_item_id: soap, type: 'percent', value: '4' });
      expect(grant.body.data).toMatchObject({ status: 'active', amount: '2.00' }); // 4% of the 50.00 line
      const sale = await sell(users.cashier, [grant.body.data.id], { items: cart([{ menu_item_id: soap, quantity: 1 }]) });
      expect(sale.status).toBe(201);
      const lines = sale.body.data.lines;
      expect(sale.body.data).toMatchObject({ gross: '250.00', discount_total: '2.00', subtotal: '248.00' });
      const soapLine = lines.find((line) => line.item_name === 'Soap');
      expect(soapLine.line_net).toBe('48.00');
    });

    test('a discount above the limit cannot be used until a manager approves it; refused sales write no sale and burn no receipt number', async () => {
      const pending = await requestDiscount(users.cashier, { value: '10' });
      expect(pending.body.data.status).toBe('pending_approval');
      const before = await t.trx('supermarket_sales').where({ outlet_id: market.outletId }).count({ n: '*' }).first();
      const refused = await sell(users.cashier, [pending.body.data.id]);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('VALIDATION_DISCOUNT_GRANT_INVALID');
      const after = await t.trx('supermarket_sales').where({ outlet_id: market.outletId }).count({ n: '*' }).first();
      expect(Number(after.n)).toBe(Number(before.n));

      expect((await approve(users.cashier, users.manager, pending.body.data.id)).status).toBe(200);
      const sale = await sell(users.cashier, [pending.body.data.id]);
      expect(sale.status).toBe(201);
      expect(sale.body.data.discount_total).toBe('20.00');
    });

    test('a request can be used once, only by the cashier who asked, and only before it expires', async () => {
      const grant = await requestDiscount(users.cashier);
      const other = await sell(users.cashier2, [grant.body.data.id]);
      expect(other.status).toBe(422);
      expect((await sell(users.cashier, [grant.body.data.id])).status).toBe(201);
      const again = await sell(users.cashier, [grant.body.data.id]);
      expect(again.status).toBe(422);

      const stale = await requestDiscount(users.cashier);
      await t.trx('discounts').where({ id: stale.body.data.id }).update({ expires_at: new Date(Date.now() - 60_000) });
      expect((await sell(users.cashier, [stale.body.data.id])).status).toBe(422);
    });

    test('two order discounts, or a discounted product that is not in the sale, are refused', async () => {
      const a = await requestDiscount(users.cashier);
      const b = await requestDiscount(users.cashier, { value: '3' });
      const two = await sell(users.cashier, [a.body.data.id, b.body.data.id]);
      expect(two.status).toBe(409);
      const line = await requestDiscount(users.cashier, { items: cart([{ menu_item_id: soap, quantity: 1 }]), scope: 'line', menu_item_id: soap, value: '4' });
      const missing = await sell(users.cashier, [line.body.data.id]); // the sale has no soap
      expect(missing.status).toBe(422);
    });

    test('a removed request cannot be used; only its owner can remove it', async () => {
      const grant = await requestDiscount(users.cashier);
      expect((await as(users.cashier2).post(`/api/v1/discounts/${grant.body.data.id}/remove`).send({ reason: 'nope' })).status).toBe(422);
      expect((await as(users.cashier).post(`/api/v1/discounts/${grant.body.data.id}/remove`).send({ reason: 'changed my mind' })).status).toBe(200);
      expect((await sell(users.cashier, [grant.body.data.id])).status).toBe(422);
    });

    test('a comp takes everything, with no tax, after a manager approves it', async () => {
      const reason = await reasonId('staff_meal');
      const comp = await requestDiscount(users.cashier, { kind: 'comp', reason_id: reason });
      expect(comp.body.data).toMatchObject({ kind: 'comp', status: 'pending_approval', value: '100.00' });
      expect((await approve(users.cashier, users.manager, comp.body.data.id)).status).toBe(200);
      const sale = await sell(users.cashier, [comp.body.data.id]);
      expect(sale.status).toBe(201);
      expect(sale.body.data).toMatchObject({ subtotal: '0.00', tax_amount: '0.00', total: '0.00', gross: '200.00', discount_total: '200.00' });
      expect(sale.body.data.discounts[0]).toMatchObject({ kind: 'comp', reason: 'Staff meal' });
    });
  });

  describe('void and report', () => {
    test('voiding the sale keeps the frozen discount as history but drops it from the report', async () => {
      const grant = await requestDiscount(users.cashier);
      const sale = await sell(users.cashier, [grant.body.data.id]);
      const report = () => as(users.manager).get('/api/v1/discounts/report?date_from=2027-09-01&date_to=2027-09-01');
      const before = (await report()).body.data.summary.count;
      const token = await managerApproval(t.request, { token: tokenFor(users.manager), approverUserId: users.manager, action: 'supermarket.void_sale', targetId: sale.body.data.id });
      const voided = await as(users.manager).post(`/api/v1/supermarket/sales/${sale.body.data.id}/void`).set('X-Manager-Approval', token).send({ reason: 'customer returned' });
      expect(voided.status).toBe(200);
      expect((await report()).body.data.summary.count).toBe(before - 1);
      expect(await t.trx('settlement_discounts').where({ settlement_id: sale.body.data.settlement_id })).toHaveLength(1);
    });

    test('the POS sales report adds the item rows up to the summary under a discount', async () => {
      const grant = await requestDiscount(users.cashier, { value: '5' });
      await sell(users.cashier, [grant.body.data.id]);
      const res = await as(users.manager).get('/api/v1/pos/reports/sales?date_from=2027-09-01&date_to=2027-09-01');
      expect(res.status).toBe(200);
      const { summary, topItems } = res.body.data;
      expect(summary.discounts.count).toBeGreaterThan(0);
      const itemSum = topItems.reduce((sum, row) => sum + Math.round(Number(row.sales) * 100), 0);
      expect(itemSum).toBe(Math.round(Number(summary.subtotal) * 100));
    });
  });

  describe('online (Paystack) sales', () => {
    const paystackSays = (overrides) => paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, overrides));
    function webhook(payment) {
      paystack.verifyWebhookSignature.mockReturnValue(true);
      const body = { event: 'charge.success', data: { id: Number(`7${next().replace(/\D/g, '').slice(-8) || '1'}`), reference: payment.provider_reference, status: 'success' } };
      return cashieringService.handlePaystackWebhook({ rawBody: JSON.stringify(body), signatureHeader: 'mocked', parsedBody: body });
    }
    const startOnline = (userId, ids) => as(userId).post('/api/v1/supermarket/online-sales').send({ outlet_id: market.outletId, tender: 'online', items: cart(), discount_ids: ids });
    const paymentFor = async (intentId) => t.trx('payments').where({ id: (await t.trx('supermarket_sale_intents').where({ id: intentId }).first()).payment_id }).first();

    test('the payment is for the discounted total and the capture completes the sale with the discount', async () => {
      const grant = await requestDiscount(users.cashier);
      const started = await startOnline(users.cashier, [grant.body.data.id]);
      expect(started.status).toBe(201);
      expect(started.body.data.total).toBe('192.85');
      const payment = await paymentFor(started.body.data.id);
      expect(payment.amount).toBe('192.85');
      paystackSays({ status: 'success' });
      await webhook(payment);
      const intent = await t.trx('supermarket_sale_intents').where({ id: started.body.data.id }).first();
      expect(intent.status).toBe('completed');
      const sale = await t.trx('supermarket_sales').where({ id: intent.sale_id }).first();
      expect(sale).toMatchObject({ subtotal: '190.00', tax_amount: '2.85', total: '192.85' });
      expect((await discountRow(grant.body.data.id)).status).toBe('applied');
      expect(await t.trx('settlement_discounts').where({ settlement_id: sale.settlement_id })).toHaveLength(1);
    });

    test('a comp cart that a flat-amount tax would otherwise charge has nothing to pay online', async () => {
      const [flatId] = await t.trx('taxes').insert({ tenant_id: ctx.a.id, property_id: propertyId, tax_code: 'SM_FLAT', name: 'Flat levy', rate: '5.0000', effective_from: '2026-01-01', is_inclusive: false, calculation_method: 'flat_amount', applies_to: 'supermarket_sale' });
      try {
        const comp = await requestDiscount(users.cashier, { kind: 'comp', reason_id: await reasonId('staff_meal') });
        await approve(users.cashier, users.manager, comp.body.data.id);
        const started = await startOnline(users.cashier, [comp.body.data.id]);
        expect(started.status).toBe(400);
        expect(started.body.error.code).toBe('VALIDATION_NOTHING_TO_PAY');
      } finally {
        await t.trx('taxes').where({ id: flatId }).delete();
      }
    });

    test('a discount spent on another sale before the payment lands keeps the money for a manager to refund', async () => {
      const grant = await requestDiscount(users.cashier);
      const started = await startOnline(users.cashier, [grant.body.data.id]);
      expect((await sell(users.cashier, [grant.body.data.id])).status).toBe(201); // the cash sale claims it first
      const payment = await paymentFor(started.body.data.id);
      paystackSays({ status: 'success' });
      await webhook(payment);
      const intent = await t.trx('supermarket_sale_intents').where({ id: started.body.data.id }).first();
      expect(intent.status).toBe('needs_review');
      expect(intent.sale_id).toBeNull();
    });
  });

  describe('tenant isolation', () => {
    test("tenant B cannot use or approve tenant A's request", async () => {
      const grant = await requestDiscount(users.cashier);
      const bUser = ctx.b.users[1].id;
      const bProperty = ctx.b.properties[0].id;
      const asB = (method, url) => t.request[method](url).set('Authorization', `Bearer ${tokenFor(bUser, ctx.b.id, bProperty)}`).set('Idempotency-Key', `b-${next()}`);
      const [bOutlet] = await t.trx('pos_outlets').insert({ tenant_id: ctx.b.id, property_id: bProperty, code: `BM${next()}`.slice(0, 30), name: 'B Mart', type: 'supermarket' });
      const res = await asB('post', '/api/v1/supermarket/sales').send({ outlet_id: bOutlet, method: 'cash', items: [{ menu_item_id: ctx.b.posMenuItems?.[0]?.id ?? 1, quantity: 1 }], discount_ids: [grant.body.data.id] });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await asB('post', `/api/v1/discounts/${grant.body.data.id}/approve`).send({})).status).toBeGreaterThanOrEqual(400);
      expect((await discountRow(grant.body.data.id)).status).toBe('active');
    });
  });
});
