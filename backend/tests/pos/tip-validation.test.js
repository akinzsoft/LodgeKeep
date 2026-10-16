'use strict';

/**
 * F-02 (product audit): `tip_amount` on a POS settlement was taken as sent, so a negative tip worked as a discount
 * (and a cash skim: the shift's expected cash shrank with it) and text like "abc" or "1e3" crashed with a 500.
 * Every tip is now validated on the server before anything is written, on every settlement method.
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
const { managerApproval } = require('../helpers/approvals');
const { signAccessToken } = require('../../src/auth/tokens');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const { insertMenuItem } = require('../helpers/catalogue');

const BUSINESS_DATE = '2027-08-01';
const FEE_PERCENTAGE = '2.50';

describe('F-02: POS tip validation', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let managerId;
  let operatorId;
  let outlet;
  let counter = 0;

  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
  });
  const idemKey = () => `ext-card-${(counter += 1)}`;
  // A settlement void needs a manager's PIN approval (src/modules/approvals); the manager approves their own.
  async function managerVoid(orderId, settlementId) {
    const approval = await managerApproval(t.request, { token: tokenFor(managerId), approverUserId: managerId, action: 'pos.void_settlement', targetId: settlementId });
    return as(managerId).post(`/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`).set('X-Manager-Approval', approval).set('Idempotency-Key', idemKey()).send({ reason: 'keyed in error' });
  }

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  async function openTab(userId = operatorId) {
    const opened = await as(userId).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `X${(counter += 1)}` });
    expect(opened.status).toBe(201);
    const added = await as(userId).post(`/api/v1/pos/orders/${opened.body.data.id}/items`).send({ menu_item_id: outlet.menuItemId, quantity: 1 });
    expect(added.status).toBe(200);
    return opened.body.data.id;
  }

  const settleWith = (orderId, settlement, userId = operatorId) =>
    as(userId).post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', idemKey()).send({ settlements: [{ service_charge: '1.50', ...settlement }] });

  async function capturedPaystackPayment(orderId) {
    const started = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).set('Idempotency-Key', idemKey()).send({ tender: 'card' });
    expect(started.status).toBe(201);
    await t.trx('payments').where({ id: started.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date(), provider_channel: 'card' });
    return started.body.data.id;
  }

  beforeEach(() => {
    paystack.initializeTransaction.mockReset();
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay/x', accessCode: 'x-access', reference }));
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
  });

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BUSINESS_DATE });
    await t.trx('property_payment_subaccounts').where({ tenant_id: ctx.a.id, property_id: propertyId }).update({ percentage_charge: FEE_PERCENTAGE });
    managerId = ctx.a.users[0].id;
    operatorId = ctx.a.users[1].id;
    await setRole(managerId, 'manager');
    await setRole(operatorId, 'pos_operator');

    const suffix = Date.now().toString(36).slice(-6);
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `XT-${suffix}`, name: 'Terminal Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `XT-T-${suffix}` });
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Terminal Beer', category: 'Drinks', price: '20.00' });
    outlet = { outletId, terminalId, menuItemId };
  });


  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  const NOT_A_TIP = ['-3.00', '-0.01', '-0', 'abc', 'NaN', 'Infinity', '-Infinity', '1e3', '0x10', '1,5', '1.234', '', '   ', -5, 2.5, true, { a: 1 }, ['1.00']];

  async function expectRefused(orderId, tip, method = 'cash') {
    const res = await settleWith(orderId, { method, tip_amount: tip });
    expect({ tip, status: res.status, code: res.body.error?.code }).toEqual({ tip, status: 400, code: 'VALIDATION_INVALID_TIP' });
    expect((await t.trx('pos_orders').where({ id: orderId }).first()).status).toBe('open');
    expect(await t.trx('pos_order_settlements').where({ pos_order_id: orderId }).first()).toBeUndefined();
  }

  it.each(NOT_A_TIP.map((v) => [JSON.stringify(v), v]))('refuses the tip %s and leaves the tab open with nothing written', async (_label, tip) => {
    await expectRefused(await openTab(), tip);
  });

  it('refuses a bad tip on every settlement method, including a room charge and a terminal sale', async () => {
    for (const method of ['cash', 'terminal', 'card', 'room_charge']) {
      await expectRefused(await openTab(), '-3.00', method);
    }
  });

  it('refuses a tip above the default cap and accepts one exactly at it', async () => {
    await expectRefused(await openTab(), '1000000.01');
    const ok = await settleWith(await openTab(), { method: 'cash', tip_amount: '1000000.00' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.settlements[0].tip_amount).toBe('1000000.00');
  });

  it('honours a lower MAX_TIP_AMOUNT and ignores a garbage one', async () => {
    process.env.MAX_TIP_AMOUNT = '50.00';
    await expectRefused(await openTab(), '50.01');
    expect((await settleWith(await openTab(), { method: 'cash', tip_amount: '50.00' })).status).toBe(200);

    process.env.MAX_TIP_AMOUNT = 'not-a-number';
    await expectRefused(await openTab(), '1000000.01');
    process.env.MAX_TIP_AMOUNT = '0';
    await expectRefused(await openTab(), '1000000.01');
  });

  it('accepts a normal tip, zero, and none at all, in the exact decimal convention', async () => {
    const tipped = await settleWith(await openTab(), { method: 'cash', tip_amount: '2.50' });
    expect(tipped.status).toBe(200);
    expect(tipped.body.data.settlements[0].tip_amount).toBe('2.50');
    const row = await t.trx('pos_order_settlements').where({ id: tipped.body.data.settlements[0].id }).first();
    expect(row.tip_amount).toBe('2.50');
    expect(row.subtotal).toBe('20.00');

    const zero = await settleWith(await openTab(), { method: 'cash', tip_amount: '0' });
    expect(zero.status).toBe(200);
    expect(zero.body.data.settlements[0].tip_amount).toBe('0.00');

    const none = await settleWith(await openTab(), { method: 'cash' });
    expect(none.status).toBe(200);
    expect((await t.trx('pos_order_settlements').where({ id: none.body.data.settlements[0].id }).first()).tip_amount).toBe('0.00');
  });

  it('a refused negative tip cannot shrink the shift\'s expected cash', async () => {
    const shift = await as(operatorId).post('/api/v1/pos/shifts').send({ terminal_id: outlet.terminalId, opening_float: '10.00' });
    expect(shift.status).toBe(201);
    await expectRefused(await openTab(), '-3.00');
    expect((await settleWith(await openTab(), { method: 'cash' })).status).toBe(200);
    const close = await as(operatorId).post(`/api/v1/pos/shifts/${shift.body.data.id}/close`).set('Idempotency-Key', idemKey()).send({ counted_cash: '33.00' });
    expect(close.body.data.expected_cash).toBe('33.00');
    expect(close.body.data.variance).toBe('0.00');
  });
});
