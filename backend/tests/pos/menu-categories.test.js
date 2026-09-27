'use strict';

/**
 * POS menu categories: the property's shared list (20261108090000). Menu
 * items must pick a registered, active category; renaming a category renames
 * it on its items; a category still in use cannot be archived. Each outlet
 * chooses the categories it carries and sells every item in them.
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
    expect(res.body.data.map((c) => c.name)).toEqual(['Cocktails', 'Mocktails']);
    const cross = await t.request
      .patch(`/api/v1/pos/menu-categories/${ctx.a.posMenuCategories[0].id}`)
      .set('Authorization', `Bearer ${tokenFor(ctx.b, ctx.b.users[0].id)}`)
      .send({ name: 'Hijacked' });
    expect(cross.status).toBe(404);
  });

  // The shared catalogue (20261108090000, user-requested): categories and
  // items belong to the property; each outlet chooses the categories it
  // carries and sells every item in them.
  describe('shared catalogue', () => {
    const menuAt = (id) => t.request.get(`/api/v1/pos/menu-items?outlet_id=${id}`).set('Authorization', `Bearer ${manager()}`);
    const idsOf = (res) => res.body.data.map((row) => String(row.id));
    const setCarried = (id, categoryIds) =>
      t.request.put(`/api/v1/pos/outlets/${id}/categories`).set('Authorization', `Bearer ${manager()}`).send({ category_ids: categoryIds });
    const newItem = (category, price = '10.00') =>
      t.request.post('/api/v1/pos/menu-items').set('Authorization', `Bearer ${manager()}`).send({ name: `Item ${Date.now()}-${Math.random()}`, category, price });

    it('registers a category once for the property, carried by the outlets chosen for it', async () => {
      const shopId = await secondOutlet();
      const res = await t.request
        .post('/api/v1/pos/menu-categories')
        .set('Authorization', `Bearer ${manager()}`)
        .send({ name: 'Drinks', outlet_ids: [outletId, shopId] });
      expect(res.status).toBe(201);
      expect(res.body.data.outlet_ids.sort()).toEqual([String(outletId), String(shopId)].sort());
      expect((await listFor(shopId)).body.data.map((c) => c.name)).toContain('Drinks');
      expect((await listFor(outletId)).body.data.map((c) => c.name)).toContain('Drinks');

      // One name per property: another outlet cannot register its own "Drinks".
      const dup = await t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'DRINKS', outlet_ids: [shopId] });
      expect(dup.status).toBe(409);
    });

    it('a category needs no outlet at all; an outlet sells its items only once it carries it, including items added later', async () => {
      const shopId = await secondOutlet();
      const bakery = await t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'Bakery' });
      expect(bakery.status).toBe(201);
      expect(bakery.body.data.outlet_ids).toEqual([]);
      const bread = await newItem('Bakery');
      expect(bread.status).toBe(201);
      expect(idsOf(await menuAt(shopId))).not.toContain(String(bread.body.data.id));

      const carried = await setCarried(shopId, [bakery.body.data.id]);
      expect(carried.status).toBe(200);
      expect(carried.body.data.category_ids).toEqual([String(bakery.body.data.id)]);
      expect(idsOf(await menuAt(shopId))).toContain(String(bread.body.data.id));

      const croissant = await newItem('Bakery');
      expect(idsOf(await menuAt(shopId))).toContain(String(croissant.body.data.id));
      expect(idsOf(await menuAt(outletId))).not.toContain(String(croissant.body.data.id));

      // Dropping the category stops the outlet selling its items.
      await setCarried(shopId, []);
      expect(idsOf(await menuAt(shopId))).not.toContain(String(bread.body.data.id));
    });

    it('refuses an unknown category or outlet when choosing categories', async () => {
      const shopId = await secondOutlet();
      expect((await setCarried(shopId, ['999999999'])).body.error.code).toBe('VALIDATION_CATEGORY_NOT_FOUND');
      expect((await setCarried('999999999', [])).status).toBe(404);
      expect((await setCarried(ctx.b.posOutlets[0].id, [])).status).toBe(404);
      const register = await t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'Ghost', outlet_ids: ['999999999'] });
      expect(register.body.error.code).toBe('VALIDATION_OUTLET_NOT_FOUND');
      // pos.operate may read, not choose.
      const byOperator = await t.request.put(`/api/v1/pos/outlets/${shopId}/categories`).set('Authorization', `Bearer ${operator()}`).send({ category_ids: [] });
      expect(byOperator.status).toBe(403);
    });

    it('adding an item from an outlet makes that outlet carry its category', async () => {
      const shopId = await secondOutlet();
      await t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'Snacks' });
      const chips = await createItem('Snacks', shopId);
      expect(chips.status).toBe(201);
      expect(idsOf(await menuAt(shopId))).toContain(String(chips.body.data.id));
    });

    it('renaming a category renames it on every item, and counts every item of the property', async () => {
      const shopId = await secondOutlet();
      const grill = await t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'Charcoal', outlet_ids: [outletId, shopId] });
      const a = await newItem('Charcoal');
      const b = await newItem('Charcoal');
      const list = await listFor(shopId);
      expect(list.body.data.find((c) => c.id === grill.body.data.id).item_count).toBe(2);

      await t.request.patch(`/api/v1/pos/menu-categories/${grill.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ name: 'Braai' });
      expect((await t.trx('pos_menu_items').where({ id: a.body.data.id }).first()).category).toBe('Braai');
      expect((await t.trx('pos_menu_items').where({ id: b.body.data.id }).first()).category).toBe('Braai');
      // Both outlets still sell them — they carry the category, not its name.
      expect(idsOf(await menuAt(shopId))).toEqual(expect.arrayContaining([String(a.body.data.id), String(b.body.data.id)]));
    });

    it('an outlet can set its own price; the others keep the main price, and the Register charges the outlet price', async () => {
      const shopId = await secondOutlet();
      const water = await t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'Water', outlet_ids: [outletId, shopId] });
      expect(water.status).toBe(201);
      const bottle = await newItem('Water', '3.00');

      const priced = await t.request
        .put(`/api/v1/pos/menu-items/${bottle.body.data.id}/outlet-price`)
        .set('Authorization', `Bearer ${manager()}`)
        .send({ outlet_id: shopId, price: '4.50' });
      expect(priced.status).toBe(200);
      expect(priced.body.data).toMatchObject({ price: '4.50', base_price: '3.00', outlet_price: '4.50' });

      const atShop = (await menuAt(shopId)).body.data.find((row) => String(row.id) === String(bottle.body.data.id));
      const atBar = (await menuAt(outletId)).body.data.find((row) => String(row.id) === String(bottle.body.data.id));
      expect(atShop.price).toBe('4.50');
      expect(atBar.price).toBe('3.00');

      const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, outlet_id: shopId, device_ref: `SHOPTERM-${Date.now()}` });
      const order = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${manager()}`).send({ outlet_id: shopId, terminal_id: terminalId, table_label: 'S1' });
      const added = await t.request.post(`/api/v1/pos/orders/${order.body.data.id}/items`).set('Authorization', `Bearer ${manager()}`).send({ menu_item_id: bottle.body.data.id, quantity: 1 });
      expect(added.status).toBe(200);
      expect(added.body.data.items[0].unit_price).toBe('4.50');

      // Back to the main price.
      const cleared = await t.request.put(`/api/v1/pos/menu-items/${bottle.body.data.id}/outlet-price`).set('Authorization', `Bearer ${manager()}`).send({ outlet_id: shopId, price: null });
      expect(cleared.body.data.price).toBe('3.00');
    });

    it('marking an item sold out at one outlet leaves it on sale at the others', async () => {
      const shopId = await secondOutlet();
      await t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'Juice', outlet_ids: [outletId, shopId] });
      const juice = await newItem('Juice');
      const off = await t.request
        .post(`/api/v1/pos/menu-items/${juice.body.data.id}/set-availability`)
        .set('Authorization', `Bearer ${operator()}`)
        .send({ outlet_id: shopId, is_available: false });
      expect(off.status).toBe(200);
      expect((await menuAt(shopId)).body.data.find((row) => String(row.id) === String(juice.body.data.id)).is_available).toBe(false);
      expect((await menuAt(outletId)).body.data.find((row) => String(row.id) === String(juice.body.data.id)).is_available).toBe(true);
    });

    it("the Register refuses an item the order's outlet does not sell", async () => {
      const shopId = await secondOutlet();
      await t.request.post('/api/v1/pos/menu-categories').set('Authorization', `Bearer ${manager()}`).send({ name: 'Shop only', outlet_ids: [shopId] });
      const shopItem = await newItem('Shop only');
      const order = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${manager()}`).send({ outlet_id: outletId, terminal_id: ctx.a.posTerminals[0].id, table_label: 'B9' });
      const added = await t.request.post(`/api/v1/pos/orders/${order.body.data.id}/items`).set('Authorization', `Bearer ${manager()}`).send({ menu_item_id: shopItem.body.data.id, quantity: 1 });
      expect(added.status).toBe(400);
      expect(added.body.error.code).toBe('VALIDATION_MENU_ITEM_NOT_FOUND');
    });
  });
});
