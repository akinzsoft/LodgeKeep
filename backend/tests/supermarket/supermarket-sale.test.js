'use strict';

/**
 * Supermarket quick sale, Stage 1: barcode lookup, a sale that is an ordinary
 * POS tab settled by `settleOrder`, its own VAT row (hotel 'all' rows never
 * apply), gapless receipt numbers, zero-stock sales, the supermarket-only stock
 * exemptions, the three permissions and outlet assignment.
 *
 * Ambient tax: fixtures seed a 7.5% EXCLUSIVE `applies_to: 'all'` VAT row on
 * ctx.a's property. A supermarket sale must ignore it.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');

describe('supermarket quick sale', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let counter = 0;
  let market; // { outletId, terminalId }
  let users; // { manager, operator, viewer }
  let rice; // inclusive-priced 107.50 item (menu id)
  let soap; // 10.00 item

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `sm-${next()}`),
    del: (url) => t.request.delete(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
  });

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  async function outlet(type, name) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `S${next()}`.slice(0, 30), name, type });
    return id;
  }

  async function barcode(menuItemId, code) {
    const res = await as(users.manager).post('/api/v1/supermarket/barcodes').send({ menu_item_id: menuItemId, barcode: code });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  const sell = (userId, body) => as(userId).post('/api/v1/supermarket/sales').send({ outlet_id: market.outletId, method: 'cash', ...body });
  const vatRows = () => t.trx('taxes').where({ tenant_id: ctx.a.id, property_id: propertyId });

  async function addSupermarketVat({ inclusive }) {
    await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'SM_VAT' }).del();
    await t.trx('taxes').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      tax_code: 'SM_VAT',
      name: 'Supermarket VAT',
      rate: '7.5000',
      effective_from: '2026-01-01',
      is_inclusive: inclusive,
      calculation_method: 'percentage',
      applies_to: 'supermarket_sale',
    });
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-08-01' });
    const [viewerId] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `viewer-${next()}@example.com`, first_name: 'View', last_name: 'Only', password_hash: 'x', status: 'active' });
    users = { manager: ctx.a.users[0].id, operator: ctx.a.users[1].id, viewer: viewerId };
    await setRole(users.manager, 'manager');
    await setRole(users.operator, 'pos_operator');
    market = { outletId: await outlet('supermarket', 'Mini Mart') };
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, device_ref: `SM-${next()}` });
    market.terminalId = terminalId;
    [rice] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, name: 'Rice 5kg', category: 'Groceries', price: '107.50' });
    [soap] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, name: 'Soap', category: 'Groceries', price: '10.00' });
    await barcode(rice, '6001000000011');
    await barcode(rice, '6001000000028'); // several per item
    await barcode(soap, '6001000000035');
  });

  describe('barcodes and lookup', () => {
    it('finds a product by any of its barcodes, and several barcodes map to one item', async () => {
      const a = await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${market.outletId}&barcode=6001000000011`);
      const b = await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${market.outletId}&barcode=6001000000028`);
      expect(a.status).toBe(200);
      expect(a.body.data).toMatchObject({ name: 'Rice 5kg', price: '107.50' });
      expect(String(b.body.data.id)).toBe(String(a.body.data.id));
    });

    it('answers an unknown barcode with a clear 404 and searches by name', async () => {
      const miss = await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${market.outletId}&barcode=000`);
      expect(miss.status).toBe(404);
      expect(miss.body.error.code).toBe('VALIDATION_BARCODE_NOT_FOUND');
      const search = await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${market.outletId}&q=soa`);
      expect(search.body.data.map((i) => i.name)).toEqual(['Soap']);
    });

    it('refuses a duplicate barcode, and barcode setup needs the manager key', async () => {
      const dup = await as(users.manager).post('/api/v1/supermarket/barcodes').send({ menu_item_id: soap, barcode: '6001000000011' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('CONFLICT_BARCODE_ALREADY_USED');
      const denied = await as(users.operator).post('/api/v1/supermarket/barcodes').send({ menu_item_id: soap, barcode: '999' });
      expect(denied.status).toBe(403);
    });
  });

  describe('tax: its own row, hotel rows never apply', () => {
    it('with only the hotel "all" VAT row a supermarket sale is NOT taxed', async () => {
      await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'SM_VAT' }).del();
      const res = await sell(users.operator, { items: [{ barcode: '6001000000035', quantity: 2 }] });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ subtotal: '20.00', tax_amount: '0.00', total: '20.00' });
    });

    it('applies the supermarket VAT row (exclusive) and only that row', async () => {
      await addSupermarketVat({ inclusive: false });
      const res = await sell(users.operator, { items: [{ barcode: '6001000000035', quantity: 2 }] });
      expect(res.body.data).toMatchObject({ subtotal: '20.00', tax_amount: '1.50', total: '21.50' });
      expect(res.body.data.lines[0]).toMatchObject({ line_total: '20.00', line_net: '20.00', line_tax: '1.50' });
    });

    it('scales an INCLUSIVE row onto each receipt line so lines add up to the settlement', async () => {
      await addSupermarketVat({ inclusive: true });
      const res = await sell(users.operator, { items: [{ barcode: '6001000000011', quantity: 1 }, { barcode: '6001000000035', quantity: 3 }] });
      expect(res.status).toBe(201);
      const sale = res.body.data;
      // 107.50 + 30.00 = 137.50 gross; 7.5% inclusive = 9.58 tax (stored by the engine), net 127.92.
      expect(sale.total).toBe('137.50');
      const sum = (key) => sale.lines.reduce((acc, line) => acc + Math.round(Number(line[key]) * 100), 0) / 100;
      expect(sum('line_net').toFixed(2)).toBe(sale.subtotal);
      expect(sum('line_tax').toFixed(2)).toBe(sale.tax_amount);
      for (const line of sale.lines) expect((Number(line.line_net) + Number(line.line_tax)).toFixed(2)).toBe(Number(line.line_total).toFixed(2));
    });

    it('leaves a hotel bar sale taxed exactly as before: the hotel row applies, the supermarket row does not', async () => {
      await addSupermarketVat({ inclusive: false });
      const bar = await outlet('bar', 'Hotel Bar');
      const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, device_ref: `HB-${next()}` });
      const [beer] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, name: 'Hotel Beer', category: 'Bar drinks', price: '20.00' });
      const opened = await as(users.operator).post('/api/v1/pos/orders').send({ outlet_id: bar, terminal_id: terminalId, table_label: 'B1' });
      await as(users.operator).post(`/api/v1/pos/orders/${opened.body.data.id}/items`).send({ menu_item_id: beer, quantity: 1 });
      const settled = await as(users.operator).post(`/api/v1/pos/orders/${opened.body.data.id}/settle`).send({ settlements: [{ method: 'cash' }] });
      expect(settled.status).toBe(200);
      // 7.5% on 20.00 from the hotel's 'all' VAT row only: 1.50 (the supermarket row would have doubled it to 3.00).
      expect(settled.body.data.settlements[0]).toMatchObject({ subtotal: '20.00', tax_amount: '1.50' });
    });
  });

  describe('the receipt', () => {
    it('numbers receipts without gaps per outlet and a void keeps its number', async () => {
      await addSupermarketVat({ inclusive: false });
      const other = await outlet('supermarket', 'Second Mart');
      const one = await sell(users.operator, { items: [{ barcode: '6001000000035' }] });
      const two = await sell(users.operator, { items: [{ barcode: '6001000000035' }] });
      expect(Number(two.body.data.receipt_number)).toBe(Number(one.body.data.receipt_number) + 1);

      const voided = await as(users.manager).post(`/api/v1/supermarket/sales/${one.body.data.id}/void`).send({ reason: 'Customer changed mind' });
      expect(voided.status).toBe(200);
      expect(voided.body.data.voided_at).not.toBeNull();
      const three = await sell(users.operator, { items: [{ barcode: '6001000000035' }] });
      expect(Number(three.body.data.receipt_number)).toBe(Number(two.body.data.receipt_number) + 1);
      expect(one.body.data.receipt_code).toMatch(/-\d{6}$/);

      // A different outlet has its own counter. (It sells nothing here, so only the counter row is checked.)
      expect(await t.trx('supermarket_receipt_sequences').where({ outlet_id: other }).first()).toBeUndefined();
    });

    it('is readable by the seller and does not change when the product is renamed or repriced', async () => {
      const sale = await sell(users.operator, { items: [{ barcode: '6001000000035', quantity: 2 }] });
      await t.trx('pos_menu_items').where({ id: soap }).update({ name: 'Soap RENAMED', price: '99.00' });
      const read = await as(users.operator).get(`/api/v1/supermarket/sales/${sale.body.data.id}`);
      expect(read.status).toBe(200);
      expect(read.body.data.lines[0]).toMatchObject({ item_name: 'Soap', unit_price: '10.00' });
      await t.trx('pos_menu_items').where({ id: soap }).update({ name: 'Soap', price: '10.00' });
    });

    it('refuses a bad barcode or quantity before writing anything', async () => {
      const ordersBefore = await t.trx('pos_orders').where({ outlet_id: market.outletId }).count({ n: '*' }).first();
      const salesBefore = await t.trx('supermarket_sales').count({ n: '*' }).first();
      expect((await sell(users.operator, { items: [{ barcode: 'nope' }] })).status).toBe(404);
      expect((await sell(users.operator, { items: [{ barcode: '6001000000035', quantity: 0 }] })).status).toBe(400);
      expect((await sell(users.operator, { items: [] })).status).toBe(400);
      expect((await sell(users.operator, { items: [{ barcode: '6001000000035' }], method: 'card' })).status).toBe(400);
      expect(await t.trx('pos_orders').where({ outlet_id: market.outletId }).count({ n: '*' }).first()).toEqual(ordersBefore);
      expect(await t.trx('supermarket_sales').count({ n: '*' }).first()).toEqual(salesBefore);
    });

    it('is only for supermarket outlets', async () => {
      const bar = await outlet('bar', 'Not a market');
      const res = await as(users.operator).post('/api/v1/supermarket/sales').send({ outlet_id: bar, method: 'cash', items: [{ menu_item_id: soap }] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_NOT_A_SUPERMARKET_OUTLET');
    });
  });

  describe('stock', () => {
    it('sells at zero recorded stock with an automatic reason, and the stock goes negative-or-zero without blocking', async () => {
      const [milk] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, name: 'Milk', category: 'Groceries', price: '5.00' });
      const [milkStock] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, name: 'Milk stock', unit: 'pack', purchase_cost: '3.00', current_quantity: '0.000', reorder_level: '2.000' });
      await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: milk, stock_item_id: milkStock, quantity: '1.000' });
      await barcode(milk, '6001000000042');

      const res = await sell(users.operator, { items: [{ barcode: '6001000000042', quantity: 2 }] });
      expect(res.status).toBe(201);
      const audit = await t.trx('audit_log').where({ entity_type: 'stock_items', entity_id: milkStock, action: 'stock_override_applied' }).first();
      expect(audit.reason).toContain('Supermarket sale');
      const level = await t.trx('stock_levels').where({ stock_item_id: milkStock, outlet_id: market.outletId }).first();
      expect(level.current_quantity).toBe('-2.000');
    });

    it('does not ring a bell alert per sale (a hotel bar sale still does)', async () => {
      const settledCount = async () => (await t.trx('in_app_notifications').where({ tenant_id: ctx.a.id, type: 'pos.order_settled' }).count({ n: '*' }).first()).n;
      const before = Number(await settledCount());
      expect((await sell(users.operator, { items: [{ barcode: '6001000000035' }] })).status).toBe(201);
      expect(Number(await settledCount())).toBe(before);

      const bar = await outlet('bar', 'Bell Bar');
      const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, device_ref: `BB-${next()}` });
      const [beer] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, name: 'Bell Beer', category: 'Bell drinks', price: '20.00' });
      const opened = await as(users.operator).post('/api/v1/pos/orders').send({ outlet_id: bar, terminal_id: terminalId, table_label: 'BB1' });
      await as(users.operator).post(`/api/v1/pos/orders/${opened.body.data.id}/items`).send({ menu_item_id: beer, quantity: 1 });
      expect((await as(users.operator).post(`/api/v1/pos/orders/${opened.body.data.id}/settle`).send({ settlements: [{ method: 'cash' }] })).status).toBe(200);
      expect(Number(await settledCount())).toBeGreaterThan(before);
    });
  });

  describe('supermarket-only stock exemptions (bars and restaurants unchanged)', () => {
    const auth = () => ({ Authorization: `Bearer ${tokenFor(users.manager)}` });

    async function stockItem() {
      const [id] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: `Item ${next()}`, unit: 'pack', purchase_cost: '2.00', reorder_level: '0.000' });
      return id;
    }
    const receive = (outletId, stockItemId) =>
      t.request.post('/api/v1/pos/stock/goods-received').set(auth()).set('Idempotency-Key', `rcv-${next()}`).send({ outlet_id: outletId, lines: [{ stock_item_id: stockItemId, quantity: '10.000', unit_cost: '2.00' }] });

    beforeAll(async () => {
      await outlet('store', 'Main Store'); // makes both rules bite
    });

    it('receive: allowed at a supermarket, still refused at a bar', async () => {
      const item = await stockItem();
      expect((await receive(market.outletId, item)).status).toBe(201);
      const bar = await outlet('bar', 'Rule Bar');
      const refused = await receive(bar, item);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('BUSINESS_RULE_RECEIVE_AT_STORE_ONLY');
    });

    it('stock take: a count above the system quantity is allowed at a supermarket, still refused at a bar', async () => {
      const item = await stockItem();
      const countAbove = async (outletId) => {
        const open = await t.request.post('/api/v1/pos/stock/takes').set(auth()).send({ outlet_id: outletId });
        const takeId = open.body.data.id;
        await t.request.patch(`/api/v1/pos/stock/takes/${takeId}/lines/${item}`).set(auth()).send({ counted_quantity: '5.000' });
        return t.request.post(`/api/v1/pos/stock/takes/${takeId}/complete`).set(auth()).set('Idempotency-Key', `tk-${next()}`).send({});
      };
      expect((await countAbove(market.outletId)).status).toBe(200);
      const bar = await outlet('bar', 'Count Bar');
      const refused = await countAbove(bar);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('BUSINESS_RULE_STOCK_TAKE_CANNOT_RAISE_STOCK');
    });
  });

  describe('POS Sales report', () => {
    const REPORT_DATE = '2027-09-15';
    const report = (outletId) => as(users.manager).get(`/api/v1/pos/reports/sales?date_from=${REPORT_DATE}&date_to=${REPORT_DATE}&outlet_id=${outletId}`);

    beforeAll(async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: REPORT_DATE });
    });

    it('supermarket item rows are scaled to the net so they add up to the summary (inclusive VAT)', async () => {
      await addSupermarketVat({ inclusive: true });
      const first = await sell(users.operator, { items: [{ barcode: '6001000000011' }, { barcode: '6001000000035', quantity: 3 }] });
      expect(first.status).toBe(201);
      const res = await report(market.outletId);
      expect(res.status).toBe(200);
      const { summary, topItems } = res.body.data;
      const itemsNet = topItems.reduce((acc, row) => acc + Math.round(Number(row.sales) * 100), 0) / 100;
      expect(itemsNet.toFixed(2)).toBe(summary.subtotal);
      // The gross price (107.50 + 30.00) is NOT what the item rows show.
      expect(itemsNet).toBeLessThan(137.5);
    });

    it('a hotel outlet keeps its item amounts exactly as priced (not scaled), even with an inclusive hotel VAT row', async () => {
      await addSupermarketVat({ inclusive: false });
      await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'VAT' }).update({ is_inclusive: true });
      const bar = await outlet('bar', 'Report Bar');
      const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, device_ref: `RB-${next()}` });
      const [wine] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, name: 'Report Wine', category: 'Report drinks', price: '40.00' });
      const opened = await as(users.operator).post('/api/v1/pos/orders').send({ outlet_id: bar, terminal_id: terminalId, table_label: 'RW1' });
      await as(users.operator).post(`/api/v1/pos/orders/${opened.body.data.id}/items`).send({ menu_item_id: wine, quantity: 1 });
      await as(users.operator).post(`/api/v1/pos/orders/${opened.body.data.id}/settle`).send({ settlements: [{ method: 'cash' }] });
      const res = await report(bar);
      await t.trx('taxes').where({ tenant_id: ctx.a.id, tax_code: 'VAT' }).update({ is_inclusive: false });
      // Inclusive hotel VAT makes the settlement net (37.21) differ from the price; the item row stays the price, as before.
      expect(res.body.data.summary.subtotal).not.toBe('40.00');
      expect(res.body.data.topItems).toEqual([expect.objectContaining({ name: 'Report Wine', quantity: 1, sales: '40.00' })]);
    });
  });

  describe('permissions and outlet assignment', () => {
    it('report-without-sales can read reports but cannot sell, and a seller without report cannot read them', async () => {
      const viewer = users.viewer;
      // A report-only user: the storekeeper role plus supermarket.report (and no supermarket.sales).
      const [roleRow] = await t.trx('roles').where({ tenant_id: ctx.a.id, code: 'storekeeper' }).select('id');
      const perm = await t.trx('permissions').where({ permission_key: 'supermarket.report' }).first('id');
      await t.trx('role_permissions').insert({ tenant_id: ctx.a.id, role_id: roleRow.id, permission_id: perm.id });
      await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: viewer, role: 'storekeeper' });

      expect((await as(viewer).get(`/api/v1/supermarket/report?outlet_id=${market.outletId}`)).status).toBe(200);
      const denied = await sell(viewer, { items: [{ barcode: '6001000000035' }] });
      expect(denied.status).toBe(403);

      expect((await as(users.operator).get(`/api/v1/supermarket/report?outlet_id=${market.outletId}`)).status).toBe(403);
    });

    it('a user assigned to another outlet cannot sell here, and my-outlets lists only the assigned supermarket outlets', async () => {
      const elsewhere = await outlet('bar', 'Assigned Bar');
      await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: users.operator, outlet_id: elsewhere });
      const refused = await sell(users.operator, { items: [{ barcode: '6001000000035' }] });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_OUTLET_NOT_ASSIGNED');
      expect((await as(users.operator).get('/api/v1/supermarket/my-outlets')).body.data).toHaveLength(0);

      await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: users.operator, outlet_id: market.outletId });
      expect((await sell(users.operator, { items: [{ barcode: '6001000000035' }] })).status).toBe(201);
      expect((await as(users.operator).get('/api/v1/supermarket/my-outlets')).body.data.map((o) => String(o.id))).toEqual([String(market.outletId)]);
      await t.trx('user_outlet_assignments').where({ user_id: users.operator }).del();
    });

    it('voiding a sale needs the manager key and a reason', async () => {
      const sale = await sell(users.operator, { items: [{ barcode: '6001000000035' }] });
      expect((await as(users.operator).post(`/api/v1/supermarket/sales/${sale.body.data.id}/void`).send({ reason: 'x' })).status).toBe(403);
      expect((await as(users.manager).post(`/api/v1/supermarket/sales/${sale.body.data.id}/void`).send({})).status).toBe(400);
    });
  });

  describe('isolation', () => {
    it("another tenant cannot read this tenant's receipt", async () => {
      const sale = await sell(users.operator, { items: [{ barcode: '6001000000035' }] });
      const token = signAccessToken({ aud: 'staff', sub: String(ctx.b.users[0].id), tenant_id: String(ctx.b.id), property_id: String(ctx.b.properties[0].id) });
      const res = await t.request.get(`/api/v1/supermarket/sales/${sale.body.data.id}`).set('Authorization', `Bearer ${token}`);
      expect([403, 404]).toContain(res.status);
    });
  });
});
