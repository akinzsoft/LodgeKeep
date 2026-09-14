'use strict';

/**
 * Cost-of-sales MARGIN report (gap closure) — `stock/reporting.js`'s
 * `computeCostOfSalesMargin`. Real revenue (via `pos/sales-report.js`'s
 * `computeMenuItemSalesTotals`) joined against cost, grouped by menu item
 * and rolled up by category. Mirrors `tests/pos/stock.test.js`'s own
 * settlement/recipe helper setup exactly.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Cost-of-sales margin report (gap closure)', () => {
  const t = useTestApp();
  let ctx;
  const BUSINESS_DATE = '2027-06-01';

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
  });

  function tokenFor({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function grantRoleToUser({ tenant, userIndex, role }) {
    const propertyId = tenant.properties[0].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  function managerToken() {
    return tokenFor({ userId: ctx.a.users[0].id });
  }

  let idemCounter = 0;
  const idemKey = () => `margin-test-key-${(idemCounter += 1)}`;

  let outletCounter = 0;
  async function createMenuItem({ price = '10.00', costPrice } = {}) {
    outletCounter += 1;
    const suffix = `${Date.now()}-${outletCounter}`;
    const propertyId = ctx.a.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `MARGIN-${suffix}`, name: 'Margin Test Outlet', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `MARGINTERM-${suffix}` });
    const [menuItemId] = await t.trx('pos_menu_items').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      outlet_id: outletId,
      name: `Margin Item ${suffix}`,
      category: 'Margin Category',
      price,
      cost_price: costPrice ?? null,
    });
    return { outletId, terminalId, menuItemId, propertyId };
  }

  async function createStockItem({ outletId, purchaseCost = '2.00' } = {}) {
    const [id] = await t.trx('stock_items').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      outlet_id: outletId,
      name: `Margin Stock ${Date.now()}-${Math.random()}`,
      unit: 'ml',
      purchase_cost: purchaseCost,
      reorder_level: '0.000',
      current_quantity: '10000.000',
    });
    return id;
  }

  async function linkComponent({ menuItemId, stockItemId, quantity }) {
    const res = await t.request
      .put(`/api/v1/pos/stock/menu-items/${menuItemId}/components`)
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({ components: [{ stock_item_id: stockItemId, quantity }] });
    expect(res.status).toBe(200);
  }

  async function sellAndSettle({ outletId, terminalId, menuItemId, quantity = 1 }) {
    const order = await t.request
      .post('/api/v1/pos/orders')
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({ outlet_id: outletId, terminal_id: terminalId, table_label: 'T1' });
    expect(order.status).toBe(201);
    const added = await t.request.post(`/api/v1/pos/orders/${order.body.data.id}/items`).set('Authorization', `Bearer ${managerToken()}`).send({ menu_item_id: menuItemId, quantity });
    expect(added.status).toBe(200);
    const settled = await t.request
      .post(`/api/v1/pos/orders/${order.body.data.id}/settle`)
      .set('Authorization', `Bearer ${managerToken()}`)
      .set('Idempotency-Key', idemKey())
      .send({ settlements: [{ method: 'cash' }] });
    expect(settled.status).toBe(200);
    return settled.body.data;
  }

  function getMargin(token = managerToken(), { dateFrom = BUSINESS_DATE, dateTo = BUSINESS_DATE } = {}) {
    return t.request.get(`/api/v1/pos/stock/reports/margin?date_from=${dateFrom}&date_to=${dateTo}`).set('Authorization', `Bearer ${token}`);
  }

  beforeAll(async () => {
    await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });
  });

  it('uses the recipe-derived cost when a real recipe exists — quantity × recipe cost, not cost_price', async () => {
    const { outletId, terminalId, menuItemId } = await createMenuItem({ price: '6.00', costPrice: '99.00' }); // cost_price set but must be ignored
    const stockItemId = await createStockItem({ outletId, purchaseCost: '4.00' });
    await linkComponent({ menuItemId, stockItemId, quantity: '1.000' }); // one whole bottle per unit sold
    await sellAndSettle({ outletId, terminalId, menuItemId, quantity: 2 });

    const res = await getMargin();
    expect(res.status).toBe(200);
    const row = res.body.data.byMenuItem.find((r) => String(r.menuItemId) === String(menuItemId));
    expect(row).toMatchObject({ quantity: 2, revenue: '12.00', cost: '8.00', costSource: 'recipe', margin: '4.00' });
    expect(row.marginPct).toBeCloseTo((4 / 12) * 100, 5);
  });

  it('falls back to cost_price when the item has no recipe at all', async () => {
    const { outletId, terminalId, menuItemId } = await createMenuItem({ price: '6.00', costPrice: '4.00' });
    await sellAndSettle({ outletId, terminalId, menuItemId, quantity: 3 });

    const res = await getMargin();
    const row = res.body.data.byMenuItem.find((r) => String(r.menuItemId) === String(menuItemId));
    expect(row).toMatchObject({ quantity: 3, revenue: '18.00', cost: '12.00', costSource: 'cost_price', margin: '6.00' });
  });

  it('reports a genuinely unknown cost as null, never a false zero, and excludes it from the cost/margin totals', async () => {
    const { outletId, terminalId, menuItemId } = await createMenuItem({ price: '15.00' }); // no recipe, no cost_price
    await sellAndSettle({ outletId, terminalId, menuItemId, quantity: 1 });

    const res = await getMargin();
    const row = res.body.data.byMenuItem.find((r) => String(r.menuItemId) === String(menuItemId));
    expect(row).toMatchObject({ revenue: '15.00', cost: null, costSource: 'unknown', margin: null, marginPct: null });
    expect(res.body.data.totals.itemsWithUnknownCost).toBeGreaterThanOrEqual(1);
  });

  it('rolls up revenue/cost/margin by the menu item\'s own category', async () => {
    const first = await createMenuItem({ price: '10.00', costPrice: '3.00' });
    const second = await createMenuItem({ price: '20.00', costPrice: '5.00' });
    await sellAndSettle({ outletId: first.outletId, terminalId: first.terminalId, menuItemId: first.menuItemId, quantity: 1 });
    await sellAndSettle({ outletId: second.outletId, terminalId: second.terminalId, menuItemId: second.menuItemId, quantity: 1 });

    const res = await getMargin();
    // Both fixture items above share the literal category "Margin Category".
    const category = res.body.data.byCategory.find((c) => c.category === 'Margin Category');
    expect(category).toBeTruthy();
    // At least these two rows' revenue must be included in the category total (other tests in this file share the same category and business date).
    expect(Number(category.revenue)).toBeGreaterThanOrEqual(30);
  });

  it('a voided settlement contributes nothing to revenue or margin', async () => {
    const { outletId, terminalId, menuItemId } = await createMenuItem({ price: '50.00', costPrice: '10.00' });
    const settled = await sellAndSettle({ outletId, terminalId, menuItemId, quantity: 1 });
    const before = await getMargin();
    expect(before.body.data.byMenuItem.some((r) => String(r.menuItemId) === String(menuItemId))).toBe(true);

    const settlementId = settled.settlements[0].id;
    const voided = await t.request
      .post(`/api/v1/pos/orders/${settled.order.id}/settlements/${settlementId}/void`)
      .set('Authorization', `Bearer ${managerToken()}`)
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test void' });
    expect(voided.status).toBe(200);

    const after = await getMargin();
    expect(after.body.data.byMenuItem.some((r) => String(r.menuItemId) === String(menuItemId))).toBe(false);
  });

  it('an empty range returns empty arrays and zero totals, not an error', async () => {
    const res = await getMargin(managerToken(), { dateFrom: '2020-01-01', dateTo: '2020-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ byMenuItem: [], byCategory: [], totals: { revenue: '0.00', cost: '0.00', margin: '0.00' } });
  });

  it('is pos.stock_manage only — a pos_operator is refused', async () => {
    await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
    const res = await getMargin(tokenFor({ userId: ctx.a.users[1].id }));
    expect(res.status).toBe(403);
  });
});
