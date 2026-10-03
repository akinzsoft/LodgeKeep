'use strict';

/**
 * A stock take at a bar/restaurant may confirm or LOWER the system quantity
 * but never RAISE it once the property has an active store room: stock only
 * reaches an outlet by a request or transfer, so a higher count would add
 * goods with nothing leaving the store. The store itself, and a property with
 * no store room, count freely. A refusal checks every line first, names them
 * all, writes nothing and leaves the take open.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertStockItem } = require('../helpers/catalogue');

describe('stock take: counts cannot raise stock at an outlet', () => {
  const t = useTestApp();
  let ctx;
  let counter = 0;

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const token = (tenant) =>
    signAccessToken({ aud: 'staff', sub: String(tenant.users[0].id), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const auth = (tenant) => ({ Authorization: `Bearer ${token(tenant)}` });

  async function outlet(tenant, { type = 'bar', name, status = 'active' } = {}) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: tenant.id, property_id: tenant.properties[0].id, code: `T${next()}`.slice(0, 30), name: name ?? `${type} ${counter}`, type, status });
    return id;
  }

  async function item(tenant, name) {
    const [id] = await insertStockItem(t.trx, { tenant_id: tenant.id, property_id: tenant.properties[0].id, name: name ?? `Lager ${next()}`, unit: 'bottle', purchase_cost: '4.00', reorder_level: '0.000' });
    return id;
  }

  /** Put `quantity` of an item at an outlet by the legitimate route: receive at the store, transfer. */
  async function stockAt(tenant, { store, outletId, stockItemId, quantity }) {
    const received = await t.request
      .post('/api/v1/pos/stock/goods-received')
      .set(auth(tenant))
      .set('Idempotency-Key', `tk-${next()}`)
      .send({ outlet_id: store, lines: [{ stock_item_id: stockItemId, quantity, unit_cost: '4.00' }] });
    expect(received.status).toBe(201);
    if (outletId === store) return;
    const moved = await t.request
      .post('/api/v1/pos/stock/transfers')
      .set(auth(tenant))
      .set('Idempotency-Key', `tk-${next()}`)
      .send({ stock_item_id: stockItemId, from_outlet_id: store, to_outlet_id: outletId, quantity });
    expect(moved.status).toBe(201);
  }

  async function takeWithCounts(tenant, outletId, counts) {
    const open = await t.request.post('/api/v1/pos/stock/takes').set(auth(tenant)).send({ outlet_id: outletId });
    expect(open.status).toBe(201);
    const takeId = open.body.data.id;
    for (const [stockItemId, counted] of counts) {
      const res = await t.request.patch(`/api/v1/pos/stock/takes/${takeId}/lines/${stockItemId}`).set(auth(tenant)).send({ counted_quantity: counted });
      expect(res.status).toBe(200);
    }
    return takeId;
  }

  const complete = (tenant, takeId) =>
    t.request.post(`/api/v1/pos/stock/takes/${takeId}/complete`).set(auth(tenant)).set('Idempotency-Key', `tk-${next()}`).send({});

  const adjustments = (takeId) => t.trx('stock_movements').where({ stock_take_id: takeId });
  const level = (stockItemId, outletId) => t.trx('stock_levels').where({ stock_item_id: stockItemId, outlet_id: outletId }).first();

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    for (const tenant of [ctx.a, ctx.b]) await t.trx('properties').where({ id: tenant.properties[0].id }).update({ current_business_date: '2027-06-01' });
  });

  it('refuses a count above the system quantity at a bar, names every raising line and the store, and writes nothing', async () => {
    const store = await outlet(ctx.a, { type: 'store', name: 'Main Store' });
    const bar = await outlet(ctx.a, { type: 'bar', name: 'Pool Bar' });
    const lager = await item(ctx.a, `Lager ${next()}`);
    const stout = await item(ctx.a, `Stout ${next()}`);
    const wine = await item(ctx.a, `Wine ${next()}`);
    await stockAt(ctx.a, { store, outletId: bar, stockItemId: lager, quantity: '10.000' });
    await stockAt(ctx.a, { store, outletId: bar, stockItemId: stout, quantity: '4.000' });
    await stockAt(ctx.a, { store, outletId: bar, stockItemId: wine, quantity: '6.000' });

    // lager and stout raise, wine lowers: the whole take is refused.
    const takeId = await takeWithCounts(ctx.a, bar, [[lager, '12.000'], [stout, '5.000'], [wine, '3.000']]);
    const refused = await complete(ctx.a, takeId);

    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('BUSINESS_RULE_STOCK_TAKE_CANNOT_RAISE_STOCK');
    expect(refused.body.error.message).toContain('Main Store');
    expect(refused.body.error.message).toContain('Pool Bar');
    expect(refused.body.error.details.lines.map((l) => String(l.stockItemId)).sort()).toEqual([String(lager), String(stout)].sort());
    expect(refused.body.error.message).not.toContain('Wine');

    // Nothing written: no adjustment (not even the lowering one), levels untouched, take still open.
    expect(await adjustments(takeId)).toHaveLength(0);
    expect((await level(lager, bar)).current_quantity).toBe('10.000');
    expect((await level(wine, bar)).current_quantity).toBe('6.000');
    const stillOpen = await t.request.get(`/api/v1/pos/stock/takes/${takeId}`).set(auth(ctx.a));
    expect(stillOpen.body.data.stockTake.status).toBe('open');
  });

  it('lets the same take complete once the counts are lowered to the system quantity or below', async () => {
    const store = await outlet(ctx.a, { type: 'store' });
    const restaurant = await outlet(ctx.a, { type: 'restaurant' });
    const lager = await item(ctx.a);
    await stockAt(ctx.a, { store, outletId: restaurant, stockItemId: lager, quantity: '10.000' });

    const takeId = await takeWithCounts(ctx.a, restaurant, [[lager, '11.000']]);
    expect((await complete(ctx.a, takeId)).status).toBe(422);

    // Recount lower and complete the SAME take.
    const recount = await t.request.patch(`/api/v1/pos/stock/takes/${takeId}/lines/${lager}`).set(auth(ctx.a)).send({ counted_quantity: '9.000' });
    expect(recount.status).toBe(200);
    const ok = await complete(ctx.a, takeId);
    expect(ok.status).toBe(200);
    expect((await level(lager, restaurant)).current_quantity).toBe('9.000');
    expect((await adjustments(takeId))[0].quantity).toBe('-1.000');
  });

  it('allows a count that exactly matches, and a count of an item the outlet never held at zero', async () => {
    const store = await outlet(ctx.a, { type: 'store' });
    const bar = await outlet(ctx.a, { type: 'bar' });
    const lager = await item(ctx.a);
    const never = await item(ctx.a);
    await stockAt(ctx.a, { store, outletId: bar, stockItemId: lager, quantity: '5.000' });

    const takeId = await takeWithCounts(ctx.a, bar, [[lager, '5.000'], [never, '0.000']]);
    const res = await complete(ctx.a, takeId);
    expect(res.status).toBe(200);
    expect(await adjustments(takeId)).toHaveLength(0);
  });

  it('refuses counting a never-stocked item above zero at a bar', async () => {
    await outlet(ctx.a, { type: 'store' });
    const bar = await outlet(ctx.a, { type: 'bar' });
    const never = await item(ctx.a);
    const takeId = await takeWithCounts(ctx.a, bar, [[never, '1.000']]);
    const res = await complete(ctx.a, takeId);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_STOCK_TAKE_CANNOT_RAISE_STOCK');
  });

  it('lets the store room itself count above the system quantity', async () => {
    const store = await outlet(ctx.a, { type: 'store' });
    const lager = await item(ctx.a);
    await stockAt(ctx.a, { store, outletId: store, stockItemId: lager, quantity: '10.000' });
    const takeId = await takeWithCounts(ctx.a, store, [[lager, '14.000']]);
    const res = await complete(ctx.a, takeId);
    expect(res.status).toBe(200);
    expect((await level(lager, store)).current_quantity).toBe('14.000');
  });

  it('keeps working exactly as before at a property with no store room', async () => {
    const bar = await outlet(ctx.b, { type: 'bar' });
    const lager = await item(ctx.b);
    const takeId = await takeWithCounts(ctx.b, bar, [[lager, '8.000']]);
    const res = await complete(ctx.b, takeId);
    expect(res.status).toBe(200);
    expect((await level(lager, bar)).current_quantity).toBe('8.000');
  });

  it('does not count an archived store as the property\'s store room', async () => {
    await outlet(ctx.b, { type: 'store', name: 'Old Store', status: 'archived' });
    const bar = await outlet(ctx.b, { type: 'bar' });
    const lager = await item(ctx.b);
    const takeId = await takeWithCounts(ctx.b, bar, [[lager, '3.000']]);
    expect((await complete(ctx.b, takeId)).status).toBe(200);
  });
});
