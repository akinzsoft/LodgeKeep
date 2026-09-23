'use strict';

/**
 * Profit on the POS Sales report (`GET /pos/reports/sales`) — each item's
 * cost is its recipe (sum of stock cost × quantity), else its own cost
 * price, else unknown; profit is sales-before-tax minus that cost, per top
 * item, per settled tab, and in total. An item with unknown cost is never
 * treated as free, so it is left out of profit and counted separately.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

const BUSINESS_DATE = '2027-04-01';

describe('POS sales report — profit', () => {
  const t = useTestApp();
  let ctx;
  let managerToken;
  let outlet;
  let counter = 0;

  function tokenFor(tenant, userId) {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }

  async function setRole(tenant, userIndex, role) {
    const userId = tenant.users[userIndex].id;
    const propertyId = tenant.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  async function menuItem(name, price, costPrice = null) {
    const propertyId = ctx.a.properties[0].id;
    const [id] = await t.trx('pos_menu_items').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      outlet_id: outlet.outletId,
      name,
      category: 'Profit',
      price,
      cost_price: costPrice,
    });
    return id;
  }

  async function sell(tableLabel, items) {
    const opened = await t.request
      .post('/api/v1/pos/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: tableLabel })
      .expect(201);
    for (const [menuItemId, quantity] of items) {
      await t.request.post(`/api/v1/pos/orders/${opened.body.data.id}/items`).set('Authorization', `Bearer ${managerToken}`).send({ menu_item_id: menuItemId, quantity }).expect(200);
    }
    counter += 1;
    await t.request
      .post(`/api/v1/pos/orders/${opened.body.data.id}/settle`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', `sales-profit-${counter}`)
      .send({ settlements: [{ method: 'cash' }] })
      .expect(200);
    return opened.body.data.id;
  }

  const report = (query = '') => t.request.get(`/api/v1/pos/reports/sales?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}${query}`).set('Authorization', `Bearer ${managerToken}`);

  let items;
  let tabOne;
  let tabTwo;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
    await setRole(ctx.a, 0, 'manager');
    managerToken = tokenFor(ctx.a, ctx.a.users[0].id);

    const propertyId = ctx.a.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'PROFIT-BAR', name: 'Profit Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: 'PROFIT-T1' });
    outlet = { outletId, terminalId };

    // A: 20.00, cost price 12.00 (no recipe). B: 40.00, recipe = 2 × a stock item costing 5.00 → 10.00. C: 10.00, no cost at all.
    const a = await menuItem('Item A', '20.00', '12.00');
    const b = await menuItem('Item B', '40.00');
    const c = await menuItem('Item C', '10.00');
    const [stockItemId] = await t.trx('stock_items').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      outlet_id: outletId,
      name: 'Profit stock',
      unit: 'each',
      purchase_cost: '5.00',
      reorder_level: '0.000',
      current_quantity: '1000.000',
    });
    await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: b, stock_item_id: stockItemId, quantity: '2.000' });
    items = { a, b, c };

    tabOne = await sell('Profit tab 1', [[a, 2], [b, 1]]);
    tabTwo = await sell('Profit tab 2', [[c, 1], [a, 1]]);
  });

  it('gives each item its cost, profit and margin — recipe cost, else cost price', async () => {
    const res = await report();
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.data.topItems.map((row) => [row.name, row]));

    expect(byName['Item A']).toMatchObject({ quantity: 3, sales: '60.00', cost: '36.00', profit: '24.00' });
    expect(byName['Item A'].marginPct).toBeCloseTo(40, 5);
    expect(byName['Item B']).toMatchObject({ quantity: 1, sales: '40.00', cost: '10.00', profit: '30.00' });
    expect(byName['Item B'].marginPct).toBeCloseTo(75, 5);
  });

  it('an item with no recipe and no cost price has an unknown cost and profit — null, never zero', async () => {
    const res = await report();
    const c = res.body.data.topItems.find((row) => row.name === 'Item C');
    expect(c).toMatchObject({ sales: '10.00', cost: null, profit: null, marginPct: null });
  });

  it('totals profit over the items whose cost is known, and counts the ones that are not', async () => {
    const res = await report();
    expect(res.body.data.summary.profit).toMatchObject({ revenue: '100.00', cost: '46.00', profit: '54.00', itemsWithUnknownCost: 1 });
    expect(res.body.data.summary.profit.marginPct).toBeCloseTo(54, 5);
  });

  it('gives each settled tab its own profit, and says whether every item on it had a known cost', async () => {
    const res = await report();
    const one = res.body.data.tabs.find((tab) => String(tab.orderId) === String(tabOne));
    const two = res.body.data.tabs.find((tab) => String(tab.orderId) === String(tabTwo));

    // Tab 1: 2 × A (40.00, cost 24.00) + 1 × B (40.00, cost 10.00).
    expect(one).toMatchObject({ cost: '34.00', profit: '46.00', costComplete: true });
    // Tab 2: A (20.00, cost 12.00) is priced; C (10.00) is not.
    expect(two).toMatchObject({ cost: '12.00', profit: '8.00', costComplete: false });
  });

  it('a tab with no priced item at all has an unknown profit (null), not a false zero', async () => {
    const unpriced = await sell('Profit unpriced tab', [[items.c, 2]]);
    const res = await report();
    const tab = res.body.data.tabs.find((row) => String(row.orderId) === String(unpriced));
    expect(tab).toMatchObject({ cost: null, profit: null, costComplete: false });
    // …and it does not move the totals (revenue stays 100.00 from the priced items).
    expect(res.body.data.summary.profit).toMatchObject({ revenue: '100.00', profit: '54.00' });
  });

  it('leaves a voided tab out of profit, like everything else on the report', async () => {
    const voided = await sell('Profit voided', [[items.a, 5]]);
    const before = (await report()).body.data.summary.profit;
    expect(before.revenue).toBe('200.00');

    const order = await t.request.get(`/api/v1/pos/orders/${voided}`).set('Authorization', `Bearer ${managerToken}`);
    const settlementId = order.body.data.settlements[0].id;
    await t.request
      .post(`/api/v1/pos/orders/${voided}/settlements/${settlementId}/void`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', 'sales-profit-void')
      .send({ reason: 'test' })
      .expect(200);

    const after = (await report()).body.data.summary.profit;
    expect(after).toMatchObject({ revenue: '100.00', cost: '46.00', profit: '54.00' });
  });

  it('exports the profit columns in the items and tabs CSV', async () => {
    const itemsCsv = await t.request.get(`/api/v1/pos/reports/sales?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv&section=items`).set('Authorization', `Bearer ${managerToken}`);
    expect(itemsCsv.text.split('\n')[0]).toBe('name,quantity,sales,cost,profit');
    expect(itemsCsv.text).toContain('Item A,3,60.00,36.00,24.00');

    const tabsCsv = await t.request.get(`/api/v1/pos/reports/sales?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv&section=tabs`).set('Authorization', `Bearer ${managerToken}`);
    expect(tabsCsv.text.split('\n')[0]).toMatch(/,total,profit$/);
  });

  it('when everything sold has an unknown cost, the summary profit is unknown (null), not a false zero', async () => {
    const propertyId = ctx.a.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'PROFIT-BAR2', name: 'Unpriced Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: 'PROFIT-T2' });
    const [unpricedId] = await t.trx('pos_menu_items').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Unpriced only', category: 'Profit', price: '15.00' });

    const opened = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${managerToken}`).send({ outlet_id: outletId, terminal_id: terminalId, table_label: 'U1' }).expect(201);
    await t.request.post(`/api/v1/pos/orders/${opened.body.data.id}/items`).set('Authorization', `Bearer ${managerToken}`).send({ menu_item_id: unpricedId, quantity: 1 }).expect(200);
    await t.request
      .post(`/api/v1/pos/orders/${opened.body.data.id}/settle`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', 'sales-profit-unpriced')
      .send({ settlements: [{ method: 'cash' }] })
      .expect(200);

    const res = await report(`&outlet_id=${outletId}`);
    expect(res.body.data.summary.profit).toEqual({ revenue: null, cost: null, profit: null, marginPct: null, itemsWithUnknownCost: 1 });
  });

  it('reports zero profit, not an error, for a range with no sales', async () => {
    const res = await t.request.get('/api/v1/pos/reports/sales?date_from=2020-01-01&date_to=2020-01-02').set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.profit).toMatchObject({ revenue: '0.00', cost: '0.00', profit: '0.00', marginPct: null, itemsWithUnknownCost: 0 });
    expect(res.body.data.topItems).toEqual([]);
  });
});
