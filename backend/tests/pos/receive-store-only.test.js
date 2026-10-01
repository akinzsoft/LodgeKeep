'use strict';

/**
 * Supplier deliveries are received at the STORE ROOM. Once a property has a
 * store, receiving at a bar or restaurant is refused (422): the goods reach
 * an outlet by a stock request or transfer, and receiving there too would
 * add stock with nothing leaving the store (counted twice) and overwrite the
 * item's last cost. A property with no store room keeps receiving at its
 * outlets exactly as before; an archived store does not count as one.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertStockItem } = require('../helpers/catalogue');

describe('goods received: store room only', () => {
  const t = useTestApp();
  let ctx;
  let counter = 0;

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const managerToken = (tenant) =>
    signAccessToken({ aud: 'staff', sub: String(tenant.users[0].id), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });

  async function outlet(tenant, { type = 'bar', name } = {}) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: tenant.id, property_id: tenant.properties[0].id, code: `R${next()}`.slice(0, 30), name: name ?? `${type} ${counter}`, type });
    return id;
  }

  async function item(tenant, purchaseCost = '4.00') {
    const [id] = await insertStockItem(t.trx, { tenant_id: tenant.id, property_id: tenant.properties[0].id, name: `Lager ${next()}`, unit: 'bottle', purchase_cost: purchaseCost, reorder_level: '0.000' });
    return id;
  }

  const receive = (tenant, outletId, stockItemId, { unitCost = '9.00', quantity = '5.000' } = {}) =>
    t.request
      .post('/api/v1/pos/stock/goods-received')
      .set('Authorization', `Bearer ${managerToken(tenant)}`)
      .set('Idempotency-Key', `rso-${next()}`)
      .send({ outlet_id: outletId, lines: [{ stock_item_id: stockItemId, quantity, unit_cost: unitCost }] });

  const movements = (stockItemId) => t.trx('stock_movements').where({ stock_item_id: stockItemId });

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    for (const tenant of [ctx.a, ctx.b]) await t.trx('properties').where({ id: tenant.properties[0].id }).update({ current_business_date: '2027-06-01' });
    // Neither fixture tenant starts with a store room of its own.
    expect(await t.trx('pos_outlets').where({ type: 'store' }).whereIn('tenant_id', [ctx.a.id, ctx.b.id]).first()).toBeUndefined();
  });

  it('refuses a delivery at a bar when the property has a store, names the store, and writes nothing', async () => {
    const store = await outlet(ctx.a, { type: 'store', name: 'Main Store' });
    const bar = await outlet(ctx.a, { type: 'bar', name: 'Pool Bar' });
    const stockItemId = await item(ctx.a, '4.00');

    const refused = await receive(ctx.a, bar, stockItemId);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('BUSINESS_RULE_RECEIVE_AT_STORE_ONLY');
    expect(refused.body.error.message).toContain('Main Store');
    expect(refused.body.error.message).toContain('Pool Bar');
    expect(await movements(stockItemId)).toHaveLength(0);
    expect(await t.trx('stock_levels').where({ stock_item_id: stockItemId }).first()).toBeUndefined();
    // The item's last cost is untouched.
    expect((await t.trx('stock_items').where({ id: stockItemId }).first()).purchase_cost).toBe('4.00');

    // The same delivery at the store works, and sets the cost.
    const ok = await receive(ctx.a, store, stockItemId);
    expect(ok.status).toBe(201);
    expect(await movements(stockItemId)).toHaveLength(1);
    expect((await t.trx('stock_items').where({ id: stockItemId }).first()).purchase_cost).toBe('9.00');
  });

  it('is not bypassed by a manager, and a restaurant is refused like a bar', async () => {
    await outlet(ctx.a, { type: 'store' });
    const restaurant = await outlet(ctx.a, { type: 'restaurant' });
    const res = await receive(ctx.a, restaurant, await item(ctx.a));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_RECEIVE_AT_STORE_ONLY');
  });

  it('still lets stock reach the bar the right way: receive at the store, then transfer', async () => {
    const store = await outlet(ctx.a, { type: 'store' });
    const bar = await outlet(ctx.a, { type: 'bar' });
    const stockItemId = await item(ctx.a);
    expect((await receive(ctx.a, store, stockItemId, { quantity: '6.000' })).status).toBe(201);
    const moved = await t.request
      .post('/api/v1/pos/stock/transfers')
      .set('Authorization', `Bearer ${managerToken(ctx.a)}`)
      .set('Idempotency-Key', `rso-${next()}`)
      .send({ stock_item_id: stockItemId, from_outlet_id: store, to_outlet_id: bar, quantity: '2.000' });
    expect(moved.status).toBe(201);
    expect((await t.trx('stock_levels').where({ stock_item_id: stockItemId, outlet_id: bar }).first()).current_quantity).toBe('2.000');
  });

  it('keeps working exactly as before at a property with no store room', async () => {
    const bar = await outlet(ctx.b, { type: 'bar' });
    const res = await receive(ctx.b, bar, await item(ctx.b));
    expect(res.status).toBe(201);
  });

  it('does not count an archived store as the property\'s store room', async () => {
    const [archivedStore] = await t.trx('pos_outlets').insert({ tenant_id: ctx.b.id, property_id: ctx.b.properties[0].id, code: `RA${next()}`.slice(0, 30), name: 'Old Store', type: 'store', status: 'archived' });
    const bar = await outlet(ctx.b, { type: 'bar' });
    expect(archivedStore).toBeDefined();
    expect((await receive(ctx.b, bar, await item(ctx.b))).status).toBe(201);
  });
});
