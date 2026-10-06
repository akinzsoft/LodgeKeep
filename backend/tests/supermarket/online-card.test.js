'use strict';

/**
 * Supermarket online card sales (Paystack): start → checkout → the capture
 * completes the sale exactly once (webhook or the till's check), cancel,
 * expiry, the "paid but no sale" review path, void = refund + stock back,
 * payout routing, and the generic refund refusing supermarket payments.
 *
 * Paystack is mocked at the adapter boundary. Ambient tax: fixtures seed a
 * 7.5% EXCLUSIVE `applies_to: 'all'` hotel VAT on ctx.a's property; a
 * supermarket sale ignores it and carries only its own 1.5% row here, so a
 * ₦200.00 cart is ₦203.00 — and never a service charge.
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
const { approvedPoster } = require('../helpers/approvals');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');
const { recordForStoredPayment } = require('../helpers/gateway-record');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const cashieringService = require('../../src/modules/cashiering/service');
const { runSupermarketRefundSweep } = require('../../src/jobs/payment-webhooks');

describe('supermarket online card sales', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let counter = 0;
  let market;
  let users;
  let biscuit; // 100.00, stock-linked
  let stockItemId;

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `oc-${next()}`),
  });


  // A void, a needs-review refund or a confirmed oversell needs a manager's PIN approval (src/modules/approvals),
  // fetched by the person at the till before the request, as the Supermarket screen does.
  const approvedPost = approvedPoster({ request: () => t.request, tokenFor, post: (userId, url) => as(userId).post(url), approver: () => users.manager });

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  const start = (body = {}, userId = users.operator) => {
    const sent = { outlet_id: market.outletId, tender: 'online', items: [{ menu_item_id: biscuit, quantity: 2 }], ...body };
    return body.confirm_oversell ? approvedPost(userId, '/api/v1/supermarket/online-sales', sent, 'supermarket.oversell') : as(userId).post('/api/v1/supermarket/online-sales').send(sent);
  };
  const check = (intentId, userId = users.operator) => as(userId).post(`/api/v1/supermarket/online-sales/${intentId}/check`).send({});
  const onHand = async () => (await t.trx('stock_levels').where({ stock_item_id: stockItemId, outlet_id: market.outletId }).first('current_quantity'))?.current_quantity;
  const paymentFor = async (intentId) => {
    const intent = await t.trx('supermarket_sale_intents').where({ id: intentId }).first();
    return t.trx('payments').where({ id: intent.payment_id }).first();
  };
  const paystackSays = (overrides) => paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, overrides));

  function webhook(payment) {
    paystack.verifyWebhookSignature.mockReturnValue(true);
    const body = { event: 'charge.success', data: { id: Number(`7${next().replace(/\D/g, '').slice(-8) || '1'}`), reference: payment.provider_reference, status: 'success' } };
    return cashieringService.handlePaystackWebhook({ rawBody: JSON.stringify(body), signatureHeader: 'mocked', parsedBody: body });
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-09-01' });
    users = { manager: ctx.a.users[0].id, operator: ctx.a.users[1].id };
    await setRole(users.manager, 'manager');
    await setRole(users.operator, 'pos_operator');
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `OC${next()}`.slice(0, 30), name: 'Mini Mart', type: 'supermarket' });
    market = { outletId };
    await t.trx('taxes').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      tax_code: 'SM_VAT_OC',
      name: 'Supermarket VAT',
      rate: '1.5000',
      effective_from: '2026-01-01',
      is_inclusive: false,
      calculation_method: 'percentage',
      applies_to: 'supermarket_sale',
    });
    [biscuit] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Biscuit', category: 'Snacks', price: '100.00' });
    [stockItemId] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: 'Biscuit pack', unit: 'pack', purchase_cost: '40.00' });
    await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: biscuit, stock_item_id: stockItemId, quantity: '1.000' });
    await t.trx('stock_movements').insert({ tenant_id: ctx.a.id, property_id: propertyId, stock_item_id: stockItemId, outlet_id: outletId, type: 'received', quantity: '100.000', unit_cost: '40.00', total_cost: '4000.00', business_date: '2027-09-01', occurred_at: new Date() });
    await t.trx('stock_levels').insert({ tenant_id: ctx.a.id, property_id: propertyId, stock_item_id: stockItemId, outlet_id: outletId, current_quantity: '100.000' });
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
    paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.com/acc-1', accessCode: 'acc-1', reference: 'r' });
    paystack.verifyTransaction.mockResolvedValue({ status: 'abandoned' });
    // Each test starts with no pending online sale at the till.
    await t.trx('supermarket_sale_intents').where({ outlet_id: market.outletId, status: 'pending' }).update({ status: 'cancelled', cancel_reason: 'test reset' });
  });

  it('starts a pending sale priced server-side, opens a card and bank-transfer checkout (no QR for NGN) on the property account, and writes no sale yet', async () => {
    const before = await onHand();
    const res = await start();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'pending', tender: 'online', total: '203.00', currency: 'NGN', sale: null });
    expect(res.body.meta).toMatchObject({ accessCode: 'acc-1', checkoutUrl: 'https://checkout.paystack.com/acc-1' });
    expect(res.body.meta.qrDataUrl).toBeNull(); // Paystack's Visa QR is gone in Nigeria

    const payment = await paymentFor(res.body.data.id);
    expect(payment).toMatchObject({ settlement_target: 'supermarket_sale', tender: 'online', amount: '203.00', status: 'PENDING', pos_order_id: null, folio_id: null, subaccount_source: 'property' });
    const init = paystack.initializeTransaction.mock.calls[0][0];
    expect(init).toMatchObject({ amount: '203.00', channels: ['card', 'bank_transfer'], subaccount: payment.subaccount_code });
    const cashier = await t.trx('users').where({ id: users.operator }).first('email');
    expect(init.email).toBe(cashier.email);

    expect(await onHand()).toBe(before);
    expect(await t.trx('supermarket_sales').where({ outlet_id: market.outletId })).toHaveLength(0);
  });

  it('routes to the outlet payout account when the outlet has one', async () => {
    const [rowId] = await t.trx('pos_outlet_payment_subaccounts').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      outlet_id: market.outletId,
      subaccount_code: 'ACCT_mart_1784',
      platform_payment_integration_id: (await t.trx('platform_payment_integrations').first('id')).id,
      bank_code: '057',
      bank_name: 'Zenith',
      account_number_last4: '1784',
      account_name: 'Mini Mart',
      percentage_charge: '0.00',
      is_active: true,
    });
    try {
      const res = await start({ customer_email: 'buyer@example.com' });
      expect(res.status).toBe(201);
      const payment = await paymentFor(res.body.data.id);
      expect(payment).toMatchObject({ subaccount_code: 'ACCT_mart_1784', subaccount_source: 'outlet' });
      expect(paystack.initializeTransaction.mock.calls[0][0]).toMatchObject({ email: 'buyer@example.com', subaccount: 'ACCT_mart_1784' });
    } finally {
      await t.trx('pos_outlet_payment_subaccounts').where({ id: rowId }).update({ is_active: false });
    }
  });

  it('a capture seen by the till completes the sale exactly once: receipt, card settlement, stock', async () => {
    const before = Number(await onHand());
    const started = await start();
    paystackSays({ status: 'success' });

    const res = await check(started.body.data.id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('completed');
    const sale = res.body.data.sale;
    expect(sale).toMatchObject({ method: 'card', subtotal: '200.00', tax_amount: '3.00', total: '203.00', payment_channel: 'card', payment_status: 'CAPTURED' });
    expect(sale.lines).toHaveLength(1);
    expect(Number(await onHand())).toBe(before - 2);

    const payment = await paymentFor(started.body.data.id);
    expect(payment.status).toBe('CAPTURED');
    const settlement = await t.trx('pos_order_settlements').where({ payment_id: payment.id }).first();
    expect(settlement).toMatchObject({ method: 'card', subtotal: '200.00', tax_amount: '3.00' });

    // A second check and a late webhook change nothing.
    await check(started.body.data.id);
    await webhook(payment);
    expect(await t.trx('supermarket_sales').where({ settlement_id: settlement.id })).toHaveLength(1);
    expect(await t.trx('pos_order_settlements').where({ payment_id: payment.id })).toHaveLength(1);
    expect(Number(await onHand())).toBe(before - 2);
    // No bell per sale.
    expect(await t.trx('in_app_notifications').where({ tenant_id: ctx.a.id }).whereRaw("JSON_EXTRACT(payload, '$.orderId') = ?", [settlement.pos_order_id])).toHaveLength(0);
  });

  it('the webhook alone completes the sale, with gapless receipt numbers alongside cash sales', async () => {
    const cash = await as(users.operator).post('/api/v1/supermarket/sales').send({ outlet_id: market.outletId, method: 'cash', items: [{ menu_item_id: biscuit, quantity: 1 }] });
    expect(cash.status).toBe(201);
    const started = await start();
    paystackSays({ status: 'success' });
    await webhook(await paymentFor(started.body.data.id));

    const intent = await t.trx('supermarket_sale_intents').where({ id: started.body.data.id }).first();
    expect(intent.status).toBe('completed');
    const sale = await t.trx('supermarket_sales').where({ id: intent.sale_id }).first();
    expect(Number(sale.receipt_number)).toBe(Number(cash.body.data.receipt_number) + 1);
    expect(String(sale.sold_by_user_id)).toBe(String(users.operator)); // the cashier, even though the webhook completed it
  });

  it('refuses a second online sale while one is waiting, and an oversell needs confirming first', async () => {
    const first = await start();
    const second = await start();
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'CONFLICT_ONLINE_SALE_PENDING', details: { intent_id: String(first.body.data.id) } });

    await as(users.operator).post(`/api/v1/supermarket/online-sales/${first.body.data.id}/cancel`).send({});
    const big = await start({ items: [{ menu_item_id: biscuit, quantity: 500 }] });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('BUSINESS_RULE_OVERSELL_NOT_CONFIRMED');
    const confirmed = await start({ items: [{ menu_item_id: biscuit, quantity: 500 }], confirm_oversell: true });
    expect(confirmed.status).toBe(201);
  });

  it('cancel asks Paystack first: unpaid cancels; a late capture keeps the money for a manager refund', async () => {
    const started = await start();
    const cancelled = await as(users.operator).post(`/api/v1/supermarket/online-sales/${started.body.data.id}/cancel`).send({ reason: 'Customer left' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', cancel_reason: 'Customer left' });
    const payment = await paymentFor(started.body.data.id);
    expect(payment.status).toBe('CANCELLED');

    // The customer pays anyway.
    paystackSays({ status: 'success' });
    await webhook(payment);
    const after = await paymentFor(started.body.data.id);
    expect(after.status).toBe('CAPTURED');
    const intent = await t.trx('supermarket_sale_intents').where({ id: started.body.data.id }).first();
    expect(intent.status).toBe('needs_review');
    expect(intent.sale_id).toBeNull();
    const bell = await t.trx('in_app_notifications').where({ tenant_id: ctx.a.id, user_id: users.manager }).whereRaw("JSON_EXTRACT(payload, '$.intentId') = ?", [intent.id]);
    expect(bell).toHaveLength(1);

    const review = await as(users.manager).get(`/api/v1/supermarket/online-sales/review?outlet_id=${market.outletId}`);
    expect(review.body.data.map((row) => String(row.id))).toContain(String(intent.id));

    expect((await as(users.operator).post(`/api/v1/supermarket/online-sales/${intent.id}/refund`).send({ reason: 'x' })).status).toBe(403);
    paystack.refundTransaction.mockResolvedValue({ status: 'processed', reference: payment.provider_reference, refundId: '555' });
    const refunded = await approvedPost(users.manager, `/api/v1/supermarket/online-sales/${intent.id}/refund`, { reason: 'Paid after cancel' }, 'supermarket.refund_online', intent.id);
    expect(refunded.status).toBe(200);
    expect(refunded.body.data.status).toBe('refunded');
    expect(refunded.body.meta.refund).toMatchObject({ status: 'CAPTURED', amount: '203.00', parent_payment_id: payment.id });
    expect((await paymentFor(started.body.data.id)).status).toBe('REFUNDED');
  });

  it('a cancel never overwrites a payment that has already captured', async () => {
    const started = await start();
    // The capture lands between the cashier's cancel and its write.
    await t.trx('payments').where({ id: (await paymentFor(started.body.data.id)).id }).update({ status: 'CAPTURED', captured_at: new Date() });
    const res = await as(users.operator).post(`/api/v1/supermarket/online-sales/${started.body.data.id}/cancel`).send({});
    expect(res.status).toBe(200);
    expect((await paymentFor(started.body.data.id)).status).toBe('CAPTURED');
    expect((await t.trx('supermarket_sale_intents').where({ id: started.body.data.id }).first()).status).toBe('pending');
  });

  it('cancelling a sale the customer already paid completes it instead', async () => {
    const started = await start();
    paystackSays({ status: 'success' });
    const res = await as(users.operator).post(`/api/v1/supermarket/online-sales/${started.body.data.id}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.sale).not.toBeNull();
  });

  it('expires an unpaid sale on check, and a failed payment closes it so the cashier can start again', async () => {
    const started = await start();
    await t.trx('supermarket_sale_intents').where({ id: started.body.data.id }).update({ expires_at: new Date(Date.now() - 1000) });
    const expired = await check(started.body.data.id);
    expect(expired.body.data).toMatchObject({ status: 'cancelled', cancel_reason: 'Expired before it was paid.' });

    const again = await start();
    paystackSays({ status: 'failed' });
    const failed = await check(again.body.data.id);
    expect(failed.body.data).toMatchObject({ status: 'cancelled', cancel_reason: 'The online payment failed.' });
    expect((await start()).status).toBe(201);
  });

  it('a Paystack outage on check changes nothing and says so', async () => {
    const started = await start();
    paystack.verifyTransaction.mockRejectedValue(new Error('timeout'));
    const res = await check(started.body.data.id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.meta.checkError).toMatch(/timeout/);
  });

  it('a tax change after the start keeps the money and flags it rather than recording a wrong sale', async () => {
    const started = await start();
    await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'SM_VAT_OC' }).update({ rate: '2.0000' });
    try {
      paystackSays({ status: 'success' });
      const res = await check(started.body.data.id);
      expect(res.body.data.status).toBe('needs_review');
      expect(res.body.data.review_reason).toMatch(/amount due changed/);
      expect((await paymentFor(started.body.data.id)).status).toBe('CAPTURED');
    } finally {
      await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'SM_VAT_OC' }).update({ rate: '1.5000' });
    }
  });

  it('void of an online sale refunds at Paystack, returns the stock and voids the sale', async () => {
    const started = await start();
    paystackSays({ status: 'success' });
    const done = await check(started.body.data.id);
    const saleId = done.body.data.sale.id;
    const before = Number(await onHand());

    paystack.refundTransaction.mockResolvedValue({ status: 'processed', reference: 'x', refundId: '901' });
    const voided = await approvedPost(users.manager, `/api/v1/supermarket/sales/${saleId}/void`, { reason: 'Wrong item' }, 'supermarket.void_sale', saleId);
    expect(voided.status).toBe(200);
    expect(voided.body.data.voided_at).not.toBeNull();
    expect(voided.body.meta.refund).toMatchObject({ status: 'CAPTURED', amount: '203.00' });
    expect(Number(await onHand())).toBe(before + 2);
    expect((await paymentFor(started.body.data.id)).status).toBe('REFUNDED');
    expect(paystack.refundTransaction).toHaveBeenCalledTimes(1);

    const again = await approvedPost(users.manager, `/api/v1/supermarket/sales/${saleId}/void`, { reason: 'Again' }, 'supermarket.void_sale', saleId);
    expect(again.status).toBe(409);
    expect(paystack.refundTransaction).toHaveBeenCalledTimes(1);
  });

  it('a refund Paystack has not processed yet voids the sale now and completes when Paystack confirms', async () => {
    const started = await start();
    paystackSays({ status: 'success' });
    const saleId = (await check(started.body.data.id)).body.data.sale.id;
    paystack.refundTransaction.mockResolvedValue({ status: 'pending', reference: 'x', refundId: '902' });
    const voided = await approvedPost(users.manager, `/api/v1/supermarket/sales/${saleId}/void`, { reason: 'Returned' }, 'supermarket.void_sale', saleId);
    expect(voided.body.data.voided_at).not.toBeNull();
    expect(voided.body.meta.refund.status).toBe('PENDING');
    expect((await paymentFor(started.body.data.id)).status).toBe('CAPTURED');

    paystack.fetchRefund.mockResolvedValue({ status: 'processed', refundId: '902' });
    const read = await as(users.manager).get(`/api/v1/supermarket/sales/${saleId}`);
    expect(read.body.data.payment_status).toBe('REFUNDED');
    expect(paystack.fetchRefund).toHaveBeenCalledWith({ refundId: '902' });
  });

  it('the background sweep completes a pending refund by itself, and a failed one bells a manager', async () => {
    const started = await start();
    paystackSays({ status: 'success' });
    const saleId = (await check(started.body.data.id)).body.data.sale.id;
    paystack.refundTransaction.mockResolvedValue({ status: 'pending', reference: 'x', refundId: '903' });
    await approvedPost(users.manager, `/api/v1/supermarket/sales/${saleId}/void`, { reason: 'Returned' }, 'supermarket.void_sale', saleId);
    expect((await paymentFor(started.body.data.id)).status).toBe('CAPTURED');

    paystack.fetchRefund.mockResolvedValue({ status: 'processing', refundId: '903' });
    await runSupermarketRefundSweep();
    expect((await paymentFor(started.body.data.id)).status).toBe('CAPTURED'); // still not final: left alone

    paystack.fetchRefund.mockResolvedValue({ status: 'processed', refundId: '903' });
    await runSupermarketRefundSweep();
    expect((await paymentFor(started.body.data.id)).status).toBe('REFUNDED');

    const second = await start();
    paystackSays({ status: 'success' });
    const saleTwo = (await check(second.body.data.id)).body.data.sale.id;
    paystack.refundTransaction.mockResolvedValue({ status: 'pending', reference: 'y', refundId: '904' });
    await approvedPost(users.manager, `/api/v1/supermarket/sales/${saleTwo}/void`, { reason: 'Returned' }, 'supermarket.void_sale', saleTwo);
    paystack.fetchRefund.mockResolvedValue({ status: 'failed', refundId: '904' });
    await runSupermarketRefundSweep();
    const bell = await t.trx('in_app_notifications').where({ tenant_id: ctx.a.id, user_id: users.manager }).whereRaw("JSON_EXTRACT(payload, '$.refundPaymentId') IS NOT NULL");
    expect(bell.length).toBeGreaterThan(0);
  });

  it('a refused refund changes nothing, and a cash sale still voids the old way', async () => {
    const started = await start();
    paystackSays({ status: 'success' });
    const saleId = (await check(started.body.data.id)).body.data.sale.id;
    paystack.refundTransaction.mockRejectedValue(new Error('Insufficient balance'));
    const refused = await approvedPost(users.manager, `/api/v1/supermarket/sales/${saleId}/void`, { reason: 'x' }, 'supermarket.void_sale', saleId);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await t.trx('supermarket_sales').where({ id: saleId }).first()).voided_at).toBeNull();
    expect((await paymentFor(started.body.data.id)).status).toBe('CAPTURED');

    const cash = await as(users.operator).post('/api/v1/supermarket/sales').send({ outlet_id: market.outletId, method: 'cash', items: [{ menu_item_id: biscuit, quantity: 1 }] });
    const cashVoid = await approvedPost(users.manager, `/api/v1/supermarket/sales/${cash.body.data.id}/void`, { reason: 'Test' }, 'supermarket.void_sale', cash.body.data.id);
    expect(cashVoid.status).toBe(200);
    expect(paystack.refundTransaction).toHaveBeenCalledTimes(1);
  });

  it('the generic cashiering refund refuses a supermarket payment', async () => {
    const started = await start();
    paystackSays({ status: 'success' });
    await check(started.body.data.id);
    const payment = await paymentFor(started.body.data.id);
    const res = await as(users.manager).post(`/api/v1/cashiering/payments/${payment.id}/refund`).send({ reason: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_USE_SUPERMARKET_VOID');
    expect(paystack.refundTransaction).not.toHaveBeenCalled();
  });

  it('a non-supermarket tender, an unknown outlet and a role without sales rights are refused', async () => {
    expect((await start({ tender: 'card' })).status).toBe(400);
    expect((await start({ tender: 'cash' })).status).toBe(400);
    const [viewerId] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `hk-${next()}@example.com`, first_name: 'H', last_name: 'K', password_hash: 'x', status: 'active' });
    await setRole(viewerId, 'housekeeping');
    expect((await start({}, viewerId)).status).toBe(403);
  });
});
