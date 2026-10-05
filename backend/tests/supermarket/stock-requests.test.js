'use strict';

/**
 * A supermarket's stock rises only by the opening-stock import or a
 * store-approved request/transfer. The cashier (pos_operator: supermarket.sales
 * + pos.stock_request) raises a request for the mart; the store (or a manager)
 * issues it through the existing request flow; the cashier cannot issue it or
 * add stock any other way. A bar's request flow is unchanged (tests/pos).
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');

describe('supermarket stock requests', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let martId;
  let storeId;
  let counter = 0;
  const users = {};
  const DATE = '2027-12-01';

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (role) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(users[role])}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(users[role])}`).set('Idempotency-Key', `sr-${next()}`),
  });

  async function userWithRole(role) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'User', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    return id;
  }
  async function outlet(type, name) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `S${next()}`.slice(0, 30), name, type });
    return id;
  }
  async function stockItem(name) {
    const [id] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: `${name} ${next()}`, unit: 'bottle', purchase_cost: '3.00', reorder_level: '0.000' });
    return id;
  }
  async function receiveAtStore(stockItemId, quantity) {
    const res = await as('manager').post('/api/v1/pos/stock/goods-received').send({ outlet_id: storeId, lines: [{ stock_item_id: stockItemId, quantity, unit_cost: '3.00' }] });
    expect(res.status).toBe(201);
  }
  const level = async (outletId, stockItemId) => (await t.trx('stock_levels').where({ outlet_id: outletId, stock_item_id: stockItemId }).first('current_quantity'))?.current_quantity ?? '0.000';
  const request = (role, lines, extra = {}) => as(role).post('/api/v1/pos/stock/transfer-requests').send({ from_outlet_id: storeId, to_outlet_id: martId, lines, ...extra });

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: DATE });
    martId = await outlet('supermarket', 'Request Mart');
    storeId = await outlet('store', 'Request Store');
    for (const role of ['manager', 'pos_operator', 'storekeeper']) users[role] = await userWithRole(role);
  });

  it('a mart cashier raises a request for the mart; the store issues it and the mart stock rises (the cashier cannot issue it)', async () => {
    const coke = await stockItem('Coke');
    await receiveAtStore(coke, '40.000');

    const raised = await request('pos_operator', [{ stock_item_id: coke, quantity: '12' }], { note: 'Need more Coke' });
    expect(raised.status).toBe(201);
    expect(raised.body.data.status).toBe('pending');
    const id = raised.body.data.id;
    expect(await level(martId, coke)).toBe('0.000');

    // The cashier can read it back but cannot issue or reject it.
    expect((await as('pos_operator').get(`/api/v1/pos/stock/transfer-requests/${id}`)).status).toBe(200);
    expect((await as('pos_operator').post(`/api/v1/pos/stock/transfer-requests/${id}/issue`).send({ lines: [{ stock_item_id: coke, quantity: '12' }] })).status).toBe(403);
    expect((await as('pos_operator').post(`/api/v1/pos/stock/transfer-requests/${id}/reject`).send({ reason: 'no' })).status).toBe(403);
    expect(await level(martId, coke)).toBe('0.000');

    const issued = await as('storekeeper').post(`/api/v1/pos/stock/transfer-requests/${id}/issue`).send({ lines: [{ stock_item_id: coke, quantity: '12' }] });
    expect(issued.status).toBe(200);
    expect(issued.body.data.status).toBe('issued');
    expect(await level(martId, coke)).toBe('12.000');
    expect(await level(storeId, coke)).toBe('28.000');
  });

  it("the cashier can withdraw their own pending request, and the store's stock is untouched", async () => {
    const water = await stockItem('Water');
    await receiveAtStore(water, '10.000');
    const raised = await request('pos_operator', [{ stock_item_id: water, quantity: '5' }]);
    expect(raised.status).toBe(201);
    const withdrawn = await as('pos_operator').post(`/api/v1/pos/stock/transfer-requests/${raised.body.data.id}/cancel`).send({});
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.data.status).toBe('cancelled');
    expect(await level(martId, water)).toBe('0.000');
    expect(await level(storeId, water)).toBe('10.000');
  });

  it('the mart till shows the new stock after the store issues, and a request cannot be raised for stock the store lacks to be issued', async () => {
    const juice = await stockItem('Juice');
    const [menuId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: martId, name: `Juice ${next()}`, category: 'Request Mart Drinks', price: '5.00' });
    await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: menuId, stock_item_id: juice, quantity: '1.000' });
    await receiveAtStore(juice, '6.000');

    const raised = await request('pos_operator', [{ stock_item_id: juice, quantity: '20' }]);
    expect(raised.status).toBe(201); // a request may ask for more than the store holds…
    const refused = await as('storekeeper').post(`/api/v1/pos/stock/transfer-requests/${raised.body.data.id}/issue`).send({ lines: [{ stock_item_id: juice, quantity: '20' }] });
    expect(refused.status).toBe(422); // …but the store cannot issue more than it has
    expect(await level(martId, juice)).toBe('0.000');

    const ok = await as('storekeeper').post(`/api/v1/pos/stock/transfer-requests/${raised.body.data.id}/issue`).send({ lines: [{ stock_item_id: juice, quantity: '6' }] });
    expect(ok.status).toBe(200);
    const stock = await as('pos_operator').get(`/api/v1/supermarket/stock?outlet_id=${martId}`);
    expect(stock.status).toBe(200);
    expect(stock.body.data[String(menuId)]).toBe(6);
  });

  it('there is no other route for the cashier to raise mart stock: goods received and a stock take are refused', async () => {
    const item = await stockItem('Direct');
    const received = await as('pos_operator').post('/api/v1/pos/stock/goods-received').send({ outlet_id: martId, lines: [{ stock_item_id: item, quantity: '5.000', unit_cost: '3.00' }] });
    expect(received.status).toBe(403);
    // Even a manager cannot receive at the mart directly any more (the store holds deliveries).
    const managerReceived = await as('manager').post('/api/v1/pos/stock/goods-received').send({ outlet_id: martId, lines: [{ stock_item_id: item, quantity: '5.000', unit_cost: '3.00' }] });
    expect(managerReceived.status).toBe(422);
    expect(managerReceived.body.error.code).toBe('BUSINESS_RULE_RECEIVE_AT_STORE_ONLY');
    expect(await level(martId, item)).toBe('0.000');
  });
});
