'use strict';

/**
 * Supermarket Stage 2: setup flags (no barcode / not stock-tracked), the till's
 * low-stock list, a cashier's own-sales-today reprint list, and the void path
 * proven end to end (a voided sale leaves /pos/reports/sales and restores stock).
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');

describe('supermarket stage 2', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let counter = 0;
  let outletId;
  let users;
  const DATE = '2027-10-10';

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId, tenant = ctx.a, property = propertyId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(property) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `s2-${next()}`),
  });
  const sell = (userId, body, outlet = outletId) => as(userId).post('/api/v1/supermarket/sales').send({ outlet_id: outlet, method: 'cash', ...body });
  const flags = (userId, outlet = outletId) => as(userId).get(`/api/v1/supermarket/setup-flags?outlet_id=${outlet}`);

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }
  async function newUser() {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `idle-${next()}@example.com`, first_name: 'Idle', last_name: 'User', password_hash: 'x', status: 'active' });
    await setRole(id, 'housekeeping');
    return id;
  }
  async function newOutlet(type, name) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `T${next()}`.slice(0, 30), name, type });
    return id;
  }
  async function item(name, { barcode, stock } = {}) {
    const [id] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name, category: 'Stage2', price: '10.00' });
    if (barcode) await t.trx('supermarket_barcodes').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: id, barcode });
    let stockId = null;
    if (stock !== undefined) {
      [stockId] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `${name} stock`, unit: 'pack', purchase_cost: '3.00', current_quantity: stock.qty, reorder_level: stock.reorder });
      await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: id, stock_item_id: stockId, quantity: '1.000' });
      // A real opening movement, so the ledger (not just the level row) holds the quantity.
      if (Number(stock.qty) > 0) {
        const received = await as(users.manager).post('/api/v1/pos/stock/goods-received').send({ outlet_id: outletId, lines: [{ stock_item_id: stockId, quantity: stock.qty, unit_cost: '3.00' }] });
        expect(received.status).toBe(201);
      }
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
    outletId = await newOutlet('supermarket', 'Stage2 Mart');
  });

  describe('setup flags', () => {
    it('flags a product with no barcode and one with no recipe, and lists neither once both are set', async () => {
      const bare = await item('Bare item');
      const scanned = await item('Scanned only', { barcode: `B${next()}` });
      const tracked = await item('Tracked only', { stock: { qty: '10.000', reorder: '1.000' } });
      const complete = await item('Complete', { barcode: `B${next()}`, stock: { qty: '10.000', reorder: '1.000' } });

      const res = await flags(users.manager);
      expect(res.status).toBe(200);
      const byId = new Map(res.body.data.items.map((row) => [String(row.id), row]));
      expect(byId.get(String(bare.id))).toMatchObject({ missing_barcode: true, not_stock_tracked: true });
      expect(byId.get(String(scanned.id))).toMatchObject({ missing_barcode: false, not_stock_tracked: true });
      expect(byId.get(String(tracked.id))).toMatchObject({ missing_barcode: true, not_stock_tracked: false });
      expect(byId.has(String(complete.id))).toBe(false);
      expect(res.body.data.counts.missing_barcode).toBe(res.body.data.items.filter((i) => i.missing_barcode).length);

      // Setting the barcode through the existing route clears that flag.
      const added = await as(users.manager).post('/api/v1/supermarket/barcodes').send({ menu_item_id: bare.id, barcode: `B${next()}` });
      expect(added.status).toBe(201);
      const after = await flags(users.manager);
      expect(after.body.data.items.find((i) => String(i.id) === String(bare.id))).toMatchObject({ missing_barcode: false, not_stock_tracked: true });
    });

    it('needs the manager key and a supermarket outlet the caller covers', async () => {
      expect((await flags(users.operator)).status).toBe(403);
      const bar = await newOutlet('bar', 'Flag Bar');
      expect((await flags(users.manager, bar)).status).toBe(422);
      expect((await t.request.get('/api/v1/supermarket/setup-flags').set('Authorization', `Bearer ${tokenFor(users.manager)}`)).status).toBe(400);
    });

    it("does not show another tenant's products", async () => {
      const token = tokenFor(ctx.b.users[0].id, ctx.b, ctx.b.properties[0].id);
      const res = await t.request.get(`/api/v1/supermarket/setup-flags?outlet_id=${outletId}`).set('Authorization', `Bearer ${token}`);
      expect([400, 403, 404]).toContain(res.status);
    });
  });

  describe('low stock', () => {
    it('lists stock at or below its reorder level (zero included), lowest first, with no cost, to every till role', async () => {
      const low = await item('Low item', { stock: { qty: '1.000', reorder: '3.000' } });
      const zero = await item('Zero item', { stock: { qty: '0.000', reorder: '2.000' } });
      const fine = await item('Fine item', { stock: { qty: '50.000', reorder: '3.000' } });
      const res = await as(users.operator).get(`/api/v1/supermarket/low-stock?outlet_id=${outletId}`);
      expect(res.status).toBe(200);
      const names = res.body.data.items.map((row) => row.name);
      expect(names.indexOf('Zero item stock')).toBeLessThan(names.indexOf('Low item stock'));
      expect(names).not.toContain('Fine item stock');
      expect(res.body.data.total).toBe(res.body.data.items.length);
      expect(res.body.data.items[0]).not.toHaveProperty('purchase_cost');
      expect([low, zero, fine].every((i) => i.stockId)).toBe(true);
      expect((await as(users.manager).get(`/api/v1/supermarket/low-stock?outlet_id=${outletId}`)).status).toBe(200);
    });

    it('is refused for a role with no supermarket key and for a non-supermarket outlet', async () => {
      const idle = await newUser();
      expect((await as(idle).get(`/api/v1/supermarket/low-stock?outlet_id=${outletId}`)).status).toBe(403);
      const bar = await newOutlet('bar', 'Low Bar');
      expect((await as(users.operator).get(`/api/v1/supermarket/low-stock?outlet_id=${bar}`)).status).toBe(422);
      // Outlet assignment applies: an operator assigned to another outlet gets no list for this one.
      await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: users.operator, outlet_id: bar });
      const refused = await as(users.operator).get(`/api/v1/supermarket/low-stock?outlet_id=${outletId}`);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_OUTLET_NOT_ASSIGNED');
      expect((await as(users.operator).get(`/api/v1/supermarket/my-sales?outlet_id=${outletId}`)).status).toBe(400);
      await t.trx('user_outlet_assignments').where({ user_id: users.operator }).del();
    });
  });

  describe('reprint list: my sales today', () => {
    it("lists only the caller's own sales on the current business date, newest first, with receipt codes", async () => {
      const own = await item('Own item', { barcode: `B${next()}`, stock: { qty: '20.000', reorder: '1.000' } });
      const first = await sell(users.operator, { items: [{ menu_item_id: own.id }] });
      const second = await sell(users.operator, { items: [{ menu_item_id: own.id }] });
      const theirs = await sell(users.manager, { items: [{ menu_item_id: own.id }] });
      expect([first, second, theirs].map((r) => r.status)).toEqual([201, 201, 201]);

      const res = await as(users.operator).get(`/api/v1/supermarket/my-sales?outlet_id=${outletId}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((row) => String(row.id));
      expect(ids).toContain(String(first.body.data.id));
      expect(ids).toContain(String(second.body.data.id));
      expect(ids).not.toContain(String(theirs.body.data.id));
      expect(ids.indexOf(String(second.body.data.id))).toBeLessThan(ids.indexOf(String(first.body.data.id)));
      expect(res.body.data[0].receipt_code).toBe(second.body.data.receipt_code);

      // A sale on an earlier business date drops out of "today".
      await t.trx('pos_order_settlements').where({ id: first.body.data.settlement_id }).update({ business_date: '2027-10-09' });
      const after = await as(users.operator).get(`/api/v1/supermarket/my-sales?outlet_id=${outletId}`);
      expect(after.body.data.map((row) => String(row.id))).not.toContain(String(first.body.data.id));

      // The receipt is still fetchable for a reprint by its seller.
      expect((await as(users.operator).get(`/api/v1/supermarket/sales/${second.body.data.id}`)).status).toBe(200);
    });

    it('needs the sales key', async () => {
      const idle = await newUser();
      expect((await as(idle).get(`/api/v1/supermarket/my-sales?outlet_id=${outletId}`)).status).toBe(403);
      // A report-only user (no sales key) cannot use the cashier's reprint list either.
      const [role] = await t.trx('roles').where({ tenant_id: ctx.a.id, code: 'storekeeper' }).select('id');
      const perm = await t.trx('permissions').where({ permission_key: 'supermarket.report' }).first('id');
      await t.trx('role_permissions').insert({ tenant_id: ctx.a.id, role_id: role.id, permission_id: perm.id });
      await t.trx('user_property_access').where({ user_id: idle }).update({ role: 'storekeeper' });
      expect((await as(idle).get(`/api/v1/supermarket/my-sales?outlet_id=${outletId}`)).status).toBe(403);
    });
  });

  describe('voiding a sale', () => {
    it('drops it from the POS Sales report and restores the stock it consumed', async () => {
      const goods = await item('Void goods', { barcode: `B${next()}`, stock: { qty: '10.000', reorder: '1.000' } });
      const level = async () => (await t.trx('stock_levels').where({ stock_item_id: goods.stockId, outlet_id: outletId }).first()).current_quantity;
      const report = async () => (await as(users.manager).get(`/api/v1/pos/reports/sales?date_from=${DATE}&date_to=${DATE}&outlet_id=${outletId}`)).body.data;

      const baseline = await report();
      const sale = await sell(users.operator, { items: [{ menu_item_id: goods.id, quantity: 3 }] });
      expect(sale.status).toBe(201);
      expect(await level()).toBe('7.000');
      const during = await report();
      expect(during.summary.subtotal).not.toBe(baseline.summary.subtotal);
      expect(during.topItems.find((row) => row.name === 'Void goods')).toMatchObject({ quantity: 3 });

      const voided = await as(users.manager).post(`/api/v1/supermarket/sales/${sale.body.data.id}/void`).send({ reason: 'Customer returned the goods' });
      expect(voided.status).toBe(200);
      expect(voided.body.data.voided_at).toBeTruthy();

      expect(await level()).toBe('10.000');
      const after = await report();
      expect(after.summary.subtotal).toBe(baseline.summary.subtotal);
      expect(after.topItems.find((row) => row.name === 'Void goods')).toBeUndefined();
      const reversal = await t.trx('stock_movements').where({ stock_item_id: goods.stockId, outlet_id: outletId, type: 'sale_reversal' }).first();
      expect(reversal).toBeTruthy();
      // The settlement carries the void; the tab itself stays 'settled' (the same shape as a hotel POS void).
      const settlement = await t.trx('pos_order_settlements').where({ id: sale.body.data.settlement_id }).first();
      expect(settlement.voided_at).toBeTruthy();
      // A second void is refused and does not restore stock twice.
      expect((await as(users.manager).post(`/api/v1/supermarket/sales/${sale.body.data.id}/void`).send({ reason: 'again' })).status).toBe(409);
      expect(await level()).toBe('10.000');
    });
  });
});
