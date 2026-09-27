'use strict';

/**
 * Stock transfer between outlets, and the "store" outlet type.
 *
 * A transfer is two `type: 'transfer'` ledger rows — minus at the source,
 * plus at the destination — written in one transaction at the item's cost.
 * It must never take the source below zero, never show as wastage or a
 * delivery in the reports, and never change what the property owns in
 * total. A store outlet holds and issues stock but is never a point of
 * sale. The real-concurrency proofs live in stock-transfer-concurrency.test.js;
 * these run inside the shared rolled-back transaction.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertStockItem, outletMenuItem } = require('../helpers/catalogue');
const reporting = require('../../src/modules/stock/reporting');
const { contextFromSession } = require('../../src/modules/tenancy');

const BUSINESS_DATE = '2027-06-01';

describe('Stock transfer between outlets', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let barId;
  let storeId;
  let counter = 0;

  function next() {
    counter += 1;
    return `${Date.now().toString(36)}${counter}`;
  }

  function tokenFor({ tenant = ctx.a, userIndex = 0 } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[userIndex].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[0].id),
    });
  }
  const managerToken = () => tokenFor({ userIndex: 0 });
  /** User 1 at property 0, re-roled per test. */
  async function staffToken(role) {
    await t.trx('user_property_access').where({ user_id: ctx.a.users[1].id, property_id: ctx.a.properties[0].id }).update({ role });
    return tokenFor({ userIndex: 1 });
  }

  async function newOutlet({ type = 'bar', tenant = ctx.a } = {}) {
    const [id] = await t.trx('pos_outlets').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      code: `T${next()}`.slice(0, 30),
      name: `${type === 'store' ? 'Store' : 'Outlet'} ${counter}`,
      type,
    });
    return id;
  }

  async function newStockItem({ tenant = ctx.a, purchaseCost = '4.00', name } = {}) {
    const [id] = await insertStockItem(t.trx, {
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      name: name ?? `Lager ${next()}`,
      unit: 'bottle',
      purchase_cost: purchaseCost,
      reorder_level: '0.000',
    });
    return id;
  }

  async function receive(outletId, stockItemId, quantity, unitCost = '4.00') {
    const res = await t.request
      .post('/api/v1/pos/stock/goods-received')
      .set('Authorization', `Bearer ${managerToken()}`)
      .set('Idempotency-Key', `rcv-${next()}`)
      .send({ outlet_id: outletId, lines: [{ stock_item_id: stockItemId, quantity, unit_cost: unitCost }] });
    expect(res.status).toBe(201);
  }

  function transfer(body, { token = managerToken(), key = `trf-${next()}` } = {}) {
    let request = t.request.post('/api/v1/pos/stock/transfers').set('Authorization', `Bearer ${token}`);
    if (key) request = request.set('Idempotency-Key', key);
    return request.send(body);
  }

  async function level(outletId, stockItemId) {
    const row = await t.trx('stock_levels').where({ outlet_id: outletId, stock_item_id: stockItemId }).first('current_quantity');
    return row?.current_quantity ?? null;
  }
  const movements = (stockItemId) => t.trx('stock_movements').where({ stock_item_id: stockItemId }).orderBy('id');

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BUSINESS_DATE });
    barId = ctx.a.posOutlets[0].id;
    storeId = await newOutlet({ type: 'store' });
  });

  describe('issuing a transfer', () => {
    test('writes two transfer legs at the item cost, moves each outlet, and leaves the property total and cost untouched', async () => {
      const itemId = await newStockItem({ purchaseCost: '4.00' });
      await receive(storeId, itemId, '24.000', '4.50');
      const before = await t.trx('stock_items').where({ id: itemId }).first('current_quantity', 'purchase_cost');

      const res = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '10', note: 'Friday restock' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        quantity: '10',
        note: 'Friday restock',
        businessDate: BUSINESS_DATE,
        from: { outletId: String(storeId), newQuantity: '14.000' },
        to: { outletId: String(barId), newQuantity: '10.000' },
      });
      expect(res.body.data.reference).toMatch(/^TRF-/);

      const legs = (await movements(itemId)).filter((row) => row.type === 'transfer');
      expect(legs).toHaveLength(2);
      const [out, into] = legs;
      expect(out).toMatchObject({ outlet_id: String(storeId), quantity: '-10.000', unit_cost: '4.50', total_cost: '-45.00', reason: 'Friday restock', reference: res.body.data.reference });
      expect(into).toMatchObject({ outlet_id: String(barId), quantity: '10.000', unit_cost: '4.50', total_cost: '45.00', reason: 'Friday restock', reference: res.body.data.reference });
      expect(String(out.business_date)).toBe(BUSINESS_DATE);

      expect(await level(storeId, itemId)).toBe('14.000');
      expect(await level(barId, itemId)).toBe('10.000');
      const after = await t.trx('stock_items').where({ id: itemId }).first('current_quantity', 'purchase_cost');
      expect(after).toEqual(before); // a relocation: same total owned, last cost not rewritten
    });

    test('may empty the source exactly, but never take it below zero — the refusal writes nothing', async () => {
      const itemId = await newStockItem();
      await receive(storeId, itemId, '5.000');

      const tooMuch = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '5.001' });
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.error.code).toBe('BUSINESS_RULE_INSUFFICIENT_STOCK_FOR_TRANSFER');
      expect(tooMuch.body.error.details).toMatchObject({ available: '5.000', requested: '5.001' });
      expect((await movements(itemId)).filter((row) => row.type === 'transfer')).toHaveLength(0);
      expect(await level(storeId, itemId)).toBe('5.000');
      expect(await level(barId, itemId)).toBeNull();

      const all = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '5.000' });
      expect(all.status).toBe(201);
      expect(await level(storeId, itemId)).toBe('0.000');
      expect(await level(barId, itemId)).toBe('5.000');
    });

    test('an outlet that has never held the item has nothing to issue', async () => {
      const itemId = await newStockItem();
      const res = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '1' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.available).toBe('0.000');
    });

    test('a source already negative from oversold sales cannot issue', async () => {
      const itemId = await newStockItem();
      await receive(barId, itemId, '2.000');
      // A sale may go negative (never blocked); simulate one directly on the ledger.
      await t.trx('stock_movements').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: barId, stock_item_id: itemId, type: 'sold', quantity: '-3.000', business_date: BUSINESS_DATE });
      await t.trx('stock_levels').where({ outlet_id: barId, stock_item_id: itemId }).update({ current_quantity: '-1.000' });
      const res = await transfer({ stock_item_id: itemId, from_outlet_id: barId, to_outlet_id: storeId, quantity: '0.5' });
      expect(res.status).toBe(422);
    });

    test('rejects the same outlet on both sides', async () => {
      const itemId = await newStockItem();
      await receive(storeId, itemId, '5.000');
      const res = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: String(storeId), quantity: '1' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_SAME_OUTLET_TRANSFER');
    });

    test.each(['0', '0.000', '-1', '1.2345', 'abc', '1e3', ' '])('rejects quantity %p', async (quantity) => {
      const itemId = await newStockItem();
      const res = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity });
      expect(res.status).toBe(400);
      expect(['VALIDATION_INVALID_QUANTITY', 'VALIDATION_MISSING_FIELD']).toContain(res.body.error.code);
    });

    test('rejects an archived outlet, an archived item, and another tenant\'s outlet or item as not found', async () => {
      const itemId = await newStockItem();
      await receive(storeId, itemId, '5.000');
      const archived = await newOutlet();
      await t.trx('pos_outlets').where({ id: archived }).update({ status: 'archived' });
      const otherOutlet = ctx.b.posOutlets[0].id;
      const otherItem = await newStockItem({ tenant: ctx.b });

      const cases = [
        [{ to_outlet_id: archived }, 'VALIDATION_OUTLET_NOT_FOUND'],
        [{ to_outlet_id: otherOutlet }, 'VALIDATION_OUTLET_NOT_FOUND'],
        [{ stock_item_id: otherItem }, 'VALIDATION_STOCK_ITEM_NOT_FOUND'],
      ];
      for (const [override, code] of cases) {
        const res = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '1', ...override });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe(code);
      }

      await t.trx('stock_items').where({ id: itemId }).update({ status: 'archived' });
      const archivedItem = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '1' });
      expect(archivedItem.status).toBe(400);
      expect(archivedItem.body.error.code).toBe('VALIDATION_STOCK_ITEM_NOT_FOUND');
      expect(await level(storeId, itemId)).toBe('5.000');
    });

    test('requires an Idempotency-Key, and a replay returns the stored result without moving stock twice', async () => {
      const itemId = await newStockItem();
      await receive(storeId, itemId, '10.000');
      const body = { stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '3' };

      const missing = await transfer(body, { key: null });
      expect(missing.status).toBe(400);

      const first = await transfer(body, { key: 'replay-me' });
      const second = await transfer(body, { key: 'replay-me' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.reference).toBe(first.body.data.reference);
      expect((await movements(itemId)).filter((row) => row.type === 'transfer')).toHaveLength(2);
      expect(await level(storeId, itemId)).toBe('7.000');
    });

    test('draining an outlet switches off the menu item that needs it there, and stock arriving switches it back on', async () => {
      const vodka = ctx.a.stockItems[0].id; // the fixture cocktail's recipe: 50 ml per sale, 1000 ml at the bar
      const cocktail = ctx.a.posMenuItems[0].id;
      expect(await level(barId, vodka)).toBe('1000.000');

      const out = await transfer({ stock_item_id: vodka, from_outlet_id: barId, to_outlet_id: storeId, quantity: '1000' });
      expect(out.status).toBe(201);
      expect((await outletMenuItem(t.trx, cocktail, barId)).is_available).toBe(0);

      const back = await transfer({ stock_item_id: vodka, from_outlet_id: storeId, to_outlet_id: barId, quantity: '100' });
      expect(back.status).toBe(201);
      expect((await outletMenuItem(t.trx, cocktail, barId)).is_available).toBe(1);
      expect(await level(barId, vodka)).toBe('100.000');
      expect(await level(storeId, vodka)).toBe('900.000');
    });

    test('an audit row records who moved what', async () => {
      const itemId = await newStockItem();
      await receive(storeId, itemId, '4.000');
      const res = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '2' });
      expect(res.status).toBe(201);
      const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, action: 'transfer', entity_type: 'stock_items', entity_id: String(itemId) }).first();
      expect(audit).toBeTruthy();
    });
  });

  describe('who may transfer (a dedicated permission and the Storekeeper role)', () => {
    test('a storekeeper can see outlets, see stock and transfer — but cannot sell, receive deliveries or read cost reports', async () => {
      const itemId = await newStockItem();
      await receive(storeId, itemId, '6.000');
      const token = await staffToken('storekeeper');

      expect((await t.request.get('/api/v1/pos/outlets').set('Authorization', `Bearer ${token}`)).status).toBe(200);
      expect((await t.request.get(`/api/v1/pos/stock/items?outlet_id=${storeId}`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
      expect((await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '2' }, { token })).status).toBe(201);
      expect((await t.request.get('/api/v1/pos/stock/transfers').set('Authorization', `Bearer ${token}`)).status).toBe(200);

      const denied = [
        t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${token}`).send({ outlet_id: barId, terminal_id: ctx.a.posTerminals[0].id }),
        t.request.post('/api/v1/pos/stock/goods-received').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', `k-${next()}`).send({ outlet_id: storeId, lines: [{ stock_item_id: itemId, quantity: '1', unit_cost: '1.00' }] }),
        t.request.get(`/api/v1/pos/stock/reports/overview?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`).set('Authorization', `Bearer ${token}`),
        t.request.get(`/api/v1/pos/stock/movements?outlet_id=${storeId}`).set('Authorization', `Bearer ${token}`),
      ];
      for (const res of await Promise.all(denied)) expect(res.status).toBe(403);
    });

    test.each(['pos_operator', 'housekeeping', 'front_desk', 'cashier'])('%s cannot transfer', async (role) => {
      const itemId = await newStockItem();
      await receive(storeId, itemId, '2.000');
      const res = await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '1' }, { token: await staffToken(role) });
      expect(res.status).toBe(403);
      expect(res.body.error.details.permission).toBe('pos.stock_transfer');
    });

    test('housekeeping still cannot read the outlet list', async () => {
      const res = await t.request.get('/api/v1/pos/outlets').set('Authorization', `Bearer ${await staffToken('housekeeping')}`);
      expect(res.status).toBe(403);
    });
  });

  describe('transfer history', () => {
    test('one row per transfer with both outlets, filterable by outlet, and no cost', async () => {
      const itemId = await newStockItem({ name: `History ${next()}` });
      const otherBar = await newOutlet();
      await receive(storeId, itemId, '20.000');
      await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '3', note: 'first' });
      await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: otherBar, quantity: '4', note: 'second' });

      const res = await t.request.get(`/api/v1/pos/stock/transfers?outlet_id=${otherBar}`).set('Authorization', `Bearer ${managerToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      const [row] = res.body.data;
      expect(row).toMatchObject({ stockItemId: String(itemId), quantity: '4.000', note: 'second', from: { outletId: String(storeId) }, to: { outletId: String(otherBar) } });
      expect(JSON.stringify(row)).not.toMatch(/cost/i);

      const all = await t.request.get(`/api/v1/pos/stock/transfers?outlet_id=${storeId}`).set('Authorization', `Bearer ${managerToken()}`);
      const mine = all.body.data.filter((r) => r.stockItemId === String(itemId));
      expect(mine.map((r) => r.note)).toEqual(['second', 'first']);
    });

    test('another tenant never sees this tenant\'s transfers', async () => {
      const itemId = await newStockItem();
      await receive(storeId, itemId, '2.000');
      await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '1' });
      const res = await t.request.get('/api/v1/pos/stock/transfers').set('Authorization', `Bearer ${tokenFor({ tenant: ctx.b })}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((row) => row.stockItemId === String(itemId))).toBe(false);
    });
  });

  describe('reports show a transfer as a transfer — never as wastage or a delivery', () => {
    const context = () => contextFromSession({ tenantId: ctx.a.id, propertyId, userId: ctx.a.users[0].id });
    const itemRow = (report, itemId) => report.items.find((row) => row.stockItemId === String(itemId));

    test('the overview has transfer in/out lines per outlet and they net to zero property-wide', async () => {
      const itemId = await newStockItem({ name: `Overview ${next()}` });
      await receive(storeId, itemId, '12.000', '2.50');
      const range = { dateFrom: BUSINESS_DATE, dateTo: BUSINESS_DATE };
      const costBefore = await reporting.computeCostOfSales({ context: context(), ...range });

      await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '8' });

      const store = itemRow(await reporting.computeStockOverview({ context: context(), ...range, outletId: storeId }), itemId);
      expect(store).toMatchObject({ receivedQty: '12.000', transferOutQty: '8.000', transferOutCost: '20.00', transferInQty: '0.000', wastageQty: '0.000', wastageCost: '0.00', currentQuantity: '4.000' });

      const bar = itemRow(await reporting.computeStockOverview({ context: context(), ...range, outletId: barId }), itemId);
      expect(bar).toMatchObject({ receivedQty: '0.000', transferInQty: '8.000', transferInCost: '20.00', transferOutQty: '0.000', wastageQty: '0.000', currentQuantity: '8.000' });

      const all = await reporting.computeStockOverview({ context: context(), ...range });
      const allRow = itemRow(all, itemId);
      expect(allRow).toMatchObject({ receivedQty: '12.000', transferInQty: '8.000', transferOutQty: '8.000', wastageQty: '0.000', currentQuantity: '12.000' });
      expect(allRow.transferInCost).toBe(allRow.transferOutCost);

      const costAfter = await reporting.computeCostOfSales({ context: context(), ...range });
      expect(costAfter).toEqual(costBefore);
    });

    test('a stock take after a transfer shows no variance when the counts match what is physically there', async () => {
      const itemId = await newStockItem();
      await receive(storeId, itemId, '10.000');
      await transfer({ stock_item_id: itemId, from_outlet_id: storeId, to_outlet_id: barId, quantity: '6' });

      const open = await t.request.post('/api/v1/pos/stock/takes').set('Authorization', `Bearer ${managerToken()}`).send({ outlet_id: storeId });
      expect(open.status).toBe(201);
      const takeId = open.body.data.id;
      const count = await t.request
        .patch(`/api/v1/pos/stock/takes/${takeId}/lines/${itemId}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ counted_quantity: '4.000' });
      expect(count.status).toBe(200);
      const complete = await t.request.post(`/api/v1/pos/stock/takes/${takeId}/complete`).set('Authorization', `Bearer ${managerToken()}`).set('Idempotency-Key', `take-${next()}`);
      expect(complete.status).toBe(200);

      const variance = await reporting.computeStockVariance({ context: context(), dateFrom: BUSINESS_DATE, dateTo: BUSINESS_DATE, outletId: storeId });
      const line = variance.lines.find((row) => String(row.stock_item_id) === String(itemId));
      expect(line).toMatchObject({ theoretical_quantity: '4.000', counted_quantity: '4.000', variance: '0.000' });
    });
  });

  describe('a store outlet is never a point of sale', () => {
    test('refuses an order, a terminal, a QR code and guest ordering — turning guest ordering off still works', async () => {
      const token = managerToken();
      const order = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${token}`).send({ outlet_id: storeId, terminal_id: ctx.a.posTerminals[0].id });
      const terminal = await t.request.post('/api/v1/pos/terminals').set('Authorization', `Bearer ${token}`).send({ outlet_id: storeId, device_ref: `S-${next()}` });
      const qr = await t.request.post('/api/v1/pos/qr-tokens').set('Authorization', `Bearer ${token}`).send({ outlet_id: storeId, type: 'table', table_label: 'T1' });
      const guestOn = await t.request.post(`/api/v1/pos/outlets/${storeId}/toggle-guest-ordering`).set('Authorization', `Bearer ${token}`).send({ enabled: true });
      for (const res of [order, terminal, qr, guestOn]) {
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('BUSINESS_RULE_STORE_OUTLET_NOT_SELLABLE');
      }
      const guestOff = await t.request.post(`/api/v1/pos/outlets/${storeId}/toggle-guest-ordering`).set('Authorization', `Bearer ${token}`).send({ enabled: false });
      expect(guestOff.status).toBe(200);
    });

    test('an outlet still selling cannot become a store until its tabs and guest ordering are cleared', async () => {
      const token = managerToken();
      const outletId = await newOutlet();
      const [orderId] = await t.trx('pos_orders').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, status: 'open' });
      await t.trx('pos_outlets').where({ id: outletId }).update({ guest_ordering_enabled: true });

      const blocked = await t.request.patch(`/api/v1/pos/outlets/${outletId}`).set('Authorization', `Bearer ${token}`).send({ type: 'store' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('CONFLICT_STORE_OUTLET_CONVERSION_BLOCKED');
      expect(blocked.body.error.details).toMatchObject({ openOrderCount: 1, guestOrderingEnabled: true });
      expect((await t.trx('pos_outlets').where({ id: outletId }).first('type')).type).toBe('bar');

      await t.trx('pos_orders').where({ id: orderId }).update({ status: 'void' });
      const stillGuest = await t.request.patch(`/api/v1/pos/outlets/${outletId}`).set('Authorization', `Bearer ${token}`).send({ type: 'store' });
      expect(stillGuest.status).toBe(409);

      await t.trx('pos_outlets').where({ id: outletId }).update({ guest_ordering_enabled: false });
      const ok = await t.request.patch(`/api/v1/pos/outlets/${outletId}`).set('Authorization', `Bearer ${token}`).send({ type: 'store', name: 'Main Store' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ type: 'store', name: 'Main Store' });

      const back = await t.request.patch(`/api/v1/pos/outlets/${outletId}`).set('Authorization', `Bearer ${token}`).send({ type: 'bar' });
      expect(back.status).toBe(200);
      expect(back.body.data.type).toBe('bar');
    });

    test('an active QR code blocks the conversion too', async () => {
      const outletId = await newOutlet();
      await t.trx('pos_order_tokens').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, type: 'table', table_label: 'T9', token_hash: `h${next()}`, token_encrypted: 'x', active: true });
      const res = await t.request.patch(`/api/v1/pos/outlets/${outletId}`).set('Authorization', `Bearer ${managerToken()}`).send({ type: 'store' });
      expect(res.status).toBe(409);
      expect(res.body.error.details.activeTokenCount).toBe(1);
    });

    test('stores stay visible to every outlet list — they are managed and stocked like any outlet', async () => {
      const res = await t.request.get('/api/v1/pos/outlets').set('Authorization', `Bearer ${managerToken()}`);
      expect(res.body.data.some((row) => row.id === String(storeId) && row.type === 'store')).toBe(true);
    });
  });
});
