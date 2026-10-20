'use strict';

/**
 * Vouchers at the supermarket till. There is no order before the sale, so the code is typed against the cart: the server
 * prices the cart from the menu and binds the voucher to this cashier and outlet until the sale claims it. The sale then
 * redeems it under the same lock as a Register check, and voiding the sale gives the use back.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { initializeTransaction: jest.fn(), verifyTransaction: jest.fn(), refundTransaction: jest.fn(), fetchRefund: jest.fn(), verifyWebhookSignature: jest.fn() };
  return { ...actual, __mockAdapter: mockAdapter, resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })) };
});

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { managerApproval, setApprovalPin } = require('../helpers/approvals');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem } = require('../helpers/catalogue');
const paystackModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackModule.__mockAdapter;

describe('vouchers at the supermarket till', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let market;
  let rice;
  let counter = 0;
  const users = {};
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `svc-${next()}`),
  });
  async function userWithRole(role, { pin = false } = {}) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'Tester', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    if (pin) await setApprovalPin(t.trx, { tenantId: ctx.a.id, userId: id });
    return id;
  }
  const cart = () => [{ menu_item_id: rice, quantity: 2 }]; // 200.00
  async function makeVoucher(body = {}) {
    const res = await as(users.manager).post('/api/v1/discounts/vouchers').send({ type: 'percent', value: '10', valid_to: '2030-12-31', ...body });
    expect(res.status).toBe(201);
    return res.body.data;
  }
  const typeCode = (userId, code, body = {}) => as(userId).post('/api/v1/supermarket/voucher').send({ outlet_id: market.outletId, items: cart(), code, ...body });
  const sell = (userId, ids = [], body = {}) => as(userId).post('/api/v1/supermarket/sales').send({ outlet_id: market.outletId, method: 'cash', items: cart(), discount_ids: ids, ...body });
  const voucherRow = (id) => t.trx('vouchers').where({ id }).first();

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-09-01' });
    users.manager = await userWithRole('manager', { pin: true });
    users.cashier = await userWithRole('pos_operator');
    users.cashier2 = await userWithRole('pos_operator');
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `SV${next()}`.slice(0, 30), name: 'Voucher Mart', type: 'supermarket' });
    market = { outletId };
    await t.trx('taxes').insert({ tenant_id: ctx.a.id, property_id: propertyId, tax_code: 'SM_VAT_SV', name: 'Supermarket VAT', rate: '1.5000', effective_from: '2026-01-01', is_inclusive: false, calculation_method: 'percentage', applies_to: 'supermarket_sale' });
    [rice] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Rice', category: 'Groceries', price: '100.00' });
  });
  beforeEach(async () => {
    await flushRateLimitPrefixes(['voucher-user:', 'voucher-ip:']);
    paystack.initializeTransaction.mockReset();
  });

  test('a code typed against the cart is priced from the menu, never from the client', async () => {
    const v = await makeVoucher({ value: '10' });
    const res = await typeCode(users.cashier, v.code.toLowerCase(), { items: [{ menu_item_id: rice, quantity: 2, unit_price: '1.00' }], value: '99', amount: '5.00' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'voucher', status: 'active', amount: '20.00', pos_order_id: null, voucher_code: v.code });
  });

  test('the sale redeems it: VAT on the discounted amount, the receipt names the code, one use counted', async () => {
    const v = await makeVoucher({ value: '10', max_total_uses: 2 });
    const grant = await typeCode(users.cashier, v.code);
    const sale = await sell(users.cashier, [grant.body.data.id]);
    expect(sale.status).toBe(201);
    // 200.00 - 10% (20.00) = 180.00, VAT 1.5% = 2.70
    expect(sale.body.data).toMatchObject({ subtotal: '180.00', tax_amount: '2.70', total: '182.70', gross: '200.00', discount_total: '20.00' });
    expect(sale.body.data.discounts).toEqual([{ kind: 'voucher', reason: 'Voucher', amount: '20.00', voucher_code: v.code }]);
    expect((await voucherRow(v.id)).used_count).toBe(1);
    expect(await t.trx('voucher_redemptions').where({ voucher_id: v.id, status: 'redeemed' })).toHaveLength(1);
  });

  test('one answer for every bad code, as at the Register', async () => {
    const disabled = await makeVoucher();
    await as(users.manager).post(`/api/v1/discounts/vouchers/${disabled.id}/disable`).send({ reason: 'x' });
    const answers = [];
    for (const code of ['NOSUCHCODE12', disabled.code, '!!', undefined]) {
      const res = await typeCode(users.cashier, code);
      answers.push({ status: res.status, code: res.body.error?.code, message: res.body.error?.message });
    }
    expect(answers[0]).toEqual({ status: 422, code: 'BUSINESS_RULE_VOUCHER_INVALID', message: expect.any(String) });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  test("another cashier cannot use this cashier's voucher request, and it cannot be used twice", async () => {
    const v = await makeVoucher({ max_total_uses: 5 });
    const grant = await typeCode(users.cashier, v.code);
    expect((await sell(users.cashier2, [grant.body.data.id])).status).toBe(422);
    expect((await sell(users.cashier, [grant.body.data.id])).status).toBe(201);
    expect((await sell(users.cashier, [grant.body.data.id])).status).toBe(422);
    expect((await voucherRow(v.id)).used_count).toBe(1);
  });

  test('a voucher disabled after it was typed fails the sale with a clear message, nothing is sold, and a retry without it works', async () => {
    const v = await makeVoucher();
    const grant = await typeCode(users.cashier, v.code);
    await as(users.manager).post(`/api/v1/discounts/vouchers/${v.id}/disable`).send({ reason: 'x' });
    const failed = await sell(users.cashier, [grant.body.data.id]);
    expect(failed.status).toBe(422);
    expect(failed.body.error.code).toBe('BUSINESS_RULE_VOUCHER_NO_LONGER_AVAILABLE');
    expect(failed.body.error.message).toMatch(/disabled/i);
    expect((await voucherRow(v.id)).used_count).toBe(0);
    // The request is still the cashier's to remove, and the same cart then sells at the full price.
    expect((await as(users.cashier).post(`/api/v1/discounts/${grant.body.data.id}/remove`).send({ reason: 'Voucher no longer works' })).status).toBe(200);
    const sale = await sell(users.cashier);
    expect(sale.status).toBe(201);
    expect(sale.body.data.subtotal).toBe('200.00');
  });

  test('voiding the sale gives the use back, and the voucher can be used again', async () => {
    const v = await makeVoucher({ max_total_uses: 1 });
    const grant = await typeCode(users.cashier, v.code);
    const sale = await sell(users.cashier, [grant.body.data.id]);
    expect((await voucherRow(v.id)).used_count).toBe(1);
    const token = await managerApproval(t.request, { token: tokenFor(users.manager), approverUserId: users.manager, action: 'supermarket.void_sale', targetId: sale.body.data.id });
    const voided = await as(users.manager).post(`/api/v1/supermarket/sales/${sale.body.data.id}/void`).set('X-Manager-Approval', token).send({ reason: 'customer returned' });
    expect(voided.status).toBe(200);
    expect((await voucherRow(v.id)).used_count).toBe(0);
    expect((await t.trx('voucher_redemptions').where({ voucher_id: v.id }).first()).status).toBe('reversed');
    expect((await typeCode(users.cashier, v.code)).status).toBe(201);
  });

  test('online (Paystack) payment does not take a voucher: the sale cannot be started with one', async () => {
    const v = await makeVoucher();
    const grant = await typeCode(users.cashier, v.code);
    const started = await as(users.cashier).post('/api/v1/supermarket/online-sales').send({ outlet_id: market.outletId, tender: 'online', items: cart(), discount_ids: [grant.body.data.id] });
    expect(started.status).toBe(422);
    expect(started.body.error.code).toBe('BUSINESS_RULE_VOUCHER_NOT_ON_CARD');
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  test('a voucher is not offered to a role without discount.apply or supermarket.sales', async () => {
    const v = await makeVoucher();
    const housekeeper = await userWithRole('housekeeping');
    expect((await typeCode(housekeeper, v.code)).status).toBe(403);
  });

  test('is rate-limited per user like the Register', async () => {
    let last;
    for (let i = 0; i < 21; i += 1) last = await typeCode(users.cashier, 'NOSUCHCODE12');
    expect(last.status).toBe(429);
  });
});
