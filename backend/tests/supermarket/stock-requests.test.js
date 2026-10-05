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
const { insertMenuItem, insertStockItem, insertStockCategories } = require('../helpers/catalogue');

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
  const scope = () => ({ tenant_id: ctx.a.id, property_id: propertyId });
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
  describe("a restricted mart cashier asks the store for the mart's OWN products only", () => {
    let martCashier;
    let barCashier;
    let barId;
    let martItem;
    let barItem;

    beforeAll(async () => {
      // The store carries BOTH the mart's category and the bar's, and holds both items.
      barId = await outlet('bar', 'Request Bar');
      await insertStockCategories(t.trx, { ...scope(), name: 'RR Mart Cat', outlet_id: martId });
      await insertStockCategories(t.trx, { ...scope(), name: 'RR Bar Cat', outlet_id: barId });
      await insertStockCategories(t.trx, { ...scope(), name: 'RR Mart Cat', outlet_id: storeId });
      await insertStockCategories(t.trx, { ...scope(), name: 'RR Bar Cat', outlet_id: storeId });
      [martItem] = await insertStockItem(t.trx, { ...scope(), name: `Mart Coke ${next()}`, unit: 'bottle', category: 'RR Mart Cat', purchase_cost: '3.00', reorder_level: '0.000' });
      [barItem] = await insertStockItem(t.trx, { ...scope(), name: `Bar Gin ${next()}`, unit: 'bottle', category: 'RR Bar Cat', purchase_cost: '3.00', reorder_level: '0.000' });
      await receiveAtStore(martItem, '20.000');
      await receiveAtStore(barItem, '20.000');
      martCashier = await userWithRole('pos_operator');
      barCashier = await userWithRole('pos_operator');
      await t.trx('user_outlet_assignments').insert({ ...scope(), user_id: martCashier, outlet_id: martId });
      await t.trx('user_outlet_assignments').insert({ ...scope(), user_id: barCashier, outlet_id: barId });
      users.martCashier = martCashier;
      users.barCashier = barCashier;
    });

    const names = (res) => res.body.data.map((row) => row.id);

    it("the mart's item list holds only the mart's products, while the store's holds both (even though the store carries both)", async () => {
      const store = await as('martCashier').get(`/api/v1/pos/stock/items?outlet_id=${storeId}`);
      expect(store.status).toBe(200);
      expect(names(store)).toEqual(expect.arrayContaining([String(martItem), String(barItem)]));

      const mart = await as('martCashier').get(`/api/v1/pos/stock/items?outlet_id=${martId}`);
      expect(mart.status).toBe(200);
      expect(names(mart)).toContain(String(martItem));
      expect(names(mart)).not.toContain(String(barItem));
    });

    it('leftover hotel stock the mart still holds (a level, no carried category) is NOT the mart\'s product: out of the list and refused in a request', async () => {
      // As in production: hotel drinks were rung at the mart once, so it holds levels for items in categories it does not carry.
      const [leftover] = await insertStockItem(t.trx, { ...scope(), outlet_id: martId, name: `Leftover Fanta ${next()}`, unit: 'bottle', category: 'RR Bar Cat', purchase_cost: '3.00', current_quantity: '4.000', reorder_level: '0.000' });
      await receiveAtStore(leftover, '10.000');

      const plain = await as('martCashier').get(`/api/v1/pos/stock/items?outlet_id=${martId}`);
      expect(names(plain)).toContain(String(leftover)); // the general list still includes anything the outlet holds
      const carriedOnly = await as('martCashier').get(`/api/v1/pos/stock/items?outlet_id=${martId}&carried_only=true`);
      expect(carriedOnly.status).toBe(200);
      expect(names(carriedOnly)).toContain(String(martItem));
      expect(names(carriedOnly)).not.toContain(String(leftover));
      expect(names(carriedOnly)).not.toContain(String(barItem));

      const res = await request('martCashier', [{ stock_item_id: leftover, quantity: '1' }]);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_REQUEST_ITEM_NOT_AT_OUTLET');
    });

    it("accepts a request for the mart's own product from the store", async () => {
      const res = await request('martCashier', [{ stock_item_id: martItem, quantity: '5' }]);
      expect(res.status).toBe(201);
    });

    it("refuses a request that names another outlet's item, even though the store holds it, and writes nothing", async () => {
      const before = (await t.trx('stock_transfer_requests').count({ n: '*' }).first()).n;
      const res = await request('martCashier', [{ stock_item_id: barItem, quantity: '2' }]);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_REQUEST_ITEM_NOT_AT_OUTLET');
      expect(res.body.error.message).toContain('Request Mart');
      const mixed = await request('martCashier', [{ stock_item_id: martItem, quantity: '1' }, { stock_item_id: barItem, quantity: '1' }]);
      expect(mixed.status).toBe(422);
      expect((await t.trx('stock_transfer_requests').count({ n: '*' }).first()).n).toBe(before);
    });

    it('refuses a supplier that is not a store room', async () => {
      const res = await as('martCashier').post('/api/v1/pos/stock/transfer-requests').send({ from_outlet_id: barId, to_outlet_id: martId, lines: [{ stock_item_id: martItem, quantity: '1' }] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_SUPERMARKET_REQUEST_FROM_STORE_ONLY');
      expect(res.body.error.message).toContain('Request Store');
    });

    it('does not restrict a full-access user, who may request any item for the mart', async () => {
      const res = await request('manager', [{ stock_item_id: barItem, quantity: '1' }]);
      expect(res.status).toBe(201);
    });

    it("does not change a bar operator's request: any store item, from the store", async () => {
      const res = await as('barCashier').post('/api/v1/pos/stock/transfer-requests').send({ from_outlet_id: storeId, to_outlet_id: barId, lines: [{ stock_item_id: martItem, quantity: '1' }, { stock_item_id: barItem, quantity: '1' }] });
      expect(res.status).toBe(201);
    });
  });
});
