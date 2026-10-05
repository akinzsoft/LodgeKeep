'use strict';

/**
 * Supermarket online card sales under real pooled connections (a shared
 * rolled-back transaction cannot prove a race: there, "two connections" are
 * one session). Each case runs several rounds and proves, for a paid sale:
 *
 *   - the Paystack webhook and the till's own check both finishing the sale
 *     at once → exactly ONE sale, ONE settlement, ONE receipt number, stock
 *     deducted once;
 *   - two webhook deliveries racing each other → the same;
 *   - a cashier cancel racing the customer's payment → exactly one outcome
 *     (a completed sale, or a cancelled intent whose money is flagged for a
 *     refund) — never a sale AND a refund flag, never neither;
 *   - an online completion racing cash sales at the same till → every
 *     receipt number lands once with no gap, and the stock level equals its ledger.
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

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const { gatewayRecordFor } = require('../helpers/gateway-record');
const { insertMenuItem } = require('../helpers/catalogue');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const cashieringService = require('../../src/modules/cashiering/service');
const { sumQuantity } = require('../../src/shared/quantity');

const ROUNDS = 3;

describe('Supermarket online card sales: real connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let userId;
  let otherUserId;
  let token;
  let otherToken;
  let outletId;
  let menuItemId;
  let stockItemId;
  let counter = 0;
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Online Race Tenant', slug: `online-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `online-race-prop-${suffix}`,
      name: 'Online Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2027-12-01',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    const mkUser = async (label) => {
      const [id] = await db()('users').insert({ tenant_id: tenantId, email: `${label}-${suffix}@example.com`, password_hash: `$2b$12$${'x'.repeat(53)}`, first_name: label, last_name: 'Cashier', status: 'active' });
      await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: id, role: 'manager' });
      return id;
    };
    userId = await mkUser('one');
    otherUserId = await mkUser('two');
    const keys = ['pos.operate', 'pos.manage', 'pos.stock_view', 'supermarket.sales', 'supermarket.report', 'supermarket.manage'];
    const perms = await db()('permissions').whereIn('permission_key', keys).select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));
    const sign = (id) => signAccessToken({ aud: 'staff', sub: String(id), tenant_id: String(tenantId), property_id: String(propertyId) });
    token = sign(userId);
    otherToken = sign(otherUserId);

    const integration = (await db()('platform_payment_integrations').where({ currency: 'NGN' }).first('id')).id;
    await db()('property_payment_subaccounts').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      platform_payment_integration_id: integration,
      subaccount_code: 'ACCT_race',
      bank_code: '057',
      bank_name: 'Zenith',
      account_number_last4: '1784',
      account_name: 'Race',
      percentage_charge: '0.00',
      is_active: true,
    });
    [outletId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'RMART', name: 'Race Mart', type: 'supermarket' });
    [menuItemId] = await insertMenuItem(db(), { tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, name: 'Race biscuit', category: 'Snacks', price: '100.00' });
    [stockItemId] = await db()('stock_items').insert({ tenant_id: tenantId, property_id: propertyId, name: 'Race pack', unit: 'pack', purchase_cost: '40.00' });
    await db()('pos_menu_item_components').insert({ tenant_id: tenantId, property_id: propertyId, menu_item_id: menuItemId, stock_item_id: stockItemId, quantity: '1.000' });
    await db()('stock_movements').insert({ tenant_id: tenantId, property_id: propertyId, stock_item_id: stockItemId, outlet_id: outletId, type: 'received', quantity: '500.000', unit_cost: '40.00', total_cost: '20000.00', business_date: '2027-12-01', occurred_at: new Date() });
    await db()('stock_levels').insert({ tenant_id: tenantId, property_id: propertyId, stock_item_id: stockItemId, outlet_id: outletId, current_quantity: '500.000' });
  });

  afterAll(async () => {
    for (const table of [
      'supermarket_sale_intents', 'supermarket_sale_lines', 'supermarket_sales', 'supermarket_receipt_sequences', 'supermarket_barcodes',
      'payment_webhook_events', 'stock_movements', 'pos_menu_item_components', 'stock_levels', 'stock_items',
      'audit_log', 'idempotency_keys', 'outbox_events', 'pos_order_settlements', 'payments', 'pos_order_items', 'pos_orders',
      'pos_outlet_menu_items', 'pos_menu_items', 'pos_terminals', 'pos_outlet_categories', 'pos_menu_categories', 'pos_outlets',
      'property_payment_subaccounts', 'in_app_notifications', 'user_property_access', 'role_permissions', 'users', 'roles', 'properties',
    ]) {
      await db()(table).where({ tenant_id: tenantId }).delete();
    }
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
    paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.com/x', accessCode: 'x', reference: 'r' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => console.error.mockRestore());

  const post = (url, who = token) => req.post(url).set('Authorization', `Bearer ${who}`).set('Idempotency-Key', `oc-${next()}`);
  const startSale = async (who = token) => {
    const res = await post('/api/v1/supermarket/online-sales', who).send({ outlet_id: outletId, tender: 'online', items: [{ menu_item_id: menuItemId, quantity: 2 }] });
    expect(res.status).toBe(201);
    return res.body.data.id;
  };
  const intentRow = (id) => db()('supermarket_sale_intents').where({ id }).first();
  const payment = async (intentId) => db()('payments').where({ id: (await intentRow(intentId)).payment_id }).first();
  const paidRecord = () =>
    paystack.verifyTransaction.mockImplementation(async ({ reference }) => {
      await new Promise((resolve) => setTimeout(resolve, 15)); // widen the window
      return gatewayRecordFor(await db()('payments').where({ provider_reference: reference }).first());
    });
  const webhook = (pay) => {
    paystack.verifyWebhookSignature.mockReturnValue(true);
    const body = { event: 'charge.success', data: { id: 800000 + Math.floor(Math.random() * 900000), reference: pay.provider_reference, status: 'success' } };
    return cashieringService.handlePaystackWebhook({ rawBody: JSON.stringify(body), signatureHeader: 'mocked', parsedBody: body });
  };
  const level = async () => Number((await db()('stock_levels').where({ stock_item_id: stockItemId, outlet_id: outletId }).first('current_quantity')).current_quantity);
  async function assertOneSale(intentId) {
    const intent = await intentRow(intentId);
    expect(intent.status).toBe('completed');
    const pay = await db()('payments').where({ id: intent.payment_id }).first();
    expect(pay.status).toBe('CAPTURED');
    expect(await db()('pos_order_settlements').where({ payment_id: pay.id })).toHaveLength(1);
    expect(await db()('supermarket_sales').where({ id: intent.sale_id })).toHaveLength(1);
    const settlement = await db()('pos_order_settlements').where({ payment_id: pay.id }).first();
    expect(await db()('stock_movements').where({ pos_order_settlement_id: settlement.id, type: 'sold' })).toHaveLength(1);
  }
  async function assertLevelMatchesLedger() {
    const rows = await db()('stock_movements').where({ stock_item_id: stockItemId, outlet_id: outletId }).select('quantity');
    expect(await level()).toBe(Number(sumQuantity(rows.map((r) => r.quantity))));
  }

  test('the webhook and the till check both finishing the sale: one sale, one receipt, stock deducted once', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const before = await level();
      const intentId = await startSale();
      paidRecord();
      const results = await Promise.allSettled([webhook(await payment(intentId)), post(`/api/v1/supermarket/online-sales/${intentId}/check`).send({})]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      await assertOneSale(intentId);
      expect(await level()).toBe(before - 2);
    }
    await assertLevelMatchesLedger();
  });

  test('two webhook deliveries racing each other complete the sale once', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const intentId = await startSale();
      paidRecord();
      const pay = await payment(intentId);
      const results = await Promise.allSettled([webhook(pay), webhook(pay)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      await assertOneSale(intentId);
    }
  });

  test('a cancel racing the customer payment ends in exactly one outcome, never a sale and a refund flag', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const intentId = await startSale();
      paidRecord();
      const pay = await payment(intentId);
      await Promise.allSettled([webhook(pay), post(`/api/v1/supermarket/online-sales/${intentId}/cancel`).send({ reason: 'race' })]);
      // Whatever the interleaving, a later check settles any leftover.
      await post(`/api/v1/supermarket/online-sales/${intentId}/check`).send({});
      const intent = await intentRow(intentId);
      const after = await payment(intentId);
      expect(after.status).toBe('CAPTURED');
      expect(['completed', 'needs_review']).toContain(intent.status);
      if (intent.status === 'completed') {
        await assertOneSale(intentId);
      } else {
        expect(intent.sale_id).toBeNull();
        expect(await db()('pos_order_settlements').where({ payment_id: after.id })).toHaveLength(0);
        expect(await db()('in_app_notifications').where({ tenant_id: tenantId }).whereRaw("JSON_EXTRACT(payload, '$.intentId') = ?", [intent.id])).not.toHaveLength(0);
      }
    }
    await assertLevelMatchesLedger();
  });

  test('online completions racing cash sales at the same till: receipt numbers gapless, stock equals its ledger', async () => {
    const intents = [await startSale(token), await startSale(otherToken)];
    paidRecord();
    const cash = () => post('/api/v1/supermarket/sales').send({ outlet_id: outletId, method: 'cash', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
    const results = await Promise.allSettled([
      ...intents.map(async (id) => webhook(await payment(id))),
      cash(),
      cash(),
      cash(),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(5).fill('fulfilled'));
    for (const id of intents) await assertOneSale(id);
    const numbers = (await db()('supermarket_sales').where({ outlet_id: outletId }).select('receipt_number')).map((r) => Number(r.receipt_number)).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
    await assertLevelMatchesLedger();
  });
});
