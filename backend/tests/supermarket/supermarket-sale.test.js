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
const { managerApproval, approvedPoster } = require('../helpers/approvals');
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


  // A void, a needs-review refund or a confirmed oversell needs a manager's PIN approval (src/modules/approvals),
  // fetched by the person at the till before the request, as the Supermarket screen does.
  const approvedPost = approvedPoster({ request: () => t.request, tokenFor, post: (userId, url) => as(userId).post(url), approver: () => users.manager });

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

  const sell = (userId, body) => {
    const sent = { outlet_id: market.outletId, method: 'cash', ...body };
    return body.confirm_oversell ? approvedPost(userId, '/api/v1/supermarket/sales', sent, 'supermarket.oversell') : as(userId).post('/api/v1/supermarket/sales').send(sent);
  };
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

  describe('the barcode list (Setup)', () => {
    it('lists every barcode at the property with its product, and says which products are on this till', async () => {
      const bar = await outlet('bar', `Bar ${next()}`);
      const [soup] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, name: 'Egusi Soup', category: `Kitchen ${next()}`, price: '50.00' });
      const junk = await barcode(soup, 'e');

      const res = await as(users.manager).get(`/api/v1/supermarket/barcodes?outlet_id=${market.outletId}`);
      expect(res.status).toBe(200);
      const byCode = Object.fromEntries(res.body.data.map((row) => [row.barcode, row]));
      expect(byCode['6001000000011']).toMatchObject({ item_name: 'Rice 5kg', on_till: true });
      expect(byCode['6001000000028']).toMatchObject({ item_name: 'Rice 5kg', on_till: true });
      expect(byCode.e).toMatchObject({ item_name: 'Egusi Soup', on_till: false }); // a restaurant item still shows, so it can be removed
      // Sorted by product name.
      const names = res.body.data.map((row) => row.item_name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

      // Without an outlet nothing is judged.
      const plain = await as(users.manager).get('/api/v1/supermarket/barcodes');
      expect(plain.body.data.find((row) => row.barcode === 'e').on_till).toBeNull();

      // Removed: gone from the list and from the till's lookup.
      const del = await as(users.manager).del(`/api/v1/supermarket/barcodes/${junk.id}`);
      expect(del.status).toBe(200);
      const after = await as(users.manager).get(`/api/v1/supermarket/barcodes?outlet_id=${market.outletId}`);
      expect(after.body.data.some((row) => row.barcode === 'e')).toBe(false);
    });

    it('needs the manager key, a supermarket outlet, and never shows another tenant\'s barcodes', async () => {
      expect((await as(users.operator).get('/api/v1/supermarket/barcodes')).status).toBe(403);
      const bar = await outlet('bar', `Bar ${next()}`);
      const notMart = await as(users.manager).get(`/api/v1/supermarket/barcodes?outlet_id=${bar}`);
      expect(notMart.status).toBeGreaterThanOrEqual(400);
      expect(notMart.status).toBeLessThan(500);

      const propertyB = ctx.b.properties[0].id;
      const [otherItem] = await insertMenuItem(t.trx, { tenant_id: ctx.b.id, property_id: propertyB, name: 'Other tenant item', category: `B ${next()}`, price: '1.00' });
      await t.trx('supermarket_barcodes').insert({ tenant_id: ctx.b.id, property_id: propertyB, menu_item_id: otherItem, barcode: '7770000000001' });
      const mine = await as(users.manager).get(`/api/v1/supermarket/barcodes?outlet_id=${market.outletId}`);
      expect(mine.body.data.some((row) => row.barcode === '7770000000001')).toBe(false);
      // Removing another tenant's barcode is not found.
      const theirs = await t.trx('supermarket_barcodes').where({ tenant_id: ctx.b.id, barcode: '7770000000001' }).first('id');
      expect((await as(users.manager).del(`/api/v1/supermarket/barcodes/${theirs.id}`)).status).toBe(404);
    });

    it('adds another barcode to a product that already has one', async () => {
      await barcode(soap, '6001000000099');
      const res = await as(users.manager).get(`/api/v1/supermarket/barcodes?menu_item_id=${soap}`);
      expect(res.body.data.map((row) => row.barcode).sort()).toEqual(['6001000000035', '6001000000099']);
      const lookup = await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${market.outletId}&barcode=6001000000099`);
      expect(lookup.body.data).toMatchObject({ name: 'Soap' });
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

      const voided = await approvedPost(users.manager, `/api/v1/supermarket/sales/${one.body.data.id}/void`, { reason: 'Customer changed mind' }, 'supermarket.void_sale', one.body.data.id);
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
    // Stock helpers: a product with a 1:1 (or `per`) recipe whose stock ARRIVES the way real stock does (a received movement).
    async function stockedProduct({ name, onHand, per = '1.000', code }) {
      const [menuId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, name, category: 'Groceries', price: '5.00' });
      const [stockId] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, name: `${name} stock`, unit: 'pack', purchase_cost: '3.00', current_quantity: onHand, reorder_level: '1.000' });
      if (onHand !== '0.000') {
        await t.trx('stock_movements').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, stock_item_id: stockId, type: 'received', quantity: onHand, unit_cost: '3.00', total_cost: '0.00', business_date: '2027-08-01', reference: `T-${next()}`, occurred_at: new Date() });
      }
      await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: menuId, stock_item_id: stockId, quantity: per });
      if (code) await barcode(menuId, code);
      return { menuId, stockId };
    }
    const levelOf = async (stockId) => (await t.trx('stock_levels').where({ stock_item_id: stockId, outlet_id: market.outletId }).first())?.current_quantity;

    it('refuses an oversell the cashier has not confirmed, listing the shortfall and writing nothing', async () => {
      const juice = await stockedProduct({ name: 'Juice', onHand: '3.000', code: '6001000000711' });
      const salesBefore = Number((await t.trx('supermarket_sales').where({ tenant_id: ctx.a.id }).count({ n: '*' }).first()).n);
      const ordersBefore = Number((await t.trx('pos_orders').where({ tenant_id: ctx.a.id }).count({ n: '*' }).first()).n);
      const res = await sell(users.operator, { items: [{ barcode: '6001000000711', quantity: 10 }] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_OVERSELL_NOT_CONFIRMED');
      expect(res.body.error.details.lines).toEqual([expect.objectContaining({ name: 'Juice stock', unit: 'pack', on_hand: '3.000', needed: '10.000', projected: '-7.000' })]);
      expect(Number((await t.trx('supermarket_sales').where({ tenant_id: ctx.a.id }).count({ n: '*' }).first()).n)).toBe(salesBefore);
      expect(Number((await t.trx('pos_orders').where({ tenant_id: ctx.a.id }).count({ n: '*' }).first()).n)).toBe(ordersBefore);
      expect(await levelOf(juice.stockId)).toBe('3.000');
    });

    it('a confirmed oversell takes stock to -7, recorded with the confirmed reason and the cashier, on the same idempotency key', async () => {
      const juice = await stockedProduct({ name: 'Juice B', onHand: '3.000', code: '6001000000728' });
      const key = `sm-${next()}`;
      const post = (body, approval = '') =>
        t.request
          .post('/api/v1/supermarket/sales')
          .set('Authorization', `Bearer ${tokenFor(users.operator)}`)
          .set('Idempotency-Key', key)
          .set('X-Manager-Approval', approval)
          .send({ outlet_id: market.outletId, method: 'cash', items: [{ barcode: '6001000000728', quantity: 10 }], ...body });
      expect((await post({})).status).toBe(422);
      const approval = await managerApproval(t.request, { token: tokenFor(users.operator), approverUserId: users.manager, action: 'supermarket.oversell' });
      const res = await post({ confirm_oversell: true }, approval); // the refusal stored nothing, so the same key carries the confirmed retry
      expect(res.status).toBe(201);
      expect(await levelOf(juice.stockId)).toBe('-7.000');
      const move = await t.trx('stock_movements').where({ stock_item_id: juice.stockId, type: 'sold' }).first();
      expect(move.quantity).toBe('-10.000');
      expect(move.reason).toMatch(/oversell confirmed at the till/i);
      const audit = await t.trx('audit_log').where({ entity_type: 'stock_items', entity_id: juice.stockId, action: 'stock_override_applied' }).first();
      expect(audit.reason).toMatch(/oversell confirmed at the till/i);
      expect(String(audit.user_id)).toBe(String(users.operator));
    });

    it('selling exactly the last units, or at zero stock with confirmation, follows the rule; untracked products are never refused', async () => {
      const last = await stockedProduct({ name: 'Last three', onHand: '3.000', code: '6001000000735' });
      const exact = await sell(users.operator, { items: [{ barcode: '6001000000735', quantity: 3 }] });
      expect(exact.status).toBe(201); // to exactly zero: no confirmation needed
      expect(await levelOf(last.stockId)).toBe('0.000');
      const exactMove = await t.trx('stock_movements').where({ stock_item_id: last.stockId, type: 'sold' }).first();
      expect(exactMove.reason).toContain('Supermarket sale at zero or low recorded stock');

      const milk = await stockedProduct({ name: 'Milk', onHand: '0.000', code: '6001000000742' });
      expect((await sell(users.operator, { items: [{ barcode: '6001000000742', quantity: 2 }] })).status).toBe(422);
      expect((await sell(users.operator, { items: [{ barcode: '6001000000742', quantity: 2 }], confirm_oversell: true })).status).toBe(201);
      expect(await levelOf(milk.stockId)).toBe('-2.000');

      // Soap has no recipe: not stock-tracked, nothing to oversell.
      expect((await sell(users.operator, { items: [{ barcode: '6001000000035', quantity: 50 }] })).status).toBe(201);
    });

    it('counts two products that share one stock item together', async () => {
      const shared = await stockedProduct({ name: 'Cola can', onHand: '3.000', code: '6001000000759' });
      const [pack] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, name: 'Cola single', category: 'Groceries', price: '5.00' });
      await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: pack, stock_item_id: shared.stockId, quantity: '1.000' });
      const res = await sell(users.operator, { items: [{ barcode: '6001000000759', quantity: 2 }, { menu_item_id: pack, quantity: 2 }] });
      expect(res.status).toBe(422); // 2 + 2 against 3
      expect(res.body.error.details.lines[0]).toMatchObject({ needed: '4.000', projected: '-1.000' });
    });

    it('never switches a supermarket item to Sold out for stock, releases an old stock lock, and still honours a manual Sold out', async () => {
      const bread = await stockedProduct({ name: 'Bread', onHand: '1.000', code: '6001000000766' });
      expect((await sell(users.operator, { items: [{ barcode: '6001000000766', quantity: 4 }], confirm_oversell: true })).status).toBe(201);
      const setting = await t.trx('pos_outlet_menu_items').where({ outlet_id: market.outletId, menu_item_id: bread.menuId }).first();
      expect(setting ? Boolean(setting.is_available) : true).toBe(true);
      const lookup = await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${market.outletId}&barcode=6001000000766`);
      expect(lookup.body.data.is_available).toBe(true);
      expect((await sell(users.operator, { items: [{ barcode: '6001000000766', quantity: 1 }], confirm_oversell: true })).status).toBe(201);

      // A row locked by the old stock mechanism (before this change) sells again at once.
      const eggs = await stockedProduct({ name: 'Eggs', onHand: '5.000', code: '6001000000773' });
      await t.trx('pos_outlet_menu_items').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, menu_item_id: eggs.menuId, is_available: false, stock_auto_unavailable: true });
      expect((await as(users.operator).get(`/api/v1/supermarket/lookup?outlet_id=${market.outletId}&barcode=6001000000773`)).body.data.is_available).toBe(true);
      expect((await sell(users.operator, { items: [{ barcode: '6001000000773', quantity: 1 }] })).status).toBe(201);
      const released = await t.trx('pos_outlet_menu_items').where({ outlet_id: market.outletId, menu_item_id: eggs.menuId }).first();
      expect(Boolean(released.is_available)).toBe(true); // the sale's stock step released it
      expect(Boolean(released.stock_auto_unavailable)).toBe(false);

      // A manual Sold out (staff action) still blocks.
      const tea = await stockedProduct({ name: 'Tea', onHand: '5.000', code: '6001000000780' });
      await t.trx('pos_outlet_menu_items').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: market.outletId, menu_item_id: tea.menuId, is_available: false, stock_auto_unavailable: false });
      const blocked = await sell(users.operator, { items: [{ barcode: '6001000000780', quantity: 1 }] });
      expect(blocked.status).toBe(400);
      expect(blocked.body.error.code).toBe('VALIDATION_POS_ITEM_UNAVAILABLE');
    });

    it('a bar still switches an item to Sold out when its stock runs out (unchanged)', async () => {
      const bar = await outlet('bar', `Bar ${next()}`);
      const [beer] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, name: 'Beer', category: `Drinks ${next()}`, price: '5.00' });
      const [beerStock] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, name: 'Beer stock', unit: 'bottle', purchase_cost: '3.00', current_quantity: '0.000', reorder_level: '1.000' });
      await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: beer, stock_item_id: beerStock, quantity: '1.000' });
      const { scopedDb } = require('../../src/db');
      const { workerContext } = require('../../src/modules/tenancy');
      const stockService = require('../../src/modules/stock/service');
      const db = scopedDb().for(workerContext({ tenantId: ctx.a.id, propertyId }));
      await stockService.applyStockAvailabilityEffects({ trx: db, stockItemIds: [beerStock], outletId: bar });
      const setting = await t.trx('pos_outlet_menu_items').where({ outlet_id: bar, menu_item_id: beer }).first();
      expect(Boolean(setting.is_available)).toBe(false);
      expect(Boolean(setting.stock_auto_unavailable)).toBe(true);
    });

    it('GET /supermarket/stock gives whole units on hand per product (null when not stock-tracked)', async () => {
      const rice2 = await stockedProduct({ name: 'Rice pair', onHand: '5.000', per: '2.000' });
      const flat = await stockedProduct({ name: 'Flat', onHand: '0.000' });
      const res = await as(users.operator).get(`/api/v1/supermarket/stock?outlet_id=${market.outletId}`);
      expect(res.status).toBe(200);
      expect(res.body.data[String(rice2.menuId)]).toBe(2); // 5 ÷ 2 per unit, whole units
      expect(res.body.data[String(flat.menuId)]).toBe(0);
      expect(res.body.data[String(soap)]).toBeNull(); // no recipe
      expect((await as(users.viewer).get(`/api/v1/supermarket/stock?outlet_id=${market.outletId}`)).status).toBe(403);
      const bar = await outlet('bar', `Bar ${next()}`);
      expect((await as(users.operator).get(`/api/v1/supermarket/stock?outlet_id=${bar}`)).status).toBe(422);
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

  describe('supermarket stock only rises by the opening-stock import or a store-approved request/transfer', () => {
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

    it('receive: a manager can no longer receive directly at a supermarket (same as a bar); the store can', async () => {
      const item = await stockItem();
      const refused = await receive(market.outletId, item);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('BUSINESS_RULE_RECEIVE_AT_STORE_ONLY');
      expect(refused.body.error.message).toContain('Main Store');
      const bar = await outlet('bar', 'Rule Bar');
      expect((await receive(bar, item)).status).toBe(422);
      const store = await t.trx('pos_outlets').where({ property_id: propertyId, type: 'store' }).first('id');
      expect((await receive(store.id, item)).status).toBe(201);
    });

    it('stock take: a count above the system quantity is refused at a supermarket too, and a count that matches is fine', async () => {
      const item = await stockItem();
      const count = async (outletId, quantity) => {
        const open = await t.request.post('/api/v1/pos/stock/takes').set(auth()).send({ outlet_id: outletId });
        const takeId = open.body.data.id;
        await t.request.patch(`/api/v1/pos/stock/takes/${takeId}/lines/${item}`).set(auth()).send({ counted_quantity: quantity });
        return t.request.post(`/api/v1/pos/stock/takes/${takeId}/complete`).set(auth()).set('Idempotency-Key', `tk-${next()}`).send({});
      };
      const refused = await count(market.outletId, '5.000');
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('BUSINESS_RULE_STOCK_TAKE_CANNOT_RAISE_STOCK');
      expect((await count(market.outletId, '0.000')).status).toBe(200);
      const bar = await outlet('bar', 'Count Bar');
      expect((await count(bar, '5.000')).status).toBe(422);
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
      expect((await approvedPost(users.manager, `/api/v1/supermarket/sales/${sale.body.data.id}/void`, {}, 'supermarket.void_sale', sale.body.data.id)).status).toBe(400);
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
