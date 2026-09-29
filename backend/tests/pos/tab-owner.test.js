'use strict';

/**
 * Void and rename belong to a tab's opener (user-requested). Another
 * operator is refused (403 FORBIDDEN_TAB_NOT_YOURS) with nothing changed; a
 * `pos.manage` user may act on anyone's tab; a tab with no opener (a guest
 * QR order) is left to any operator. Adding items to someone else's tab is
 * still allowed. See assertCanChangeTab in src/modules/pos/service.js.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuCategories, insertMenuItem } = require('../helpers/catalogue');

describe('void and rename belong to the tab opener', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let manager;
  let opener;
  let other;
  let outletId;
  let terminalId;
  let menuItemId;

  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
  });

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-03-01' });
    manager = ctx.a.users[0].id;
    opener = ctx.a.users[1].id;
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `other-op-${Date.now()}@example.com`, first_name: 'Oto', last_name: 'Operator', password_hash: 'x', status: 'active' });
    other = id;
    await setRole(manager, 'manager');
    await setRole(opener, 'pos_operator');
    await setRole(other, 'pos_operator');

    const suffix = Date.now().toString(36);
    [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `OWN-${suffix}`, name: 'Owner Bar', type: 'bar' });
    [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `OWN-T-${suffix}` });
    await insertMenuCategories(t.trx, [{ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Owner Drinks' }]);
    [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: `Owner Beer ${suffix}`, category: 'Owner Drinks', price: '10.00' });
  });

  async function tabOf(userId) {
    const tab = await as(userId).post('/api/v1/pos/orders').send({ outlet_id: outletId, terminal_id: terminalId, table_label: 'Mine' });
    expect(tab.status).toBe(201);
    const add = await as(userId).post(`/api/v1/pos/orders/${tab.body.data.id}/items`).send({ menu_item_id: menuItemId, quantity: 1 });
    expect(add.status).toBe(200);
    return { orderId: tab.body.data.id, itemId: add.body.data.items[0].id };
  }

  it("refuses another operator's void, line void and rename, changing nothing", async () => {
    const { orderId, itemId } = await tabOf(opener);
    const rename = await as(other).post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'Hijacked' });
    const voidLine = await as(other).post(`/api/v1/pos/orders/${orderId}/items/${itemId}/void`).send({ reason: 'not mine' });
    const voidTab = await as(other).post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'not mine' });
    for (const res of [rename, voidLine, voidTab]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_TAB_NOT_YOURS');
    }
    const order = await t.trx('pos_orders').where({ id: orderId }).first();
    expect(order.status).toBe('open');
    expect(order.table_label).toBe('Mine');
    expect((await t.trx('pos_order_items').where({ id: itemId }).first()).voided_at).toBeNull();
  });

  it("still lets another operator add to someone else's tab", async () => {
    const { orderId } = await tabOf(opener);
    expect((await as(other).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: menuItemId, quantity: 1 })).status).toBe(200);
  });

  it('lets the opener rename, void a line and void the tab', async () => {
    const { orderId, itemId } = await tabOf(opener);
    expect((await as(opener).post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'Renamed' })).status).toBe(200);
    expect((await as(opener).post(`/api/v1/pos/orders/${orderId}/items/${itemId}/void`).send({ reason: 'wrong item' })).status).toBe(200);
    expect((await as(opener).post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'guest left' })).status).toBe(200);
  });

  it("lets a manager act on anyone's tab, recorded as the manager", async () => {
    const { orderId, itemId } = await tabOf(opener);
    expect((await as(manager).post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'Manager named' })).status).toBe(200);
    expect((await as(manager).post(`/api/v1/pos/orders/${orderId}/items/${itemId}/void`).send({ reason: 'comped' })).status).toBe(200);
    const res = await as(manager).post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'walkout' });
    expect(res.status).toBe(200);
    expect(String(res.body.data.voided_by_user_id)).toBe(String(manager));
  });

  it('leaves a tab with no opener (a guest QR order) to any operator', async () => {
    const [orderId] = await t.trx('pos_orders').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, terminal_id: null, opened_by_user_id: null, table_label: 'QR Table', source: 'guest' });
    expect((await as(other).post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'QR Table 2' })).status).toBe(200);
    expect((await as(other).post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'test' })).status).toBe(200);
  });
});
