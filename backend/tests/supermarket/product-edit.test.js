'use strict';

/**
 * Supermarket product editing: list, edit price/name/category/cost, archive and
 * restore. Manager-only (`supermarket.manage`); never changes a hotel menu
 * (refused, naming the outlet, while a hotel outlet carries the category);
 * past sales keep the price they sold at.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem, insertStockItem, insertStockCategories, insertMenuCategories } = require('../helpers/catalogue');

describe('supermarket product editing', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let counter = 0;
  let martId;
  let barId;
  let users;
  const DATE = '2027-10-11';

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId, tenant = ctx.a) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const as = (userId, tenant = ctx.a) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    patch: (url) => t.request.patch(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`).set('Idempotency-Key', `pe-${next()}`),
  });
  const list = (userId, query = '') => as(userId).get(`/api/v1/supermarket/products?outlet_id=${martId}${query}`);
  const edit = (userId, id, body, outlet = martId) => as(userId).patch(`/api/v1/supermarket/products/${id}`).send({ outlet_id: outlet, ...body });
  const archive = (userId, id, outlet = martId) => as(userId).post(`/api/v1/supermarket/products/${id}/archive`).send({ outlet_id: outlet });
  const restore = (userId, id, outlet = martId) => as(userId).post(`/api/v1/supermarket/products/${id}/restore`).send({ outlet_id: outlet });
  const sell = (itemId, quantity = 1) => as(users.operator).post('/api/v1/supermarket/sales').send({ outlet_id: martId, method: 'cash', items: [{ menu_item_id: itemId, quantity }] });
  const row = (id) => t.trx('pos_menu_items').where({ id }).first();

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }
  async function newOutlet(type, name) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `T${next()}`.slice(0, 30), name, type });
    return id;
  }
  const scope = () => ({ tenant_id: ctx.a.id, property_id: propertyId });

  /** A product the mart sells: menu item in `category` (carried by the mart), its own 1:1 stock item, an optional barcode. */
  async function product(name, { category = 'PE Mart', price = '10.00', barcode, stockQty = '5.000', withStock = true } = {}) {
    await insertStockCategories(t.trx, { ...scope(), name: category, outlet_id: martId });
    const [id] = await insertMenuItem(t.trx, { ...scope(), outlet_id: martId, name, category, price });
    if (barcode) await t.trx('supermarket_barcodes').insert({ ...scope(), menu_item_id: id, barcode });
    let stockId = null;
    if (withStock) {
      [stockId] = await insertStockItem(t.trx, { ...scope(), outlet_id: martId, name: `${name} stock`, unit: 'pack', category, purchase_cost: '3.00', current_quantity: stockQty, reorder_level: '1.000' });
      await t.trx('pos_menu_item_components').insert({ ...scope(), menu_item_id: id, stock_item_id: stockId, quantity: '1.000' });
      // A real opening movement, so the ledger (not just the level row) holds the quantity.
      const received = await as(users.manager).post('/api/v1/pos/stock/goods-received').send({ outlet_id: martId, lines: [{ stock_item_id: stockId, quantity: stockQty, unit_cost: '3.00' }] });
      expect(received.status).toBe(201);
    }
    return { id, stockId };
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: DATE });
    users = { manager: ctx.a.users[0].id, operator: ctx.a.users[1].id };
    await setRole(users.manager, 'manager');
    await setRole(users.operator, 'pos_operator');
    martId = await newOutlet('supermarket', 'PE Mart');
    barId = await newOutlet('bar', 'PE Bar');
  });

  describe('permissions and outlet rules', () => {
    it('is manager-only: a cashier cannot list, edit, archive or restore', async () => {
      const p = await product('Perm item');
      expect((await list(users.operator)).status).toBe(403);
      expect((await edit(users.operator, p.id, { price: '11.00' })).status).toBe(403);
      expect((await archive(users.operator, p.id)).status).toBe(403);
      expect((await restore(users.operator, p.id)).status).toBe(403);
      expect((await row(p.id)).price).toBe('10.00');
    });

    it('needs an outlet, refuses a non-supermarket outlet, and treats a product the mart does not carry as not found', async () => {
      const p = await product('Outlet rules');
      expect((await as(users.manager).get('/api/v1/supermarket/products')).status).toBe(400);
      expect((await as(users.manager).get(`/api/v1/supermarket/products?outlet_id=${barId}`)).status).toBe(422);
      const [hotelOnly] = await insertMenuItem(t.trx, { ...scope(), outlet_id: barId, name: 'Bar only', category: 'PE Bar Only', price: '5.00' });
      expect((await edit(users.manager, hotelOnly, { price: '6.00' })).status).toBe(404);
      expect((await edit(users.manager, 99999999, { price: '6.00' })).status).toBe(404);
      expect((await edit(users.manager, p.id, { price: '6.00' }, barId)).status).toBe(422);
      expect((await row(hotelOnly)).price).toBe('5.00');
    });

    it("never reaches another tenant's products", async () => {
      const p = await product('Tenant guard');
      const res = await as(ctx.b.users[0].id, ctx.b).patch(`/api/v1/supermarket/products/${p.id}`).send({ outlet_id: martId, price: '1.00' });
      expect([400, 403, 404, 422]).toContain(res.status);
      expect((await row(p.id)).price).toBe('10.00');
    });
  });

  describe('list', () => {
    it('lists the mart products with price, barcodes, stock and status; archived only when asked; hotel-only products never', async () => {
      const p = await product('List item', { barcode: `L${next()}`, stockQty: '4.000' });
      const [hotelOnly] = await insertMenuItem(t.trx, { ...scope(), outlet_id: barId, name: 'List bar item', category: 'PE Bar Only', price: '5.00' });
      const res = await list(users.manager);
      expect(res.status).toBe(200);
      const found = res.body.data.find((x) => x.id === String(p.id));
      expect(found).toMatchObject({ name: 'List item', category: 'PE Mart', price: '10.00', status: 'active', stock_cost: '3.00', shared_with: [] });
      expect(found.barcodes).toHaveLength(1);
      expect(res.body.data.some((x) => x.id === String(hotelOnly))).toBe(false);

      await archive(users.manager, p.id);
      expect((await list(users.manager)).body.data.some((x) => x.id === String(p.id))).toBe(false);
      const withArchived = await list(users.manager, '&include_archived=true');
      expect(withArchived.body.data.find((x) => x.id === String(p.id)).status).toBe('archived');
    });
  });

  describe('editing', () => {
    it('changes the price, audits it, and never changes a past sale', async () => {
      const p = await product('Price item', { price: '10.00' });
      const sold = await sell(p.id);
      expect(sold.status).toBe(201);
      const saleId = sold.body.data.id;

      const res = await edit(users.manager, p.id, { price: '12.50' });
      expect(res.status).toBe(200);
      expect(res.body.data.price).toBe('12.50');

      // The old receipt keeps what it sold at; a new sale uses the new price.
      const line = await t.trx('supermarket_sale_lines').where({ sale_id: saleId }).first();
      expect(line.unit_price).toBe('10.00');
      expect(line.item_name).toBe('Price item');
      const again = await sell(p.id);
      expect(again.status).toBe(201);
      const newLine = await t.trx('supermarket_sale_lines').where({ sale_id: again.body.data.id }).first();
      expect(newLine.unit_price).toBe('12.50');

      const audit = await t.trx('audit_log').where({ entity_type: 'pos_menu_items', entity_id: p.id, action: 'supermarket_product_edit' }).first();
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit.before_state)).toContain('10.00');
      expect(JSON.stringify(audit.after_state)).toContain('12.50');
    });

    it('rejects a bad price, a blank name, an empty body and unknown fields only', async () => {
      const p = await product('Validate item');
      expect((await edit(users.manager, p.id, { price: '12.345' })).status).toBe(400);
      expect((await edit(users.manager, p.id, { price: '-1' })).status).toBe(400);
      expect((await edit(users.manager, p.id, { price: 'abc' })).status).toBe(400);
      expect((await edit(users.manager, p.id, { name: '   ' })).status).toBe(400);
      expect((await edit(users.manager, p.id, { cost_price: '1.234' })).status).toBe(400);
      expect((await edit(users.manager, p.id, {})).status).toBe(400);
      expect((await edit(users.manager, p.id, { status: 'archived', tenant_id: 99 })).status).toBe(400);
      const stored = await row(p.id);
      expect(stored.price).toBe('10.00');
      expect(stored.status).toBe('active');
    });

    it('renames the product and its stock item, and refuses a duplicate active name in the same category', async () => {
      const p = await product('Rename me');
      await product('Taken name');
      expect((await edit(users.manager, p.id, { name: 'taken NAME' })).status).toBe(409);
      expect((await row(p.id)).name).toBe('Rename me');

      const res = await edit(users.manager, p.id, { name: '  Renamed  ' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed');
      expect((await t.trx('stock_items').where({ id: p.stockId }).first()).name).toBe('Renamed');
    });

    it('moves the product to another category the mart carries (and its stock item with it) but not to one it does not', async () => {
      const p = await product('Move me', { category: 'PE Mart' });
      await insertStockCategories(t.trx, { ...scope(), name: 'PE Mart Two', outlet_id: martId });
      await insertMenuCategories(t.trx, { ...scope(), name: 'PE Elsewhere' }); // exists, mart does not carry it

      expect((await edit(users.manager, p.id, { category: 'PE Elsewhere' })).status).toBe(422);
      expect((await edit(users.manager, p.id, { category: 'Does not exist' })).status).toBe(422);
      expect((await row(p.id)).category).toBe('PE Mart');

      const res = await edit(users.manager, p.id, { category: 'pe mart two' });
      expect(res.status).toBe(200);
      expect(res.body.data.category).toBe('PE Mart Two');
      expect((await t.trx('stock_items').where({ id: p.stockId }).first()).category).toBe('PE Mart Two');
    });

    it('sets the cost on the stock item and the menu item, so profit reports see it', async () => {
      const p = await product('Cost item');
      const res = await edit(users.manager, p.id, { cost_price: '4.25' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ cost_price: '4.25', stock_cost: '4.25' });
      expect((await t.trx('stock_items').where({ id: p.stockId }).first()).purchase_cost).toBe('4.25');
      expect((await row(p.id)).cost_price).toBe('4.25');
    });

    it('refuses a cost change when another product shares the stock item, and leaves a shared stock item\'s name alone', async () => {
      const a = await product('Shared stock A');
      const [b] = await insertMenuItem(t.trx, { ...scope(), outlet_id: martId, name: 'Shared stock B', category: 'PE Mart', price: '2.00' });
      await t.trx('pos_menu_item_components').insert({ ...scope(), menu_item_id: b, stock_item_id: a.stockId, quantity: '1.000' });
      const res = await edit(users.manager, a.id, { cost_price: '9.00' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_PRODUCT_COST_SHARED');
      expect((await t.trx('stock_items').where({ id: a.stockId }).first()).purchase_cost).toBe('3.00');

      expect((await edit(users.manager, a.id, { name: 'Shared stock A2' })).status).toBe(200);
      expect((await t.trx('stock_items').where({ id: a.stockId }).first()).name).toBe('Shared stock A stock');
    });

    it("replaces the mart's own price for the product, so the till charges the new price", async () => {
      const p = await product('Override item', { price: '10.00' });
      await t.trx('pos_outlet_menu_items').insert({ ...scope(), outlet_id: martId, menu_item_id: p.id, price: '15.00' });
      expect((await list(users.manager)).body.data.find((x) => x.id === String(p.id)).price).toBe('15.00');

      const res = await edit(users.manager, p.id, { price: '20.00' });
      expect(res.status).toBe(200);
      expect(res.body.data.price).toBe('20.00');
      const sold = await sell(p.id);
      expect(sold.status).toBe(201);
      const line = await t.trx('supermarket_sale_lines').where({ sale_id: sold.body.data.id }).first();
      expect(line.unit_price).toBe('20.00');
    });

    it('refuses a cost change when the recipe is not a single stock item (it would change nothing)', async () => {
      const p = await product('Multi recipe');
      const [second] = await insertStockItem(t.trx, { ...scope(), outlet_id: martId, name: 'Second part', unit: 'pack', purchase_cost: '1.00', current_quantity: '1.000', reorder_level: '0.000' });
      await t.trx('pos_menu_item_components').insert({ ...scope(), menu_item_id: p.id, stock_item_id: second, quantity: '1.000' });
      const res = await edit(users.manager, p.id, { cost_price: '5.00' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_PRODUCT_COST_SHARED');
      expect((await row(p.id)).cost_price).toBeNull();
    });

    it('edits a product with no stock recipe (menu cost only)', async () => {
      const p = await product('No recipe', { withStock: false });
      const res = await edit(users.manager, p.id, { price: '7.00', cost_price: '2.00' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ price: '7.00', cost_price: '2.00', stock_cost: null });
    });
  });

  describe('hotel isolation', () => {
    it('refuses every change, naming the outlet, while a hotel outlet carries the category, and leaves the hotel menu untouched', async () => {
      const p = await product('Shared cat', { category: 'PE Shared', price: '10.00' });
      await insertMenuCategories(t.trx, { ...scope(), outlet_id: barId, name: 'PE Shared' }); // the Bar now sells it too
      const barBefore = JSON.stringify(await t.trx('pos_menu_items').where({ category: 'PE Shared' }).orderBy('id'));

      for (const res of [await edit(users.manager, p.id, { price: '99.00' }), await edit(users.manager, p.id, { name: 'Hacked' }), await archive(users.manager, p.id)]) {
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('BUSINESS_RULE_PRODUCT_SHARED_WITH_HOTEL_OUTLET');
        expect(res.body.error.message).toContain('PE Bar');
      }
      expect(JSON.stringify(await t.trx('pos_menu_items').where({ category: 'PE Shared' }).orderBy('id'))).toBe(barBefore);
      const listed = (await list(users.manager)).body.data.find((x) => x.id === String(p.id));
      expect(listed.shared_with).toEqual(['PE Bar']);
    });

    it('refuses a move into a category a hotel outlet carries', async () => {
      const p = await product('Move to hotel cat');
      await insertStockCategories(t.trx, { ...scope(), name: 'PE Hotel Carried', outlet_id: martId });
      await insertMenuCategories(t.trx, { ...scope(), outlet_id: barId, name: 'PE Hotel Carried' });
      const res = await edit(users.manager, p.id, { category: 'PE Hotel Carried' });
      expect(res.status).toBe(422);
      expect((await row(p.id)).category).toBe('PE Mart');
    });

    it('does not touch the shared hotel menu endpoint: the Bar menu is identical before and after a mart edit', async () => {
      const p = await product('Isolated');
      await insertMenuItem(t.trx, { ...scope(), outlet_id: barId, name: 'Bar beer', category: 'PE Bar Only', price: '6.00' });
      const snapshot = async () => JSON.stringify(await t.trx('pos_menu_items').whereNot({ id: p.id }).orderBy('id'));
      const before = await snapshot();
      expect((await edit(users.manager, p.id, { price: '13.00', name: 'Isolated 2', cost_price: '1.00' })).status).toBe(200);
      expect((await archive(users.manager, p.id)).status).toBe(200);
      expect(await snapshot()).toBe(before);
    });
  });

  describe('archive and restore', () => {
    it('hides an archived product from the till and the scanner, keeps its history and barcode, and restore brings it back', async () => {
      const barcode = `A${next()}`;
      const p = await product('Archive me', { barcode });
      const sold = await sell(p.id);
      expect(sold.status).toBe(201);

      const res = await archive(users.manager, p.id, martId);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('archived');

      expect((await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${martId}&barcode=${barcode}`)).status).toBe(404);
      const search = await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${martId}&q=Archive%20me`);
      expect(search.body.data).toHaveLength(0);
      expect((await sell(p.id)).status).toBeGreaterThanOrEqual(400);

      // Sales history and the barcode row stay.
      expect((await as(users.operator).get(`/api/v1/supermarket/sales/${sold.body.data.id}`)).status).toBe(200);
      expect(await t.trx('supermarket_barcodes').where({ menu_item_id: p.id, barcode }).first('id')).toBeTruthy();

      const back = await restore(users.manager, p.id);
      expect(back.status).toBe(200);
      expect(back.body.data.status).toBe('active');
      expect((await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${martId}&barcode=${barcode}`)).status).toBe(200);
      expect(await t.trx('audit_log').where({ entity_type: 'pos_menu_items', entity_id: p.id, action: 'supermarket_product_restore' }).first()).toBeTruthy();
    });

    it('is a no-op (and not audited again) when the product is already in that state', async () => {
      const p = await product('Twice');
      expect((await archive(users.manager, p.id)).status).toBe(200);
      expect((await archive(users.manager, p.id)).status).toBe(200);
      const rows = await t.trx('audit_log').where({ entity_type: 'pos_menu_items', entity_id: p.id, action: 'supermarket_product_archive' });
      expect(rows).toHaveLength(1);
    });

    it('refuses to restore when another active product took the name meanwhile', async () => {
      const p = await product('Name clash');
      await archive(users.manager, p.id);
      await product('Name clash');
      const res = await restore(users.manager, p.id);
      expect(res.status).toBe(409);
      expect((await row(p.id)).status).toBe('archived');
    });

    it('still lets an archived product be edited without a name check, then re-checks on restore', async () => {
      const p = await product('Edit archived');
      await archive(users.manager, p.id);
      expect((await edit(users.manager, p.id, { price: '3.00' })).status).toBe(200);
      expect((await restore(users.manager, p.id)).status).toBe(200);
    });
  });
});
