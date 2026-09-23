'use strict';

/**
 * `GET /pos/stock/reports/overview` (gap closure) — every ACTIVE stock item
 * and every registered stock category, whether or not anything moved in the
 * range, with each item's own category and the period's sold / received /
 * wastage / adjustment figures. The other stock reports are ledger-driven
 * and omit anything with no movement; this one starts from the items.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Stock overview by category (gap closure)', () => {
  const t = useTestApp();
  let ctx;
  let outletId;
  let counter = 0;
  const DATE = '2031-03-10';

  function tokenFor(tenant, userIndex) {
    return signAccessToken({ aud: 'staff', sub: String(tenant.users[userIndex].id), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }

  async function setRole(tenant, userIndex, role) {
    const userId = tenant.users[userIndex].id;
    const pid = tenant.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: pid }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: pid, user_id: userId, role });
  }

  const manager = () => tokenFor(ctx.a, 0);
  const operator = () => tokenFor(ctx.a, 1);

  async function newOutlet(tenant) {
    counter += 1;
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: tenant.id, property_id: tenant.properties[0].id, code: `OV${Date.now().toString(36)}${counter}`, name: `Overview outlet ${counter}`, type: 'bar' });
    return id;
  }

  async function newStockItem(tenant, outlet, { name, category = null, current = '0.000', reorder = '0.000', status = 'active' } = {}) {
    counter += 1;
    const [id] = await t.trx('stock_items').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      outlet_id: outlet,
      name: name ?? `Overview item ${counter}`,
      unit: 'ml',
      category,
      purchase_cost: '2.00',
      reorder_level: reorder,
      current_quantity: current,
      status,
    });
    return id;
  }

  async function movement(tenant, outlet, stockItemId, type, quantity, totalCost = null, businessDate = DATE) {
    await t.trx('stock_movements').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      outlet_id: outlet,
      stock_item_id: stockItemId,
      type,
      quantity,
      unit_cost: totalCost === null ? null : '2.00',
      total_cost: totalCost,
      business_date: businessDate,
      reason: type === 'wastage' || type === 'count_adjustment' ? 'test' : null,
    });
  }

  async function newCategory(tenant, name, sortOrder = 0) {
    await t.trx('stock_item_categories').insert({ tenant_id: tenant.id, property_id: tenant.properties[0].id, name, sort_order: sortOrder });
  }

  const overview = (query = '', token = manager()) => t.request.get(`/api/v1/pos/stock/reports/overview?date_from=${DATE}&date_to=${DATE}${query}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'pos_operator');
    outletId = await newOutlet(ctx.a);
  });

  it('lists an item with no movement at all, with zero figures and its own category', async () => {
    await newCategory(ctx.a, 'Wines');
    const id = await newStockItem(ctx.a, outletId, { name: 'Untouched Merlot', category: 'Wines', current: '12.000' });

    const res = await overview(`&outlet_id=${outletId}`);
    expect(res.status).toBe(200);
    const row = res.body.data.items.find((r) => r.stockItemId === String(id));
    expect(row).toMatchObject({
      name: 'Untouched Merlot',
      category: 'Wines',
      unit: 'ml',
      currentQuantity: '12.000',
      soldQty: '0.000',
      soldCost: '0.00',
      receivedQty: '0.000',
      wastageQty: '0.000',
      adjustmentQty: '0.000',
    });
  });

  it('shows a registered category with no items, plus Uncategorized and an unregistered-but-referenced category', async () => {
    const outlet = await newOutlet(ctx.a);
    await newCategory(ctx.a, 'Empty shelf', 5);
    await newStockItem(ctx.a, outlet, { name: 'Loose item', category: null });
    await newStockItem(ctx.a, outlet, { name: 'Orphan item', category: 'Retired category' });

    const res = await overview(`&outlet_id=${outlet}`);
    const byName = Object.fromEntries(res.body.data.byCategory.map((c) => [c.category ?? '__none__', c]));
    expect(byName['Empty shelf']).toMatchObject({ itemCount: 0, registered: true });
    expect(byName.__none__).toMatchObject({ itemCount: 1, registered: null });
    expect(byName['Retired category']).toMatchObject({ itemCount: 1, registered: false });
  });

  it('folds the period\'s movements onto each item — sold net of reversals, received, wastage and stock-take adjustments — and rolls cost up per category', async () => {
    const outlet = await newOutlet(ctx.a);
    await newCategory(ctx.a, 'Spirits', 1);
    const gin = await newStockItem(ctx.a, outlet, { name: 'Gin', category: 'Spirits', current: '80.000' });
    const rum = await newStockItem(ctx.a, outlet, { name: 'Rum', category: 'Spirits', current: '50.000' });

    await movement(ctx.a, outlet, gin, 'sold', '-30.000', '-60.00');
    await movement(ctx.a, outlet, gin, 'sale_reversal', '10.000', '20.00'); // A voided sale gives 10 back.
    await movement(ctx.a, outlet, gin, 'received', '100.000', '200.00');
    await movement(ctx.a, outlet, gin, 'wastage', '-5.000', '-10.00');
    await movement(ctx.a, outlet, gin, 'count_adjustment', '-2.000', null);
    await movement(ctx.a, outlet, rum, 'sold', '-10.000', '-20.00');
    await movement(ctx.a, outlet, gin, 'sold', '-99.000', '-198.00', '2031-03-11'); // Outside the range — ignored.

    const res = await overview(`&outlet_id=${outlet}`);
    const items = Object.fromEntries(res.body.data.items.map((r) => [r.name, r]));
    expect(items.Gin).toMatchObject({ soldQty: '20.000', soldCost: '40.00', receivedQty: '100.000', wastageQty: '5.000', wastageCost: '10.00', adjustmentQty: '-2.000' });
    expect(items.Rum).toMatchObject({ soldQty: '10.000', soldCost: '20.00' });

    const spirits = res.body.data.byCategory.find((c) => c.category === 'Spirits');
    expect(spirits).toMatchObject({ itemCount: 2, soldCost: '60.00', wastageCost: '10.00' });
    expect(res.body.data.totals).toMatchObject({ itemCount: 2, soldCost: '60.00', wastageCost: '10.00' });
  });

  it('flags items at or below their reorder level, and counts them per category', async () => {
    const outlet = await newOutlet(ctx.a);
    await newCategory(ctx.a, 'Mixers', 2);
    await newStockItem(ctx.a, outlet, { name: 'Tonic low', category: 'Mixers', current: '5.000', reorder: '10.000' });
    await newStockItem(ctx.a, outlet, { name: 'Soda fine', category: 'Mixers', current: '50.000', reorder: '10.000' });
    await newStockItem(ctx.a, outlet, { name: 'No level', category: 'Mixers', current: '0.000', reorder: '0.000' });

    const res = await overview(`&outlet_id=${outlet}`);
    const items = Object.fromEntries(res.body.data.items.map((r) => [r.name, r]));
    expect(items['Tonic low'].atOrBelowReorder).toBe(true);
    expect(items['Soda fine'].atOrBelowReorder).toBe(false);
    expect(items['No level'].atOrBelowReorder).toBe(false); // A zero reorder level means "not tracked".
    expect(res.body.data.byCategory.find((c) => c.category === 'Mixers').lowStockCount).toBe(1);
  });

  it('excludes archived items, and orders items by category then name', async () => {
    const outlet = await newOutlet(ctx.a);
    await newStockItem(ctx.a, outlet, { name: 'Gone', category: null, status: 'archived' });
    await newStockItem(ctx.a, outlet, { name: 'Zed', category: null });
    await newStockItem(ctx.a, outlet, { name: 'Alpha', category: null });

    const res = await overview(`&outlet_id=${outlet}`);
    expect(res.body.data.items.map((r) => r.name)).toEqual(['Alpha', 'Zed']);
  });

  it('filters by outlet when asked and needs a date range', async () => {
    const a = await newOutlet(ctx.a);
    const b = await newOutlet(ctx.a);
    await newStockItem(ctx.a, a, { name: 'Only at A' });
    await newStockItem(ctx.a, b, { name: 'Only at B' });

    const scoped = await overview(`&outlet_id=${a}`);
    expect(scoped.body.data.items.map((r) => r.name)).toEqual(['Only at A']);

    const missing = await t.request.get('/api/v1/pos/stock/reports/overview').set('Authorization', `Bearer ${manager()}`);
    expect(missing.status).toBe(400);
  });

  it('needs pos.stock_manage — a pos_operator is refused', async () => {
    expect((await overview('', operator())).status).toBe(403);
  });

  it("never includes another tenant's items or categories", async () => {
    const outletB = await newOutlet(ctx.b);
    await newCategory(ctx.b, 'Tenant B only');
    await newStockItem(ctx.b, outletB, { name: 'B secret', category: 'Tenant B only' });

    const res = await overview();
    expect(res.body.data.items.map((r) => r.name)).not.toContain('B secret');
    expect(res.body.data.byCategory.map((c) => c.category)).not.toContain('Tenant B only');
  });

  it('a stock item lists its category on movement history too', async () => {
    const outlet = await newOutlet(ctx.a);
    await newCategory(ctx.a, 'History cat', 3);
    const id = await newStockItem(ctx.a, outlet, { name: 'History item', category: 'History cat' });
    await movement(ctx.a, outlet, id, 'sold', '-1.000', '-2.00');

    const res = await t.request.get(`/api/v1/pos/stock/movements?stock_item_id=${id}`).set('Authorization', `Bearer ${manager()}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ type: 'sold', stock_item_name: 'History item', stock_item_category: 'History cat' });
  });
});
