'use strict';

/**
 * Stock item categories (gap closure) — mirrors `tests/pos/menu-categories.test.js`
 * exactly, for the parallel `stock_item_categories` mechanism: a registered
 * list per OUTLET (20261105090000). Stock items pick a registered, active
 * category of their own outlet (or none at all — category is optional,
 * unlike menu items'); renaming a category renames it on that outlet's
 * items; a category still in use there cannot be archived.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Stock item categories (gap closure)', () => {
  const t = useTestApp();
  let ctx;
  let outletId;

  function tokenFor(tenant, userId) {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }

  async function setRole(tenant, userIndex, role) {
    const userId = tenant.users[userIndex].id;
    const pid = tenant.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: pid }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: pid, user_id: userId, role });
  }

  const manager = () => tokenFor(ctx.a, ctx.a.users[0].id);
  const operator = () => tokenFor(ctx.a, ctx.a.users[1].id);

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'pos_operator');
    outletId = ctx.a.posOutlets[0].id;
  });

  const createCategory = (body, token = manager()) =>
    t.request.post('/api/v1/pos/stock/categories').set('Authorization', `Bearer ${token}`).send({ outlet_id: outletId, ...body });
  const createItem = (category, atOutlet = outletId) =>
    t.request
      .post('/api/v1/pos/stock/items')
      .set('Authorization', `Bearer ${manager()}`)
      .send({ outlet_id: atOutlet, name: `Stock ${Date.now()}-${Math.random()}`, unit: 'each', category });
  const listFor = (id) => t.request.get(`/api/v1/pos/stock/categories?outlet_id=${id}`).set('Authorization', `Bearer ${manager()}`);

  let outletCounter = 0;
  /** Another outlet at tenant A's property. */
  async function secondOutlet() {
    outletCounter += 1;
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, code: `STK-${Date.now()}-${outletCounter}`, name: 'Shop', type: 'bar' });
    return id;
  }

  it('registers a category, trimmed, and lists categories in display order with how many items use each', async () => {
    const wine = await createCategory({ name: '  Wine ', sort_order: 1 });
    expect(wine.status).toBe(201);
    expect(wine.body.data.name).toBe('Wine');
    await createCategory({ name: 'Cleaning supplies', sort_order: 3 });
    await createCategory({ name: 'Spirits', sort_order: 2 });

    const list = await t.request.get('/api/v1/pos/stock/categories').set('Authorization', `Bearer ${operator()}`);
    expect(list.status).toBe(200);
    const names = list.body.data.map((c) => c.name);
    expect(names.indexOf('Wine')).toBeLessThan(names.indexOf('Spirits'));
    expect(names.indexOf('Spirits')).toBeLessThan(names.indexOf('Cleaning supplies'));
    // The fixture stock item ("Fixture Vodka") uses "Beverages".
    expect(list.body.data.find((c) => c.name === 'Beverages').item_count).toBe(1);
  });

  it('a stock item may omit a category entirely — it is optional, unlike a menu item', async () => {
    const res = await createItem(undefined);
    expect(res.status).toBe(201);
    expect(res.body.data.category).toBeNull();
  });

  it('refuses a duplicate name, whatever its case', async () => {
    const res = await createCategory({ name: 'beverages' });
    expect(res.status).toBe(409);
  });

  it('refuses an empty name, or one longer than a stock item can store (60)', async () => {
    expect((await createCategory({ name: '   ' })).status).toBe(400);
    expect((await createCategory({ name: 'x'.repeat(61) })).status).toBe(400);
    const longest = await createCategory({ name: 'y'.repeat(60) });
    expect(longest.status).toBe(201);
    expect((await createItem('y'.repeat(60))).status).toBe(201);
  });

  it('lets an item keep a category that was archived after it was assigned, when its category is not being changed', async () => {
    const category = await createCategory({ name: 'Bar snacks' });
    const item = await createItem('Bar snacks');
    // Archive it behind the API's back, as a concurrent archive could.
    await t.trx('stock_item_categories').where({ id: category.body.data.id }).update({ status: 'archived' });

    const edit = await t.request
      .patch(`/api/v1/pos/stock/items/${item.body.data.id}`)
      .set('Authorization', `Bearer ${manager()}`)
      .send({ name: item.body.data.name });
    expect(edit.status).toBe(200);
    expect(edit.body.data.category).toBe('Bar snacks');
  });

  it('only lets a stock item use a registered category, storing its registered spelling', async () => {
    const unknown = await createItem('Drinkz');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('VALIDATION_CATEGORY_NOT_FOUND');

    const ok = await createItem('  beverages ');
    expect(ok.status).toBe(201);
    expect(ok.body.data.category).toBe('Beverages');

    const edit = await t.request.patch(`/api/v1/pos/stock/items/${ok.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ category: 'Nope' });
    expect(edit.status).toBe(400);
  });

  it('clearing a stock item back to no category is allowed (sending an explicit null)', async () => {
    const item = await createItem('Beverages');
    const cleared = await t.request.patch(`/api/v1/pos/stock/items/${item.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ category: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.category).toBeNull();
  });

  it('renaming a category renames it on every stock item using it', async () => {
    const created = await createCategory({ name: 'Soft drinks' });
    const item = await createItem('Soft drinks');
    const renamed = await t.request.patch(`/api/v1/pos/stock/categories/${created.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ name: 'Minerals' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('Minerals');
    const itemAfter = await t.trx('stock_items').where({ id: item.body.data.id }).first();
    expect(itemAfter.category).toBe('Minerals');
  });

  it('refuses to archive a category still in use, and archives an unused one out of the dropdown list', async () => {
    const used = await createCategory({ name: 'Garnishes' });
    await createItem('Garnishes');
    const refused = await t.request.post(`/api/v1/pos/stock/categories/${used.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT_STOCK_CATEGORY_IN_USE');

    const unused = await createCategory({ name: 'Seasonal stock' });
    const archived = await t.request.post(`/api/v1/pos/stock/categories/${unused.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`);
    expect(archived.status).toBe(200);
    const active = await t.request.get('/api/v1/pos/stock/categories').set('Authorization', `Bearer ${manager()}`);
    expect(active.body.data.map((c) => c.name)).not.toContain('Seasonal stock');
    const all = await t.request.get('/api/v1/pos/stock/categories?include_archived=true').set('Authorization', `Bearer ${manager()}`);
    expect(all.body.data.find((c) => c.name === 'Seasonal stock').status).toBe('archived');
    // An archived category can no longer be picked for an item.
    expect((await createItem('Seasonal stock')).status).toBe(400);
  });

  it('is manager-tier to change: a pos_operator can read but not register', async () => {
    expect((await createCategory({ name: 'Operator made' }, operator())).status).toBe(403);
  });

  it("keeps each tenant's categories separate", async () => {
    await setRole(ctx.b, 0, 'manager');
    const res = await t.request.get('/api/v1/pos/stock/categories').set('Authorization', `Bearer ${tokenFor(ctx.b, ctx.b.users[0].id)}`);
    expect(res.body.data.map((c) => c.name)).toEqual(['Beverages']);
    const cross = await t.request
      .patch(`/api/v1/pos/stock/categories/${ctx.a.stockItemCategories[0].id}`)
      .set('Authorization', `Bearer ${tokenFor(ctx.b, ctx.b.users[0].id)}`)
      .send({ name: 'Hijacked' });
    expect(cross.status).toBe(404);
  });

  describe('per outlet', () => {
    it("lists only the requested outlet's stock categories, and lets two outlets each have one with the same name", async () => {
      const shopId = await secondOutlet();
      const bar = await createCategory({ name: 'Dry goods' });
      const shop = await createCategory({ name: 'Dry goods', outlet_id: shopId });
      expect(bar.status).toBe(201);
      expect(shop.status).toBe(201);

      expect((await listFor(shopId)).body.data.map((c) => c.id)).toEqual([shop.body.data.id]);
      const barIds = (await listFor(outletId)).body.data.map((c) => c.id);
      expect(barIds).toContain(bar.body.data.id);
      expect(barIds).not.toContain(shop.body.data.id);

      const dup = await createCategory({ name: 'DRY GOODS' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.message).toMatch(/at this outlet/);
    });

    it('requires an active outlet of this property to register a stock category', async () => {
      const missing = await t.request.post('/api/v1/pos/stock/categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'No outlet' });
      expect(missing.status).toBe(400);
      expect((await createCategory({ name: 'Ghost', outlet_id: '999999999' })).body.error.code).toBe('VALIDATION_OUTLET_NOT_FOUND');
      expect((await createCategory({ name: 'Foreign', outlet_id: ctx.b.posOutlets[0].id })).body.error.code).toBe('VALIDATION_OUTLET_NOT_FOUND');
    });

    it("a stock item can only use its own outlet's stock categories, on create and on edit", async () => {
      const shopId = await secondOutlet();
      await createCategory({ name: 'Footwear', outlet_id: shopId });
      const refused = await createItem('Footwear');
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_CATEGORY_NOT_FOUND');
      expect((await createItem('Footwear', shopId)).status).toBe(201);

      const barItem = await createItem('Beverages');
      const moved = await t.request.patch(`/api/v1/pos/stock/items/${barItem.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ category: 'Footwear' });
      expect(moved.status).toBe(400);
    });

    it("counts, archives and renames only against the stock category's own outlet", async () => {
      const shopId = await secondOutlet();
      const barCat = await createCategory({ name: 'Linen' });
      const shopCat = await createCategory({ name: 'Linen', outlet_id: shopId });
      const barItem = await createItem('Linen');
      const shopItem = await createItem('Linen', shopId);
      await createItem('Linen', shopId);

      expect((await listFor(outletId)).body.data.find((c) => c.id === barCat.body.data.id).item_count).toBe(1);
      expect((await listFor(shopId)).body.data.find((c) => c.id === shopCat.body.data.id).item_count).toBe(2);

      await t.request.patch(`/api/v1/pos/stock/categories/${barCat.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ name: 'Towels' });
      expect((await t.trx('stock_items').where({ id: barItem.body.data.id }).first()).category).toBe('Towels');
      expect((await t.trx('stock_items').where({ id: shopItem.body.data.id }).first()).category).toBe('Linen');

      const refused = await t.request.post(`/api/v1/pos/stock/categories/${shopCat.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`);
      expect(refused.status).toBe(409);
      const otherId = await secondOutlet();
      const empty = await createCategory({ name: 'Linen', outlet_id: otherId });
      const archived = await t.request.post(`/api/v1/pos/stock/categories/${empty.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`);
      expect(archived.status).toBe(200);
    });
  });
});
