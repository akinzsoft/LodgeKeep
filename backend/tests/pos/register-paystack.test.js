'use strict';

/**
 * HTTP-level tests for the POS Register's card/NQR checkout through
 * Paystack: `POST /pos/orders/:id/paystack-checkout`, its `/verify`
 * companion, and `settleOrder`'s rule that a card/NQR check only settles
 * against a payment Paystack captured for that exact check and amount.
 *
 * Paystack is mocked at the adapter boundary, like every other Paystack
 * test in this suite. Ambient tax: `tests/helpers/fixtures.js` seeds a 7.5%
 * VAT on `ctx.a`'s property, so a ₦20.00 item carries ₦1.50 tax, the fixed
 * 7.5% service charge adds ₦1.50, and the check total is ₦23.00.
 */

// Gap closure: `paystack-adapter.js` is now a factory resolved per-currency
// via `resolveAdapterForCurrency` (a real DB read of
// `platform_payment_integrations` in production, seeded for NGN by
// `tests/helpers/fixtures.js` regardless of real credentials). Mocking
// THAT function to always return one fixed, fully-mocked adapter object —
// rather than mocking the old flat exports directly — keeps every
// `paystack.xxx.mockImplementation(...)` call below working unchanged,
// while genuinely exercising `properties[0]`'s own real, fixture-seeded
// `property_payment_subaccounts` row (mirrors
// `tests/cashiering/cashiering.test.js`'s own identical fix).
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

const { recordForStoredPayment } = require('../helpers/gateway-record');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const { scopedDb } = require('../../src/db');
const { workerContext } = require('../../src/modules/tenancy/context');
const cashieringService = require('../../src/modules/cashiering/service');

