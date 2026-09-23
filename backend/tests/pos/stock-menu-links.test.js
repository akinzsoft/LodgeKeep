'use strict';

/**
 * `GET /pos/stock/menu-links` (gap closure) — which active Register menu
 * items use which stock items, so the Stock items screen can tell "sold
 * directly" from "ingredient only" from "not sold at all" without an N+1
 * of per-menu-item recipe calls.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Stock ↔ Register menu links (gap closure)', () => {
  const t = useTestApp();
  let ctx;
  let counter = 0;

  function tokenFor(tenant, userIndex) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[userIndex].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[0].id),
    });
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
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: tenant.id, property_id: tenant.properties[0].id, code: `LNK${Date.now().toString(36)}${counter}`, name: `Link outlet ${counter}`, type: 'bar' });
    return id;
  }

  async function newMenuItem(tenant, outletId, { status = 'active' } = {}) {
    counter += 1;
    const [id] = await t.trx('pos_menu_items').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      outlet_id: outletId,
      name: `Link menu ${counter}`,
      category: 'Links',
      price: '5.00',
      status,
    });
    return id;
  }

  async function newStockItem(tenant, outletId) {
    counter += 1;
    const [id] = await t.trx('stock_items').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      outlet_id: outletId,
      name: `Link stock ${counter}`,
      unit: 'ml',
      purchase_cost: '1.00',
      reorder_level: '0.000',
      current_quantity: '100.000',
    });
    return id;
  }

  async function link(tenant, menuItemId, stockItemId, quantity = '1.000') {
    await t.trx('pos_menu_item_components').insert({ tenant_id: tenant.id, property_id: tenant.properties[0].id, menu_item_id: menuItemId, stock_item_id: stockItemId, quantity });
  }

  const getLinks = (query = '', token = manager()) => t.request.get(`/api/v1/pos/stock/menu-links${query}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'pos_operator');
  });

  it('returns one row per recipe component with the menu item and its component count', async () => {
    const outlet = await newOutlet(ctx.a);
    const single = await newMenuItem(ctx.a, outlet);
    const cocktail = await newMenuItem(ctx.a, outlet);
    const gin = await newStockItem(ctx.a, outlet);
    const tonic = await newStockItem(ctx.a, outlet);
    await link(ctx.a, single, gin);
    await link(ctx.a, cocktail, gin, '50.000');
    await link(ctx.a, cocktail, tonic, '150.000');

    const res = await getLinks(`?outlet_id=${outlet}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);

    const forSingle = res.body.data.filter((r) => String(r.menu_item_id) === String(single));
    expect(forSingle).toHaveLength(1);
    expect(forSingle[0].component_count).toBe(1);
    expect(String(forSingle[0].stock_item_id)).toBe(String(gin));

    const forCocktail = res.body.data.filter((r) => String(r.menu_item_id) === String(cocktail));
    expect(forCocktail.map((r) => r.component_count)).toEqual([2, 2]);
    expect(forCocktail[0]).toMatchObject({ menu_item_category: 'Links', menu_item_available: true });
  });

  it('excludes archived menu items, and filters by outlet when asked', async () => {
    const outlet = await newOutlet(ctx.a);
    const other = await newOutlet(ctx.a);
    const archived = await newMenuItem(ctx.a, outlet, { status: 'archived' });
    const active = await newMenuItem(ctx.a, outlet);
    const elsewhere = await newMenuItem(ctx.a, other);
    const stock = await newStockItem(ctx.a, outlet);
    const stockElsewhere = await newStockItem(ctx.a, other);
    await link(ctx.a, archived, stock);
    await link(ctx.a, active, stock);
    await link(ctx.a, elsewhere, stockElsewhere);

    const scoped = await getLinks(`?outlet_id=${outlet}`);
    expect(scoped.body.data.map((r) => String(r.menu_item_id))).toEqual([String(active)]);

    const all = (await getLinks()).body.data.map((r) => String(r.menu_item_id));
    expect(all).toEqual(expect.arrayContaining([String(active), String(elsewhere)]));
    expect(all).not.toContain(String(archived));
  });

  it('returns an empty list for an outlet with no menu items or recipes', async () => {
    const outlet = await newOutlet(ctx.a);
    const res = await getLinks(`?outlet_id=${outlet}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('needs pos.stock_manage — a pos_operator is refused', async () => {
    const res = await getLinks('', operator());
    expect(res.status).toBe(403);
  });

  it("never returns another tenant's links", async () => {
    const outletB = await newOutlet(ctx.b);
    const menuB = await newMenuItem(ctx.b, outletB);
    const stockB = await newStockItem(ctx.b, outletB);
    await link(ctx.b, menuB, stockB);

    const res = await getLinks();
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => String(r.menu_item_id))).not.toContain(String(menuB));
  });
});
