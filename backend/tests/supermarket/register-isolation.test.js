'use strict';

/**
 * A supermarket sells only from the Supermarket screen. The POS Register (new tabs, and any route on an
 * existing tab) and guest QR ordering refuse a supermarket outlet; bars and restaurants are unchanged and
 * the Supermarket till still sells, pays online and voids.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { managerApproval, setApprovalPin } = require('../helpers/approvals');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem } = require('../helpers/catalogue');

const CODE = 'BUSINESS_RULE_SUPERMARKET_USE_SUPERMARKET_SCREEN';

describe('supermarket outlets are not sellable through the Register', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let martId;
  let barId;
  let martTerminal;
  let barTerminal;
  let users;
  let counter = 0;
  const DATE = '2027-12-05';

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (role) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(users[role])}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(users[role])}`).set('Idempotency-Key', `ri-${next()}`),
  });
  const scope = () => ({ tenant_id: ctx.a.id, property_id: propertyId });

  async function userWithRole(role) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'User', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    return id;
  }
  async function outlet(type, name) {
    const [id] = await t.trx('pos_outlets').insert({ ...scope(), code: `I${next()}`.slice(0, 30), name, type });
    return id;
  }
  async function tabAt(outletId) {
    const [id] = await t.trx('pos_orders').insert({ ...scope(), outlet_id: outletId, table_label: 'Old tab', source: 'staff' });
    return id;
  }
  const orderCount = () => t.trx('pos_orders').where({ property_id: propertyId }).count({ n: '*' }).first();

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: DATE });
    martId = await outlet('supermarket', 'Isolated Mart');
    barId = await outlet('bar', 'Isolated Bar');
    [martTerminal] = await t.trx('pos_terminals').insert({ ...scope(), outlet_id: martId, device_ref: `MT-${next()}` });
    [barTerminal] = await t.trx('pos_terminals').insert({ ...scope(), outlet_id: barId, device_ref: `BT-${next()}` });
    for (const role of ['manager', 'pos_operator']) users[role] = await userWithRole(role);
    await setApprovalPin(t.trx, { tenantId: ctx.a.id, userId: users.manager });
  });
  users = {};

  describe('new tabs', () => {
    it('refuses to open a Register tab at a supermarket, for a cashier and a manager, writing nothing', async () => {
      const before = Number((await orderCount()).n);
      for (const role of ['pos_operator', 'manager']) {
        const res = await as(role).post('/api/v1/pos/orders').send({ outlet_id: martId, terminal_id: martTerminal, table_label: 'T1' });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe(CODE);
        expect(res.body.error.message).toContain('Isolated Mart');
      }
      expect(Number((await orderCount()).n)).toBe(before);
    });

    it('still opens a tab at a bar', async () => {
      const res = await as('pos_operator').post('/api/v1/pos/orders').send({ outlet_id: barId, terminal_id: barTerminal, table_label: 'T1' });
      expect(res.status).toBe(201);
    });
  });

  describe('an existing tab at a supermarket', () => {
    it('cannot be added to, previewed, checked out or settled through the Register; a manager can still void it', async () => {
      const [menuId] = await insertMenuItem(t.trx, { ...scope(), outlet_id: martId, name: `Item ${next()}`, category: 'Isolation Mart', price: '10.00' });
      const orderId = await tabAt(martId);
      const refuse = async (res) => {
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe(CODE);
      };
      await refuse(await as('pos_operator').post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: menuId, quantity: 1 }));
      await refuse(await as('pos_operator').get(`/api/v1/pos/orders/${orderId}/settlement-preview`));
      await refuse(await as('pos_operator').post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({}));
      await refuse(await as('pos_operator').post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }] }));
      expect(Number((await t.trx('pos_order_items').where({ pos_order_id: orderId }).count({ n: '*' }).first()).n)).toBe(0);
      expect(await t.trx('pos_order_settlements').where({ pos_order_id: orderId }).first('id')).toBeUndefined();

      const voided = await as('manager').post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'Left over from before the conversion' });
      expect(voided.status).toBe(200);
    });

    it('judges a tab LINE by its own tab: a split-group call cannot pair a bar tab id with a mart tab line', async () => {
      const [menuId] = await insertMenuItem(t.trx, { ...scope(), outlet_id: martId, name: `Line ${next()}`, category: 'Isolation Mart 3', price: '10.00' });
      const martTab = await tabAt(martId);
      const barTab = await tabAt(barId);
      const [lineId] = await t.trx('pos_order_items').insert({ ...scope(), pos_order_id: martTab, menu_item_id: menuId, quantity: 1, unit_price: '10.00', modifiers: null });
      const res = await as('pos_operator').post(`/api/v1/pos/orders/${barTab}/items/${lineId}/split-group`).send({ split_group: 'A' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(CODE);
    });

    it('does not change a tab at a bar', async () => {
      const [menuId] = await insertMenuItem(t.trx, { ...scope(), outlet_id: barId, name: `Beer ${next()}`, category: 'Isolation Bar', price: '5.00' });
      const orderId = await tabAt(barId);
      const added = await as('pos_operator').post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: menuId, quantity: 1 });
      expect(added.status).toBeLessThan(300);
      const settled = await as('pos_operator').post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }] });
      expect(settled.status).toBe(200);
    });
  });

  describe('the Supermarket screen still sells', () => {
    it('sells at the supermarket, then a manager voids the sale, through the supermarket routes', async () => {
      const [menuId] = await insertMenuItem(t.trx, { ...scope(), outlet_id: martId, name: `Mart ${next()}`, category: 'Isolation Mart 2', price: '20.00' });
      const sold = await as('pos_operator').post('/api/v1/supermarket/sales').send({ outlet_id: martId, method: 'cash', confirm_oversell: true, items: [{ menu_item_id: menuId, quantity: 2 }] });
      expect(sold.status).toBe(201);
      expect(sold.body.data.receipt_code).toBeTruthy();
      // The Register's settlement-void route refuses a supermarket tab even with a manager's approval: a sale is
      // voided through the supermarket, which keeps its receipt in step.
      const sale = await t.trx('supermarket_sales').where({ id: sold.body.data.id }).first();
      const settlement = await t.trx('pos_order_settlements').where({ id: sale.settlement_id }).first();
      const posApproval = await managerApproval(t.request, { token: tokenFor(users.manager), approverUserId: users.manager, action: 'pos.void_settlement', targetId: settlement.id });
      const viaRegister = await as('manager').post(`/api/v1/pos/orders/${settlement.pos_order_id}/settlements/${settlement.id}/void`).set('X-Manager-Approval', posApproval).send({ reason: 'test' });
      expect(viaRegister.status).toBe(422);
      expect(viaRegister.body.error.code).toBe(CODE);
      expect((await t.trx('pos_order_settlements').where({ id: settlement.id }).first()).voided_at).toBeNull();

      const approval = await managerApproval(t.request, { token: tokenFor(users.manager), approverUserId: users.manager, action: 'supermarket.void_sale', targetId: sold.body.data.id });
      const voided = await as('manager').post(`/api/v1/supermarket/sales/${sold.body.data.id}/void`).set('X-Manager-Approval', approval).send({ reason: 'test' });
      expect(voided.status).toBe(200);
    });
  });

  describe('guest QR ordering', () => {
    const body = (outletId) => ({ outlet_id: outletId, type: 'table', table_label: 'T9', base_url: 'https://alpha.test/qr-order' });

    it('refuses a QR code and guest ordering at a supermarket, and allows them at a bar', async () => {
      const code = await as('manager').post('/api/v1/pos/qr-tokens').send(body(martId));
      expect(code.status).toBe(422);
      expect(code.body.error.code).toBe(CODE);
      const toggle = await as('manager').post(`/api/v1/pos/outlets/${martId}/toggle-guest-ordering`).send({ enabled: true });
      expect(toggle.status).toBe(422);
      expect(toggle.body.error.code).toBe(CODE);
      expect((await t.trx('pos_outlets').where({ id: martId }).first('guest_ordering_enabled')).guest_ordering_enabled).toBeFalsy();

      expect((await as('manager').post('/api/v1/pos/qr-tokens').send(body(barId))).status).toBe(201);
      expect((await as('manager').post(`/api/v1/pos/outlets/${barId}/toggle-guest-ordering`).send({ enabled: true })).status).toBe(200);
    });
  });
});
