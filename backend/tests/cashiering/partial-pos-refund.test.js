'use strict';

/**
 * A partial Paystack refund of a Register card payment must NOT void the whole settlement it funded. The settlement is
 * voided only once the refunds reach the full payment, in the same transaction as the refund that completes it.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { initializeTransaction: jest.fn(), verifyTransaction: jest.fn(), refundTransaction: jest.fn() };
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
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;
const { insertMenuItem } = require('../helpers/catalogue');

describe('partial refund of a Register card payment', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let outlet;
  let manager;
  let operator;
  let counter = 0;
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const token = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${token(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${token(userId)}`).set('Idempotency-Key', `ppr-${next()}`),
  });

  async function user(role, pin) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'T', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    if (pin) await setApprovalPin(t.trx, { tenantId: ctx.a.id, userId: id });
    return id;
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-08-01' });
    manager = await user('manager', true);
    operator = await user('pos_operator', false);
    const suffix = Date.now().toString(36).slice(-6);
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `PP-${suffix}`, name: 'Partial Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `PP-T-${suffix}` });
    const [beer] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Partial Beer', category: 'Drinks', price: '100.00' });
    outlet = { outletId, terminalId, beer };
  });

  beforeEach(() => {
    paystack.initializeTransaction.mockReset();
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/x', accessCode: 'a', reference }));
    paystack.refundTransaction.mockReset();
    paystack.refundTransaction.mockResolvedValue({ refundId: 'r1', status: 'processed' });
  });

  async function cardSale() {
    const opened = await as(operator).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `P${next()}`.slice(0, 20) });
    const orderId = opened.body.data.id;
    await as(operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 1 });
    const started = await as(operator).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
    const payment = started.body.data;
    await t.trx('payments').where({ id: payment.id }).update({ status: 'CAPTURED', captured_at: new Date(), provider_channel: 'card' });
    const settled = await as(operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'card', payment_id: payment.id }] });
    expect(settled.status).toBe(200);
    return { orderId, payment, settlementId: settled.body.data.settlements[0].id };
  }

  async function refund(paymentId, amount) {
    const approval = await managerApproval(t.request, { token: token(manager), approverUserId: manager, action: 'pos.refund_payment', targetId: paymentId });
    return as(manager).post(`/api/v1/cashiering/payments/${paymentId}/refund`).set('X-Manager-Approval', approval).send({ amount, reason: 'guest returned one item' });
  }

  const settlementRow = (id) => t.trx('pos_order_settlements').where({ id }).first();

  test('a partial refund keeps the settlement standing and marks the payment PARTIALLY_REFUNDED', async () => {
    const { payment, settlementId } = await cardSale();
    const res = await refund(payment.id, '10.00');
    expect(res.status).toBe(201);
    expect((await settlementRow(settlementId)).voided_at).toBeNull();
    expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('PARTIALLY_REFUNDED');
  });

  test('a partial refund is flagged in the audit trail and puts no stock back (a partial amount says nothing about which line came back)', async () => {
    const { payment, settlementId } = await cardSale();
    const res = await refund(payment.id, '10.00');
    const flag = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: res.body.data.id, action: 'refund_partial_settlement_kept' }).first();
    expect(flag).toBeDefined();
    expect(flag.after_state).toMatchObject({ settlementId: String(settlementId), refundAmount: '10.00' });
    expect(await t.trx('stock_movements').where({ pos_order_settlement_id: settlementId, type: 'sale_reversal' })).toHaveLength(0);
  });

  test('the Sales report still lists the sale and shows the amount refunded against it', async () => {
    const { orderId, payment } = await cardSale();
    await refund(payment.id, '10.00');
    const report = await as(manager).get('/api/v1/pos/reports/sales?date_from=2027-08-01&date_to=2027-08-01');
    expect(report.status).toBe(200);
    const tab = report.body.data.tabs.find((row) => String(row.orderId) === String(orderId));
    expect(tab).toBeDefined();
    expect(tab.payments[0]).toMatchObject({ partiallyRefunded: '10.00' });
  });

  test('the settlement is voided in the same transaction as the refund that brings the total to the full payment', async () => {
    const { payment, settlementId } = await cardSale();
    const firstAmount = '10.00';
    await refund(payment.id, firstAmount);
    const rest = String((Number(payment.amount) - 10).toFixed(2));
    expect((await settlementRow(settlementId)).voided_at).toBeNull();
    const res = await refund(payment.id, rest);
    expect(res.status).toBe(201);
    expect((await settlementRow(settlementId)).voided_at).not.toBeNull();
    expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('REFUNDED');
  });

  test('a full refund in one go still voids the settlement, as before', async () => {
    const { payment, settlementId } = await cardSale();
    const res = await refund(payment.id, undefined);
    expect(res.status).toBe(201);
    expect((await settlementRow(settlementId)).voided_at).not.toBeNull();
  });

  test('payment reconciliation counts a partly refunded sale once: the charge, then the refund against it', async () => {
    const { orderId, payment } = await cardSale();
    await refund(payment.id, '10.00');
    const res = await as(manager).get('/api/v1/reconciliation/payments?date_from=2027-08-01&date_to=2027-08-01');
    expect(res.status).toBe(200);
    const lines = res.body.data.lines.filter((line) => String(line.paymentId) === String(payment.id) || String(line.parentPaymentId) === String(payment.id));
    // The standing settlement's own line plus the refund's negative line; never a second reconstructed copy of the charge.
    expect(lines.filter((line) => !line.parentPaymentId)).toHaveLength(1);
    expect(lines.filter((line) => line.parentPaymentId)).toHaveLength(1);
    expect(orderId).toBeDefined();
  });
});
