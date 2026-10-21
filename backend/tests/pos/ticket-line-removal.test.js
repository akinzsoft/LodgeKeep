'use strict';

/**
 * Removing a line from an open Register tab. A line may be removed WITHOUT a typed reason only while it is newer than
 * the grace window (POS_VOID_GRACE_SECONDS, default 120 s, from the row's created_at) AND the tab's kitchen ticket is
 * not marked done; the server decides, a reasonless request outside that is refused. Whenever a reason is typed
 * (the Register's quick picks), it is stored as given. Tab ownership rules are unchanged. A line cannot be added or
 * removed once a card payment for the check was captured, and a discount or voucher can never keep applying to an
 * item that is gone. The preview's total is the amount settlement charges.
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
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');
const { signAccessToken } = require('../../src/auth/tokens');
const paystackModule = require('../../src/modules/cashiering/paystack-adapter');
const { insertMenuItem } = require('../helpers/catalogue');

const paystack = paystackModule.__mockAdapter;

describe('removing lines from an open tab', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let outlet;
  let counter = 0;
  const users = {};
  let reasons;

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `rm-${next()}`),
  });

  async function userWithRole(role) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'Tester', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    return id;
  }

  async function openTab(userId = users.operator, lines = [[outlet.beer, 1]]) {
    const opened = await as(userId).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `R${next()}`.slice(0, 20) });
    expect(opened.status).toBe(201);
    const orderId = opened.body.data.id;
    for (const [menuItemId, quantity] of lines) {
      for (let i = 0; i < quantity; i += 1) {
        const added = await as(userId).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: menuItemId, quantity: 1 });
        expect(added.status).toBe(200);
      }
    }
    return orderId;
  }

  const itemsOf = (orderId) => t.trx('pos_order_items').where({ pos_order_id: orderId }).orderBy('id');
  const voidItem = (userId, orderId, itemId, body = {}) => as(userId).post(`/api/v1/pos/orders/${orderId}/items/${itemId}/void`).send(body);
  const age = (itemId, seconds) => t.trx('pos_order_items').where({ id: itemId }).update({ created_at: new Date(Date.now() - seconds * 1000) });
  const preview = async (userId, orderId) => (await as(userId).get(`/api/v1/pos/orders/${orderId}/settlement-preview`)).body.data;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-09-01' });
    users.manager = await userWithRole('manager');
    users.operator = await userWithRole('pos_operator');
    users.other = await userWithRole('pos_operator');

    const suffix = Date.now().toString(36).slice(-6);
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `RM-${suffix}`, name: 'Removal Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `RM-T-${suffix}` });
    const [beer] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Rm Fanta', category: 'Drinks', price: '100.00' });
    const [snack] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Rm Sprite', category: 'Drinks', price: '40.00' });
    outlet = { outletId, terminalId, beer, snack };

    const list = await as(users.manager).get('/api/v1/discounts/reasons');
    reasons = Object.fromEntries(list.body.data.map((reason) => [reason.code, String(reason.id)]));
  });

  beforeEach(async () => {
    await flushRateLimitPrefixes(['voucher-user:', 'voucher-ip:']);
    paystack.initializeTransaction.mockReset();
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay/x', accessCode: 'x-access', reference }));
    paystackModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
  });

  describe('the grace window', () => {
    it('accepts a reasonless void of a fresh line on an unsent tab, with the automatic reason and an audit row', async () => {
      const orderId = await openTab();
      const [item] = await itemsOf(orderId);
      const res = await voidItem(users.operator, orderId, item.id);
      expect(res.status).toBe(200);
      const stored = (await itemsOf(orderId))[0];
      expect(stored.voided_at).not.toBeNull();
      expect(stored.void_reason).toBe('Removed within grace window');
      expect(String(stored.voided_by_user_id)).toBe(String(users.operator));
      const audit = await t.trx('audit_log').where({ entity_type: 'pos_order_items', entity_id: item.id, action: 'void' }).first();
      expect(audit).toBeTruthy();
      expect(audit.reason).toBe('Removed within grace window');
    });

    it('refuses a reasonless void once the line is older than the window, changing nothing; a typed reason works', async () => {
      const orderId = await openTab();
      const [item] = await itemsOf(orderId);
      await age(item.id, 600);
      const refused = await voidItem(users.operator, orderId, item.id);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_MISSING_FIELD');
      expect((await itemsOf(orderId))[0].voided_at).toBeNull();
      const blank = await voidItem(users.operator, orderId, item.id, { reason: '   ' });
      expect(blank.status).toBe(400);
      const ok = await voidItem(users.operator, orderId, item.id, { reason: 'Customer changed mind' });
      expect(ok.status).toBe(200);
      expect((await itemsOf(orderId))[0].void_reason).toBe('Customer changed mind');
    });

    it('refuses a reasonless void once the kitchen ticket is marked done, even for a fresh line', async () => {
      const orderId = await openTab();
      const [item] = await itemsOf(orderId);
      await t.trx('pos_orders').where({ id: orderId }).update({ ticket_done_at: new Date(), ticket_done_by_user_id: users.operator });
      const refused = await voidItem(users.operator, orderId, item.id);
      expect(refused.status).toBe(400);
      expect((await itemsOf(orderId))[0].voided_at).toBeNull();
      const ok = await voidItem(users.operator, orderId, item.id, { reason: 'Wrong item' });
      expect(ok.status).toBe(200);
    });

    it('stores a quick-pick reason (including "Other: text") exactly as sent', async () => {
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      const [a, b] = await itemsOf(orderId);
      expect((await voidItem(users.operator, orderId, a.id, { reason: 'Item unavailable' })).status).toBe(200);
      expect((await voidItem(users.operator, orderId, b.id, { reason: 'Other: guest left' })).status).toBe(200);
      const rows = await itemsOf(orderId);
      expect(rows.map((r) => r.void_reason)).toEqual(['Item unavailable', 'Other: guest left']);
    });

    it('does not loosen ownership: another operator is refused even inside the window; a manager works on a tab', async () => {
      const orderId = await openTab();
      const [item] = await itemsOf(orderId);
      const refused = await voidItem(users.other, orderId, item.id);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN_TAB_NOT_YOURS');
      expect((await voidItem(users.manager, orderId, item.id)).status).toBe(200);
    });

    it('lets the minus button remove one of several rows and the trash button all of a line', async () => {
      const orderId = await openTab(users.operator, [[outlet.beer, 3], [outlet.snack, 1]]);
      const rows = await itemsOf(orderId);
      expect((await voidItem(users.operator, orderId, rows[0].id)).status).toBe(200);
      let live = (await itemsOf(orderId)).filter((r) => !r.voided_at);
      expect(live.filter((r) => String(r.menu_item_id) === String(outlet.beer))).toHaveLength(2);
      for (const row of live.filter((r) => String(r.menu_item_id) === String(outlet.beer))) {
        expect((await voidItem(users.operator, orderId, row.id)).status).toBe(200);
      }
      live = (await itemsOf(orderId)).filter((r) => !r.voided_at);
      expect(live).toHaveLength(1);
      expect(String(live[0].menu_item_id)).toBe(String(outlet.snack));
    });
  });

  describe('totals', () => {
    it('recalculates tax, service charge and total when a line is removed, and the preview total is what settlement charges', async () => {
      const orderId = await openTab(users.operator, [[outlet.beer, 2], [outlet.snack, 1]]);
      const before = await preview(users.operator, orderId);
      expect(before.groups[0].subtotal).toBe('240.00');
      const rows = await itemsOf(orderId);
      expect((await voidItem(users.operator, orderId, rows[0].id)).status).toBe(200);
      const after = await preview(users.operator, orderId);
      expect(after.groups[0].subtotal).toBe('140.00');
      const g = after.groups[0];
      const cents = (v) => Math.round(Number(v) * 100);
      expect(cents(g.subtotal) + cents(g.taxAmount) + cents(g.serviceCharge)).toBe(cents(g.total));
      const settled = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }] });
      expect(settled.status).toBe(200);
      const s = settled.body.data.settlements[0];
      expect(s.subtotal).toBe(g.subtotal);
      expect(cents(s.subtotal) + cents(s.tax_amount) + cents(s.service_charge)).toBe(cents(g.total));
      expect(s.tax_amount).toBe(g.taxAmount);
      expect(s.service_charge).toBe(g.serviceCharge);
    });
  });

  describe('a captured card payment', () => {
    it('blocks adding and removing lines, with a clear message, until it is settled or refunded', async () => {
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      const started = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
      expect(started.status).toBe(201);
      await t.trx('payments').where({ id: started.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date(), provider_channel: 'card' });
      const [item] = await itemsOf(orderId);
      const removed = await voidItem(users.operator, orderId, item.id);
      expect(removed.status).toBe(422);
      expect(removed.body.error.code).toBe('BUSINESS_RULE_POS_ORDER_PAYMENT_IN_PROGRESS');
      expect(removed.body.error.message).toMatch(/card payment/i);
      const added = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.snack, quantity: 1 });
      expect(added.status).toBe(422);
      expect(added.body.error.code).toBe('BUSINESS_RULE_POS_ORDER_PAYMENT_IN_PROGRESS');
      expect(await itemsOf(orderId)).toHaveLength(2);
      expect((await itemsOf(orderId)).every((r) => !r.voided_at)).toBe(true);
    });
  });

  describe('discounts and vouchers when a line goes', () => {
    const requestLineDiscount = (orderId, itemId) =>
      as(users.operator).post(`/api/v1/pos/orders/${orderId}/discounts`).send({ reason_id: reasons.complaint, scope: 'line', item_id: String(itemId), type: 'percent', value: '5' });

    it('takes a line discount off when its product is no longer on the check, and says so', async () => {
      const orderId = await openTab(users.operator, [[outlet.beer, 1], [outlet.snack, 1]]);
      const [beerRow, snackRow] = await itemsOf(orderId);
      const made = await requestLineDiscount(orderId, beerRow.id);
      expect(made.status).toBe(201);
      const discountId = made.body.data.id;
      const res = await voidItem(users.operator, orderId, beerRow.id);
      expect(res.status).toBe(200);
      expect(res.body.data.discounts_removed).toHaveLength(1);
      expect(String(res.body.data.discounts_removed[0].id)).toBe(String(discountId));
      const row = await t.trx('discounts').where({ id: discountId }).first();
      expect(row.status).toBe('removed');
      const p = await preview(users.operator, orderId);
      expect(p.groups[0].subtotal).toBe('40.00');
      expect(p.groups[0].discountTotal).toBeUndefined();
      expect(String(snackRow.id)).toBeTruthy();
    });

    it('keeps a line discount while another row of the same product remains', async () => {
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      const [first] = await itemsOf(orderId);
      const made = await requestLineDiscount(orderId, first.id);
      expect(made.status).toBe(201);
      // The discount is on one specific row; voiding the OTHER row leaves it standing.
      const rows = await itemsOf(orderId);
      const res = await voidItem(users.operator, orderId, rows[1].id);
      expect(res.status).toBe(200);
      expect(res.body.data.discounts_removed).toBeUndefined();
      expect((await t.trx('discounts').where({ id: made.body.data.id }).first()).status).toBe('active');
    });

    it('releases a voucher and removes it when the check is emptied, and keeps it otherwise', async () => {
      const created = await as(users.manager).post('/api/v1/discounts/vouchers').send({ type: 'percent', value: '10', valid_to: '2030-12-31' });
      expect(created.status).toBe(201);
      const code = created.body.data.code;
      const voucherId = created.body.data.id;
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      const applied = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/voucher`).send({ code });
      expect(applied.status).toBe(201);
      const [first, second] = await itemsOf(orderId);
      const keep = await voidItem(users.operator, orderId, first.id);
      expect(keep.status).toBe(200);
      expect(keep.body.data.discounts_removed).toBeUndefined();
      expect((await preview(users.operator, orderId)).groups[0].discountTotal).toBe('10.00');
      const empty = await voidItem(users.operator, orderId, second.id);
      expect(empty.status).toBe(200);
      expect(empty.body.data.discounts_removed).toHaveLength(1);
      expect(empty.body.data.discounts_removed[0].kind).toBe('voucher');
      const link = await t.trx('voucher_redemptions').where({ voucher_id: voucherId }).orderBy('id', 'desc').first();
      expect(link.status).toBe('released');
    });
  });
});
