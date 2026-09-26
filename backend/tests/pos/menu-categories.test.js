'use strict';

/**
 * POS menu categories: a registered list per OUTLET. Menu items must pick a
 * registered, active category of their own outlet; renaming a category renames
 * it on that outlet's items; a category still in use there cannot be archived;
 * another outlet's same-named category is a different, independent row.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('POS menu categories', () => {
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
    t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${token}`).send({ outlet_id: outletId, ...body });
  const createItem = (category, atOutlet = outletId) =>
    t.request.post('/api/v1/pos/menu-items').set('Authorization', `Bearer ${manager()}`).send({ outlet_id: atOutlet, name: `Item ${Date.now()}-${Math.random()}`, category, price: '10.00' });
  const listFor = (id) => t.request.get(`/api/v1/pos/menu-categories?outlet_id=${id}`).set('Authorization', `Bearer ${manager()}`);

  let outletCounter = 0;
  /** A second outlet at tenant A's property. */
  async function secondOutlet() {
    outletCounter += 1;
    const [id] = await t.trx('pos_outlets').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code: `SHOP-${Date.now()}-${outletCounter}`,
      name: 'Shop',
      type: 'bar',
    });
    return id;
  }

  it('registers a category, trimmed, and lists categories in display order with how many items use each', async () => {
    const starters = await createCategory({ name: '  Starters ', sort_order: 1 });
    expect(starters.status).toBe(201);
    expect(starters.body.data.name).toBe('Starters');
    await createCategory({ name: 'Desserts', sort_order: 3 });
    await createCategory({ name: 'Mains', sort_order: 2 });

    const list = await t.request.get('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${operator()}`);
    expect(list.status).toBe(200);
    const names = list.body.data.map((c) => c.name);
    expect(names.indexOf('Starters')).toBeLessThan(names.indexOf('Mains'));
    expect(names.indexOf('Mains')).toBeLessThan(names.indexOf('Desserts'));
    // The fixture menu item uses "Cocktails".
    expect(list.body.data.find((c) => c.name === 'Cocktails').item_count).toBe(1);
  });

  it('refuses a duplicate name, whatever its case', async () => {
    const res = await createCategory({ name: 'cocktails' });
    expect(res.status).toBe(409);
  });

  it('refuses an empty name, or one longer than a menu item can store (60)', async () => {
    expect((await createCategory({ name: '   ' })).status).toBe(400);
    expect((await createCategory({ name: 'x'.repeat(61) })).status).toBe(400);
    const longest = await createCategory({ name: 'y'.repeat(60) });
    expect(longest.status).toBe(201);
    expect((await createItem('y'.repeat(60))).status).toBe(201);
  });

  it('lets an item keep a category that was archived after it was assigned, when its category is not being changed', async () => {
    const category = await createCategory({ name: 'Weekend specials' });
    const item = await createItem('Weekend specials');
    // Archive it behind the API's back, as a concurrent archive could.
    await t.trx('pos_menu_categories').where({ id: category.body.data.id }).update({ status: 'archived' });

    const edit = await t.request
      .patch(`/api/v1/pos/menu-items/${item.body.data.id}`)
      .set('Authorization', `Bearer ${manager()}`)
      .send({ name: item.body.data.name, category: 'Weekend specials', price: '12.50' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.price).toBe('12.50');
    expect(edit.body.data.category).toBe('Weekend specials');
  });

  it('only lets a menu item use a registered category, storing its registered spelling', async () => {
    const unknown = await createItem('Drinkz');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('VALIDATION_CATEGORY_NOT_FOUND');

    const ok = await createItem('  cocktails ');
    expect(ok.status).toBe(201);
    expect(ok.body.data.category).toBe('Cocktails');

    const edit = await t.request.patch(`/api/v1/pos/menu-items/${ok.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ category: 'Nope' });
    expect(edit.status).toBe(400);
  });

  it('renaming a category renames it on every menu item using it', async () => {
    const created = await createCategory({ name: 'Soft drinks' });
    const item = await createItem('Soft drinks');
    const renamed = await t.request.patch(`/api/v1/pos/menu-categories/${created.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ name: 'Minerals' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('Minerals');
    const itemAfter = await t.trx('pos_menu_items').where({ id: item.body.data.id }).first();
    expect(itemAfter.category).toBe('Minerals');
  });

  it('refuses to archive a category still in use, and archives an unused one out of the dropdown list', async () => {
    const used = await createCategory({ name: 'Grill' });
    await createItem('Grill');
    const refused = await t.request.post(`/api/v1/pos/menu-categories/${used.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT_POS_MENU_CATEGORY_IN_USE');

    const unused = await createCategory({ name: 'Seasonal' });
    const archived = await t.request.post(`/api/v1/pos/menu-categories/${unused.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`);
    expect(archived.status).toBe(200);
    const active = await t.request.get('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`);
    expect(active.body.data.map((c) => c.name)).not.toContain('Seasonal');
    const all = await t.request.get('/api/v1/pos/menu-categories?include_archived=true').set('Authorization', `Bearer ${manager()}`);
    expect(all.body.data.find((c) => c.name === 'Seasonal').status).toBe('archived');
    // An archived category can no longer be picked for an item.
    expect((await createItem('Seasonal')).status).toBe(400);
  });

  it('is manager-tier to change: a pos_operator can read but not register', async () => {
    expect((await createCategory({ name: 'Operator made' }, operator())).status).toBe(403);
  });

  it("keeps each tenant's categories separate", async () => {
    await setRole(ctx.b, 0, 'manager');
    const res = await t.request.get('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${tokenFor(ctx.b, ctx.b.users[0].id)}`);
    expect(res.body.data.map((c) => c.name)).toEqual(['Cocktails']);
    const cross = await t.request
      .patch(`/api/v1/pos/menu-categories/${ctx.a.posMenuCategories[0].id}`)
      .set('Authorization', `Bearer ${tokenFor(ctx.b, ctx.b.users[0].id)}`)
      .send({ name: 'Hijacked' });
    expect(cross.status).toBe(404);
  });

  describe('per outlet', () => {
    it("lists only the requested outlet's categories, and lets two outlets each have one with the same name", async () => {
      const shopId = await secondOutlet();
      const bar = await createCategory({ name: 'Drinks' });
      const shop = await createCategory({ name: 'Drinks', outlet_id: shopId });
      expect(bar.status).toBe(201);
      expect(shop.status).toBe(201);
      expect(String(shop.body.data.outlet_id)).toBe(String(shopId));

      const shopList = await listFor(shopId);
      expect(shopList.body.data.map((c) => c.id)).toEqual([shop.body.data.id]);
      const barList = await listFor(outletId);
      expect(barList.body.data.map((c) => c.id)).toContain(bar.body.data.id);
      expect(barList.body.data.map((c) => c.id)).not.toContain(shop.body.data.id);
      // Without outlet_id, every outlet's categories come back, each with its outlet.
      const all = await t.request.get('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`);
      expect(all.body.data.map((c) => c.id)).toEqual(expect.arrayContaining([bar.body.data.id, shop.body.data.id]));
    });

    it('still refuses a duplicate name at the same outlet, saying so', async () => {
      await createCategory({ name: 'Wraps' });
      const dup = await createCategory({ name: 'WRAPS' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.message).toMatch(/at this outlet/);
    });

    it('requires an active outlet of this property to register a category', async () => {
      const missing = await t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'No outlet' });
      expect(missing.status).toBe(400);
      expect((await createCategory({ name: 'Ghost', outlet_id: '999999999' })).body.error.code).toBe('VALIDATION_OUTLET_NOT_FOUND');
      expect((await createCategory({ name: 'Foreign', outlet_id: ctx.b.posOutlets[0].id })).body.error.code).toBe('VALIDATION_OUTLET_NOT_FOUND');
      const archivedId = await secondOutlet();
      await t.trx('pos_outlets').where({ id: archivedId }).update({ status: 'archived' });
      expect((await createCategory({ name: 'Old', outlet_id: archivedId })).body.error.code).toBe('VALIDATION_OUTLET_NOT_FOUND');
    });

    it("a menu item can only use its own outlet's categories, on create and on edit", async () => {
      const shopId = await secondOutlet();
      await createCategory({ name: 'Bakery', outlet_id: shopId });
      const refused = await createItem('Bakery');
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_CATEGORY_NOT_FOUND');
      expect((await createItem('Bakery', shopId)).status).toBe(201);

      const barItem = await createItem('Cocktails');
      const moved = await t.request.patch(`/api/v1/pos/menu-items/${barItem.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ category: 'Bakery' });
      expect(moved.status).toBe(400);
    });

    it("counts, archives and renames only against the category's own outlet", async () => {
      const shopId = await secondOutlet();
      const barGrill = await createCategory({ name: 'Charcoal' });
      const shopGrill = await createCategory({ name: 'Charcoal', outlet_id: shopId });
      const barItem = await createItem('Charcoal');
      const shopItem = await createItem('Charcoal', shopId);
      await createItem('Charcoal', shopId);

      const barList = await listFor(outletId);
      expect(barList.body.data.find((c) => c.id === barGrill.body.data.id).item_count).toBe(1);
      const shopList = await listFor(shopId);
      expect(shopList.body.data.find((c) => c.id === shopGrill.body.data.id).item_count).toBe(2);

      // Rename the bar's row: only the bar's item follows.
      await t.request.patch(`/api/v1/pos/menu-categories/${barGrill.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ name: 'Braai' });
      expect((await t.trx('pos_menu_items').where({ id: barItem.body.data.id }).first()).category).toBe('Braai');
      expect((await t.trx('pos_menu_items').where({ id: shopItem.body.data.id }).first()).category).toBe('Charcoal');

      // The shop's category is in use at the shop; a same-named empty one elsewhere archives fine.
      const refused = await t.request.post(`/api/v1/pos/menu-categories/${shopGrill.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`);
      expect(refused.status).toBe(409);
      const otherId = await secondOutlet();
      const empty = await createCategory({ name: 'Charcoal', outlet_id: otherId });
      const archived = await t.request.post(`/api/v1/pos/menu-categories/${empty.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`);
      expect(archived.status).toBe(200);
    });
  });
});