describe('POS Register — Paystack card/NQR checkout', () => {
  const t = useTestApp();
  let ctx;
  let token;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-03-01' });
    const userId = ctx.a.users[1].id;
    const propertyId = ctx.a.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role: 'pos_operator' });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role: 'pos_operator' });
    token = tokenFor(ctx.a, userId);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/reg', accessCode: 'reg-access', reference: 'r' });
    // `jest.resetAllMocks()` above wipes EVERY mock's implementation,
    // including `resolveAdapterForCurrency`'s own fixed one set in the
    // `jest.mock()` factory above — re-establish it here, every test,
    // or `startPaystackCheckout`/`verifyPayment` destructure `undefined`.
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
  });

  function tokenFor(tenant, userId) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[0].id),
    });
  }

  let counter = 0;
  function idemKey() {
    counter += 1;
    return `reg-paystack-${counter}`;
  }

  async function openTabWithItem(tenant = ctx.a, authToken = token) {
    counter += 1;
    const suffix = `${Date.now()}-${counter}`;
    const propertyId = tenant.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: tenant.id, property_id: propertyId, code: `REG-${suffix}`, name: 'Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: tenant.id, property_id: propertyId, outlet_id: outletId, device_ref: `T-${suffix}` });
    const [menuItemId] = await t.trx('pos_menu_items').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      outlet_id: outletId,
      name: 'Beer',
      category: 'Drinks',
      price: '20.00',
    });
    const opened = await t.request
      .post('/api/v1/pos/orders')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ outlet_id: outletId, terminal_id: terminalId, table_label: 'T1' })
      .expect(201);
    await t.request
      .post(`/api/v1/pos/orders/${opened.body.data.id}/items`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ menu_item_id: menuItemId, quantity: 1 })
      .expect(200);
    return { orderId: opened.body.data.id, menuItemId };
  }

  function startCheckout(orderId, body) {
    return t.request
      .post(`/api/v1/pos/orders/${orderId}/paystack-checkout`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey())
      .send(body);
  }

  function settle(orderId, settlement) {
    return t.request
      .post(`/api/v1/pos/orders/${orderId}/settle`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey())
      .send({ settlements: [settlement] });
  }

  async function capture(paymentId) {
    await t.trx('payments').where({ id: paymentId }).update({ status: 'CAPTURED', captured_at: new Date() });
  }

  it('prices the check server-side (net + tax + 7.5% service) and opens Paystack with every channel the account supports', async () => {
    const { orderId } = await openTabWithItem();
    const res = await startCheckout(orderId, { tender: 'card', amount: '1.00' });

    expect(res.status).toBe(201);
    expect(res.body.meta.accessCode).toBe('reg-access');
    expect(res.body.data).toMatchObject({ amount: '23.00', tender: 'card', settlement_target: 'pos_register', status: 'PENDING' });
    expect(paystack.initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: '23.00' }));
    // No channel restriction for Card — the guest can pay by card, USSD, transfer, etc.
    expect(paystack.initializeTransaction.mock.calls[0][0].channels).toBeUndefined();
    // No customer email given — the cashier's own address stands in for Paystack's receipt.
    expect(paystack.initializeTransaction.mock.calls[0][0].email).toBe(ctx.a.users[1].email);
  });

  it('opens NQR as a QR-only checkout and uses the customer email when given', async () => {
    const { orderId } = await openTabWithItem();
    const res = await startCheckout(orderId, { tender: 'nqr', customer_email: 'walkin@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.data.tender).toBe('nqr');
    expect(paystack.initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({ channels: ['qr'], email: 'walkin@example.com' }));
  });

  it('reopens the same unpaid transaction on a retry instead of starting a second charge', async () => {
    const { orderId } = await openTabWithItem();
    const first = await startCheckout(orderId, { tender: 'card' });
    const retry = await startCheckout(orderId, { tender: 'card' });

    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(retry.body.meta.accessCode).toBe('reg-access');
    expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
  });

  it('cancels an unpaid payment and starts a new one when the tender changes', async () => {
    const { orderId } = await openTabWithItem();
    const card = await startCheckout(orderId, { tender: 'card' });
    const nqr = await startCheckout(orderId, { tender: 'nqr' });

    expect(nqr.body.data.id).not.toBe(card.body.data.id);
    const old = await t.trx('payments').where({ id: card.body.data.id }).first();
    expect(old.status).toBe('CANCELLED');
  });

  it('returns an already-captured payment without calling Paystack again', async () => {
    const { orderId } = await openTabWithItem();
    const first = await startCheckout(orderId, { tender: 'card' });
    await capture(first.body.data.id);

    const again = await startCheckout(orderId, { tender: 'card' });
    expect(again.body.data).toMatchObject({ id: first.body.data.id, status: 'CAPTURED' });
    expect(again.body.meta.accessCode).toBeNull();
    expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps the local payment and answers 202 when Paystack cannot be reached', async () => {
    const { orderId } = await openTabWithItem();
    paystack.initializeTransaction.mockRejectedValue(new Error('Paystack unreachable'));
    const res = await startCheckout(orderId, { tender: 'card' });

    expect(res.status).toBe(202);
    expect(res.body.meta.checkoutError).toBe('Paystack unreachable');
    expect(res.body.data.status).toBe('INITIATED');
  });

  it('rejects an unknown tender', async () => {
    const { orderId } = await openTabWithItem();
    const res = await startCheckout(orderId, { tender: 'cheque' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_TENDER');
  });

  describe('verify', () => {
    it('captures the payment when Paystack reports success, recording the channel the guest used', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: '999', channel: 'ussd' }));

      const res = await t.request
        .post(`/api/v1/pos/orders/${orderId}/paystack-checkout/${started.body.data.id}/verify`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CAPTURED');
      expect(res.body.data.provider_channel).toBe('ussd');
      // Capture alone never settles a Register tab — the cashier's settle call does.
      const order = await t.trx('pos_orders').where({ id: orderId }).first();
      expect(order.status).toBe('open');
    });

    it('refuses a Paystack record that does not match the Register payment, leaving it PENDING', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      // Paystack says success but only collected 1 kobo.
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', amountSubunit: 1 }));

      const res = await t.request
        .post(`/api/v1/pos/orders/${orderId}/paystack-checkout/${started.body.data.id}/verify`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('PAYMENT_GATEWAY_RECORD_MISMATCH');
      const payment = await t.trx('payments').where({ id: started.body.data.id }).first();
      expect(payment.status).not.toBe('CAPTURED');
    });

    it('leaves an abandoned payment PENDING so the cashier can retry the same transaction', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'abandoned', providerPaymentId: '1' }));

      const res = await t.request
        .post(`/api/v1/pos/orders/${orderId}/paystack-checkout/${started.body.data.id}/verify`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.body.data.status).toBe('PENDING');
    });

    it('marks a definite gateway failure FAILED', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'failed', providerPaymentId: '1' }));

      const res = await t.request
        .post(`/api/v1/pos/orders/${orderId}/paystack-checkout/${started.body.data.id}/verify`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.body.data.status).toBe('FAILED');
    });

    it("404s for a payment that is not this tab's own", async () => {
      const a = await openTabWithItem();
      const b = await openTabWithItem();
      const started = await startCheckout(a.orderId, { tender: 'card' });

      const res = await t.request
        .post(`/api/v1/pos/orders/${b.orderId}/paystack-checkout/${started.body.data.id}/verify`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('settling a card/NQR check', () => {
    it('settles against the captured payment, recording tender and payment id', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'nqr' });
      await capture(started.body.data.id);

      const res = await settle(orderId, { method: 'card', service_charge: '1.50', payment_id: started.body.data.id });
      expect(res.status).toBe(200);
      expect(res.body.data.order.status).toBe('settled');
      expect(res.body.data.settlements[0]).toMatchObject({ method: 'card', tender: 'nqr', payment_id: started.body.data.id });
    });

    it('records tender "cash" on a cash settlement', async () => {
      const { orderId } = await openTabWithItem();
      const res = await settle(orderId, { method: 'cash', service_charge: '1.50' });
      expect(res.body.data.settlements[0].tender).toBe('cash');
    });

    it('refuses a card settlement with no Paystack payment', async () => {
      const { orderId } = await openTabWithItem();
      const res = await settle(orderId, { method: 'card', service_charge: '1.50' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('missing');
    });

    it('refuses a payment Paystack has not captured', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      const res = await settle(orderId, { method: 'card', service_charge: '1.50', payment_id: started.body.data.id });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('not_captured');
    });

    it('refuses a captured payment whose amount no longer matches the check', async () => {
      const { orderId, menuItemId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      await capture(started.body.data.id);
      await t.request
        .post(`/api/v1/pos/orders/${orderId}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ menu_item_id: menuItemId, quantity: 1 })
        .expect(200);

      const res = await settle(orderId, { method: 'card', service_charge: '3.00', payment_id: started.body.data.id });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('amount_mismatch');
    });

    it("refuses another tab's captured payment", async () => {
      const a = await openTabWithItem();
      const b = await openTabWithItem();
      const started = await startCheckout(a.orderId, { tender: 'card' });
      await capture(started.body.data.id);

      const res = await settle(b.orderId, { method: 'card', service_charge: '1.50', payment_id: started.body.data.id });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('wrong_check');
    });

    it('lists a captured-but-unsettled payment on the order so the Register can recover it', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      await capture(started.body.data.id);

      const res = await t.request.get(`/api/v1/pos/orders/${orderId}`).set('Authorization', `Bearer ${token}`);
      expect(res.body.data.registerPayments).toEqual([expect.objectContaining({ id: started.body.data.id, status: 'CAPTURED' })]);
    });

    it('refuses to void a tab holding a captured, unsettled payment', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      await capture(started.body.data.id);

      const res = await t.request
        .post(`/api/v1/pos/orders/${orderId}/void`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Empty tab removed from the Register' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_POS_ORDER_HAS_CAPTURED_PAYMENT');
    });
  });

  describe('review fixes: captured money never goes unrecorded', () => {
    it('asks Paystack before voiding a tab with an open checkout, and refuses the void once it turns out paid', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: '555' }));

      const res = await t.request
        .post(`/api/v1/pos/orders/${orderId}/void`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Customer left' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_POS_ORDER_HAS_CAPTURED_PAYMENT');
      expect((await t.trx('payments').where({ id: started.body.data.id }).first()).status).toBe('CAPTURED');
    });

    it('voids a tab whose checkout was abandoned, cancelling the unpaid payment', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'abandoned', providerPaymentId: '1' }));

      const res = await t.request
        .post(`/api/v1/pos/orders/${orderId}/void`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Customer left' });
      expect(res.status).toBe(200);
      expect((await t.trx('payments').where({ id: started.body.data.id }).first()).status).toBe('CANCELLED');
    });

    it('still records a capture Paystack reports for a checkout already cancelled locally', async () => {
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      await t.trx('payments').where({ id: started.body.data.id }).update({ status: 'CANCELLED' });
      const payment = await t.trx('payments').where({ id: started.body.data.id }).first();

      const db = scopedDb().for(workerContext({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id }));
      const result = await db.transaction((trx) => cashieringService.applyGatewayResult({ trx, payment, gatewayStatus: 'success', providerPaymentId: '777' }));
      expect(result.status).toBe('CAPTURED');
      expect(result.failure_reason).toMatch(/needs a refund/);
    });

    it('refuses to void a card settlement directly — the Paystack payment must be refunded instead', async () => {
      const managerId = ctx.a.users[0].id;
      await t.trx('user_property_access').where({ user_id: managerId, property_id: ctx.a.properties[0].id }).update({ role: 'manager' });
      const { orderId } = await openTabWithItem();
      const started = await startCheckout(orderId, { tender: 'card' });
      await capture(started.body.data.id);
      const settled = await settle(orderId, { method: 'card', service_charge: '1.50', payment_id: started.body.data.id });
      expect(settled.status).toBe(200);

      const res = await t.request
        .post(`/api/v1/pos/orders/${orderId}/settlements/${settled.body.data.settlements[0].id}/void`)
        .set('Authorization', `Bearer ${tokenFor(ctx.a, managerId)}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Wrong tab' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_POS_SETTLEMENT_PAID_BY_GATEWAY');
    });
  });

  describe('renaming a tab', () => {
    it('renames an open tab, trimming the name', async () => {
      const { orderId } = await openTabWithItem();
      const res = await t.request.post(`/api/v1/pos/orders/${orderId}/rename`).set('Authorization', `Bearer ${token}`).send({ table_label: '  Pool bar – John  ' });
      expect(res.status).toBe(200);
      expect(res.body.data.table_label).toBe('Pool bar – John');
    });

    it('rejects an empty or over-long name', async () => {
      const { orderId } = await openTabWithItem();
      const rename = (label) => t.request.post(`/api/v1/pos/orders/${orderId}/rename`).set('Authorization', `Bearer ${token}`).send({ table_label: label });
      expect((await rename('   ')).status).toBe(400);
      expect((await rename('x'.repeat(61))).status).toBe(400);
    });

    it('refuses to rename a tab that is no longer open', async () => {
      const { orderId } = await openTabWithItem();
      await t.trx('pos_orders').where({ id: orderId }).update({ status: 'settled' });
      const res = await t.request.post(`/api/v1/pos/orders/${orderId}/rename`).set('Authorization', `Bearer ${token}`).send({ table_label: 'Late name' });
      expect(res.status).toBe(409);
    });
  });

  it("cannot start a checkout against another tenant's tab", async () => {
    const otherToken = tokenFor(ctx.b, ctx.b.users[0].id);
    await t.trx('user_property_access').where({ user_id: ctx.b.users[0].id, property_id: ctx.b.properties[0].id }).update({ role: 'manager' });
    const { orderId } = await openTabWithItem(ctx.b, otherToken);

    const res = await startCheckout(orderId, { tender: 'card' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ORDER_NOT_FOUND');
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });
});
