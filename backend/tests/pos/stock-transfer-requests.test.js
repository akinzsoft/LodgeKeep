'use strict';

/**
 * Stock transfer requests — an outlet asks the store for stock, the
 * storekeeper issues it (in full, in part) or rejects it.
 *
 * Confirmed decisions under test: several items per request; raised by
 * POS operators and managers (`pos.stock_request`), never by a storekeeper;
 * issued or rejected in one step by `pos.stock_transfer`; an issued line IS
 * a transfer (same ledger legs, same refusal below zero), and the stock
 * moves on issue. A request is decided exactly once. The real-concurrency
 * proofs (two storekeepers, issue vs cancel, crossing issues) live in
 * stock-transfer-requests-concurrency.test.js.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertStockItem } = require('../helpers/catalogue');

const BUSINESS_DATE = '2027-07-01';

describe('Stock transfer requests', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let barId;
  let storeId;
  let counter = 0;
  const users = {};

  function next() {
    counter += 1;
    return `${Date.now().toString(36)}${counter}`;
  }

  function tokenForUser(userId, tenant = ctx.a) {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }
  const managerToken = () => tokenForUser(ctx.a.users[0].id);
  const asRole = (role) => tokenForUser(users[role]);

  /** A fresh staff user holding `role` at property 0 of tenant A. */
  async function userWithRole(role) {
    const [id] = await t.trx('users').insert({
      tenant_id: ctx.a.id,
      email: `${role}-${next()}@example.com`,
      first_name: role === 'pos_operator' ? 'Bola' : 'Kemi',
      last_name: role === 'pos_operator' ? 'Barman' : 'Store',
      password_hash: 'x',
      status: 'active',
    });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    return id;
  }

  async function newOutlet(type) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `R${next()}`.slice(0, 30), name: `${type} ${counter}`, type });
    return id;
  }

  async function newStockItem(name) {
    const [id] = await insertStockItem(t.trx, {
      tenant_id: ctx.a.id,
      property_id: propertyId,
      name: name ?? `Item ${next()}`,
      unit: 'bottle',
      purchase_cost: '3.00',
      reorder_level: '0.000',
    });
    return id;
  }

  async function receive(outletId, stockItemId, quantity) {
    const res = await t.request
      .post('/api/v1/pos/stock/goods-received')
      .set('Authorization', `Bearer ${managerToken()}`)
      .set('Idempotency-Key', `rcv-${next()}`)
      .send({ outlet_id: outletId, lines: [{ stock_item_id: stockItemId, quantity, unit_cost: '3.00' }] });
    expect(res.status).toBe(201);
  }

  function post(path, body, { token = asRole('pos_operator'), key = `req-${next()}` } = {}) {
    let request = t.request.post(`/api/v1/pos/stock/transfer-requests${path}`).set('Authorization', `Bearer ${token}`);
    if (key) request = request.set('Idempotency-Key', key);
    return request.send(body);
  }
  const raise = (body, options) => post('', body, options);
  const issue = (id, body, options = {}) => post(`/${id}/issue`, body, { token: asRole('storekeeper'), ...options });
  const reject = (id, body, options = {}) => post(`/${id}/reject`, body, { token: asRole('storekeeper'), ...options });
  const cancel = (id, body, options = {}) => post(`/${id}/cancel`, body, options);

  async function level(outletId, stockItemId) {
    const row = await t.trx('stock_levels').where({ outlet_id: outletId, stock_item_id: stockItemId }).first('current_quantity');
    return row?.current_quantity ?? '0.000';
  }
  const transferLegs = (stockItemId) => t.trx('stock_movements').where({ stock_item_id: stockItemId, type: 'transfer' }).orderBy('id');
  const bell = (userId, type) => t.trx('in_app_notifications').where({ user_id: userId, type });

  /** A pending request from the store to the bar for the given `[itemId, quantity]` pairs. */
  async function pendingRequest(pairs, note) {
    const res = await raise({ from_outlet_id: storeId, to_outlet_id: barId, note, lines: pairs.map(([id, quantity]) => ({ stock_item_id: id, quantity })) });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BUSINESS_DATE });
    barId = ctx.a.posOutlets[0].id;
    storeId = await newOutlet('store');
    for (const role of ['pos_operator', 'storekeeper', 'cashier']) users[role] = await userWithRole(role);
  });

  describe('raising a request', () => {
    test('a POS operator asks the store for several items; it is pending, shows what the store holds, and the storekeeper is told', async () => {
      const coke = await newStockItem('Coke');
      const gin = await newStockItem('Gin');
      await receive(storeId, coke, '30.000');

      const res = await raise({
        from_outlet_id: storeId,
        to_outlet_id: barId,
        note: 'Friday night',
        lines: [
          { stock_item_id: coke, quantity: '12' },
          { stock_item_id: gin, quantity: '2.5' },
        ],
      });
      expect(res.status).toBe(201);
      const request = res.body.data;
      expect(request).toMatchObject({
        status: 'pending',
        note: 'Friday night',
        fromOutlet: { id: String(storeId), type: 'store' },
        toOutlet: { id: String(barId) },
        requestedBy: { userId: String(users.pos_operator), name: 'Bola Barman' },
        decidedBy: null,
      });
      const byName = Object.fromEntries(request.lines.map((line) => [line.name, line]));
      expect(byName.Coke).toMatchObject({ quantityRequested: '12.000', quantityIssued: null, availableAtSource: '30.000' });
      expect(byName.Gin).toMatchObject({ quantityRequested: '2.500', availableAtSource: '0.000' }); // asking for more than the store holds is allowed

      const told = await bell(users.storekeeper, 'stock.transfer_requested');
      expect(told).toHaveLength(1);
      expect(Boolean(told[0].popup)).toBe(true); // pops up on screen, not only a bell count
      expect(await bell(users.pos_operator, 'stock.transfer_requested')).toHaveLength(0);
      // Nothing moves until it is issued.
      expect(await transferLegs(coke)).toHaveLength(0);
    });

    test.each([
      ['no lines', () => ({ from_outlet_id: storeId, to_outlet_id: barId, lines: [] }), 'VALIDATION_MISSING_FIELD'],
      ['a zero quantity', (item) => ({ from_outlet_id: storeId, to_outlet_id: barId, lines: [{ stock_item_id: item, quantity: '0' }] }), 'VALIDATION_INVALID_QUANTITY'],
      ['four decimals', (item) => ({ from_outlet_id: storeId, to_outlet_id: barId, lines: [{ stock_item_id: item, quantity: '1.0001' }] }), 'VALIDATION_INVALID_QUANTITY'],
      ['the same outlet twice', (item) => ({ from_outlet_id: barId, to_outlet_id: barId, lines: [{ stock_item_id: item, quantity: '1' }] }), 'VALIDATION_SAME_OUTLET_TRANSFER'],
      [
        'the same item twice',
        (item) => ({ from_outlet_id: storeId, to_outlet_id: barId, lines: [{ stock_item_id: item, quantity: '1' }, { stock_item_id: item, quantity: '2' }] }),
        'VALIDATION_DUPLICATE_STOCK_ITEM',
      ],
    ])('refuses %s and writes nothing', async (_name, body, code) => {
      const item = await newStockItem();
      const before = await t.trx('stock_transfer_requests').count({ n: '*' }).first();
      const res = await raise(body(item));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(code);
      expect(await t.trx('stock_transfer_requests').count({ n: '*' }).first()).toEqual(before);
    });

    test("refuses an archived item and another tenant's outlet or item", async () => {
      const archived = await newStockItem();
      await t.trx('stock_items').where({ id: archived }).update({ status: 'archived' });
      const archivedRes = await raise({ from_outlet_id: storeId, to_outlet_id: barId, lines: [{ stock_item_id: archived, quantity: '1' }] });
      expect(archivedRes.status).toBe(400);
      expect(archivedRes.body.error.code).toBe('VALIDATION_STOCK_ITEM_NOT_FOUND');

      const item = await newStockItem();
      const otherOutlet = await raise({ from_outlet_id: ctx.b.posOutlets[0].id, to_outlet_id: barId, lines: [{ stock_item_id: item, quantity: '1' }] });
      expect(otherOutlet.status).toBe(400);
      expect(otherOutlet.body.error.code).toBe('VALIDATION_OUTLET_NOT_FOUND');

      const otherItem = await raise({ from_outlet_id: storeId, to_outlet_id: barId, lines: [{ stock_item_id: ctx.b.stockItems[0].id, quantity: '1' }] });
      expect(otherItem.status).toBe(400);
      expect(otherItem.body.error.code).toBe('VALIDATION_STOCK_ITEM_NOT_FOUND');
    });

    test('a replayed Idempotency-Key returns the same request instead of raising a second one', async () => {
      const item = await newStockItem();
      const body = { from_outlet_id: storeId, to_outlet_id: barId, lines: [{ stock_item_id: item, quantity: '3' }] };
      const first = await raise(body, { key: 'same-request-key' });
      const second = await raise(body, { key: 'same-request-key' });
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await t.trx('stock_transfer_request_lines').where({ stock_item_id: item })).toHaveLength(1);
    });
  });

  describe('issuing a request', () => {
    test('moves every line as a real transfer, records what was sent, and tells the outlet', async () => {
      const coke = await newStockItem();
      const fanta = await newStockItem();
      await receive(storeId, coke, '20.000');
      await receive(storeId, fanta, '10.000');
      const request = await pendingRequest([[coke, '12'], [fanta, '6']]);

      const res = await issue(request.id, { note: 'Sent with the porter', lines: [{ stock_item_id: coke, quantity: '12' }, { stock_item_id: fanta, quantity: '6' }] });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'issued', decisionNote: 'Sent with the porter', businessDate: BUSINESS_DATE, decidedBy: { userId: String(users.storekeeper) } });

      expect(await level(storeId, coke)).toBe('8.000');
      expect(await level(barId, coke)).toBe('12.000');
      expect(await level(storeId, fanta)).toBe('4.000');
      expect(await level(barId, fanta)).toBe('6.000');

      for (const line of res.body.data.lines) {
        const legs = await transferLegs(line.stockItemId);
        expect(legs).toHaveLength(2);
        expect(legs.every((leg) => leg.reference === line.transferReference)).toBe(true);
        expect(legs[0].reason).toBe(`Request #${request.id} — Sent with the porter`);
        expect(line.quantityIssued).toBe(line.quantityRequested);
        expect(line.availableAtSource).toBeNull(); // only shown while pending
      }
      expect(await bell(users.pos_operator, 'stock.transfer_request_issued')).not.toHaveLength(0);
    });

    test('can send a line short or not at all; a zero line moves nothing and is recorded as 0', async () => {
      const coke = await newStockItem();
      const gin = await newStockItem();
      await receive(storeId, coke, '8.000');
      const request = await pendingRequest([[coke, '12'], [gin, '2']]);

      const res = await issue(request.id, { lines: [{ stock_item_id: coke, quantity: '8' }, { stock_item_id: gin, quantity: '0' }] });
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.data.lines.map((line) => [String(line.stockItemId), line]));
      expect(byId[coke]).toMatchObject({ quantityRequested: '12.000', quantityIssued: '8.000' });
      expect(byId[gin]).toMatchObject({ quantityIssued: '0.000', transferReference: null });
      expect(await level(storeId, coke)).toBe('0.000');
      expect(await transferLegs(gin)).toHaveLength(0);

      const note = await t.trx('in_app_notifications').where({ user_id: users.pos_operator, type: 'stock.transfer_request_issued' }).orderBy('id', 'desc').first();
      expect(note.payload).toMatchObject({ requestId: Number(request.id), shortLineCount: 2 });
      expect(Boolean(note.popup)).toBe(true);
    });

    test('refuses more than the source holds, naming the item — and nothing on the request moves', async () => {
      const coke = await newStockItem('Coke short');
      const fanta = await newStockItem('Fanta short');
      await receive(storeId, coke, '20.000');
      await receive(storeId, fanta, '3.000');
      const request = await pendingRequest([[coke, '10'], [fanta, '5']]);

      const res = await issue(request.id, { lines: [{ stock_item_id: coke, quantity: '10' }, { stock_item_id: fanta, quantity: '5' }] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_INSUFFICIENT_STOCK_FOR_TRANSFER');
      expect(res.body.error.message).toContain('Fanta short');
      expect(res.body.error.message).not.toContain('Coke short');
      expect(res.body.error.details.lines).toEqual([{ stockItemId: Number(fanta), name: 'Fanta short', unit: 'bottle', available: '3.000', requested: '5' }]);

      expect(await transferLegs(coke)).toHaveLength(0);
      expect(await level(storeId, coke)).toBe('20.000');
      expect((await t.trx('stock_transfer_requests').where({ id: request.id }).first()).status).toBe('pending');

      // The storekeeper lowers the short line and issues again.
      const retry = await issue(request.id, { lines: [{ stock_item_id: coke, quantity: '10' }, { stock_item_id: fanta, quantity: '3' }] });
      expect(retry.status).toBe(200);
      expect(await level(barId, fanta)).toBe('3.000');
    });

    test.each([
      ['more than was asked', (a, b) => [{ stock_item_id: a, quantity: '5.001' }, { stock_item_id: b, quantity: '1' }], 'VALIDATION_QUANTITY_EXCEEDS_REQUEST'],
      ['a missing line', (a) => [{ stock_item_id: a, quantity: '1' }], 'VALIDATION_ISSUE_LINES_MISMATCH'],
      ['an item not on the request', (a, b, c) => [{ stock_item_id: a, quantity: '1' }, { stock_item_id: b, quantity: '1' }, { stock_item_id: c, quantity: '1' }], 'VALIDATION_ISSUE_LINES_MISMATCH'],
      ['nothing at all', (a, b) => [{ stock_item_id: a, quantity: '0' }, { stock_item_id: b, quantity: '0' }], 'VALIDATION_NOTHING_ISSUED'],
    ])('refuses issuing %s', async (_name, lines, code) => {
      const a = await newStockItem();
      const b = await newStockItem();
      const c = await newStockItem();
      await receive(storeId, a, '10.000');
      await receive(storeId, b, '10.000');
      const request = await pendingRequest([[a, '5'], [b, '5']]);

      const res = await issue(request.id, { lines: lines(a, b, c) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(code);
      expect(await transferLegs(a)).toHaveLength(0);
    });

    test('an item archived after the request was raised cannot be sent, but the rest of the request can', async () => {
      const kept = await newStockItem();
      const retired = await newStockItem('Retired lager');
      await receive(storeId, kept, '5.000');
      await receive(storeId, retired, '5.000');
      const request = await pendingRequest([[kept, '2'], [retired, '2']]);
      await t.trx('stock_items').where({ id: retired }).update({ status: 'archived' });

      const refused = await issue(request.id, { lines: [{ stock_item_id: kept, quantity: '2' }, { stock_item_id: retired, quantity: '2' }] });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_STOCK_ITEM_ARCHIVED');
      expect(refused.body.error.message).toContain('Retired lager');

      const res = await issue(request.id, { lines: [{ stock_item_id: kept, quantity: '2' }, { stock_item_id: retired, quantity: '0' }] });
      expect(res.status).toBe(200);
      expect(res.body.data.lines.find((line) => String(line.stockItemId) === String(retired)).archived).toBe(true);
    });

    test('is decided once — a second issue, a reject or a cancel afterwards is a 409', async () => {
      const item = await newStockItem();
      await receive(storeId, item, '10.000');
      const request = await pendingRequest([[item, '4']]);
      expect((await issue(request.id, { lines: [{ stock_item_id: item, quantity: '4' }] })).status).toBe(200);

      const again = await issue(request.id, { lines: [{ stock_item_id: item, quantity: '4' }] });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CONFLICT_STOCK_TRANSFER_REQUEST_NOT_PENDING');
      expect((await reject(request.id, { reason: 'late' })).status).toBe(409);
      expect((await cancel(request.id, {})).status).toBe(409);
      expect(await level(barId, item)).toBe('4.000');
    });

    test('a replayed issue key returns the stored result and moves nothing twice', async () => {
      const item = await newStockItem();
      await receive(storeId, item, '10.000');
      const request = await pendingRequest([[item, '4']]);
      const body = { lines: [{ stock_item_id: item, quantity: '4' }] };
      expect((await issue(request.id, body, { key: 'issue-once' })).status).toBe(200);
      const replay = await issue(request.id, body, { key: 'issue-once' });
      expect(replay.status).toBe(200);
      expect(await transferLegs(item)).toHaveLength(2);
    });
  });

  describe('rejecting and cancelling', () => {
    test('a storekeeper rejects with a reason the outlet is told; nothing moves', async () => {
      const item = await newStockItem();
      await receive(storeId, item, '10.000');
      const request = await pendingRequest([[item, '4']]);

      const noReason = await reject(request.id, { reason: '  ' });
      expect(noReason.status).toBe(400);

      const res = await reject(request.id, { reason: 'Stock is being counted tonight' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'rejected', decisionNote: 'Stock is being counted tonight', decidedBy: { userId: String(users.storekeeper) } });
      expect(res.body.data.lines[0].quantityIssued).toBeNull();
      expect(await transferLegs(item)).toHaveLength(0);
      const note = await t.trx('in_app_notifications').where({ user_id: users.pos_operator, type: 'stock.transfer_request_rejected' }).orderBy('id', 'desc').first();
      expect(note.payload).toMatchObject({ requestId: Number(request.id), reason: 'Stock is being counted tonight' });
      expect(Boolean(note.popup)).toBe(true);
    });

    test('a requester withdraws a pending request; it can no longer be issued', async () => {
      const item = await newStockItem();
      await receive(storeId, item, '10.000');
      const request = await pendingRequest([[item, '4']]);

      const res = await cancel(request.id, { reason: 'Found some in the back' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', decisionNote: 'Found some in the back' });
      expect((await issue(request.id, { lines: [{ stock_item_id: item, quantity: '4' }] })).status).toBe(409);
    });

    test("an unknown or another tenant's request is a 404 on every action", async () => {
      const foreign = ctx.b.stockTransferRequests[0].id;
      for (const id of [foreign, '999999999']) {
        expect((await issue(id, { lines: [{ stock_item_id: ctx.a.stockItems[0].id, quantity: '1' }] })).status).toBe(404);
        expect((await reject(id, { reason: 'no' })).status).toBe(404);
        expect((await cancel(id, {})).status).toBe(404);
        const read = await t.request.get(`/api/v1/pos/stock/transfer-requests/${id}`).set('Authorization', `Bearer ${asRole('storekeeper')}`);
        expect(read.status).toBe(404);
      }
    });
  });

  describe('who can do what', () => {
    test('a storekeeper issues but never raises; a POS operator raises but never issues or rejects', async () => {
      const item = await newStockItem();
      await receive(storeId, item, '10.000');
      const body = { from_outlet_id: storeId, to_outlet_id: barId, lines: [{ stock_item_id: item, quantity: '1' }] };

      const byStorekeeper = await raise(body, { token: asRole('storekeeper') });
      expect(byStorekeeper.status).toBe(403);

      const request = await pendingRequest([[item, '1']]);
      expect((await issue(request.id, { lines: [{ stock_item_id: item, quantity: '1' }] }, { token: asRole('pos_operator') })).status).toBe(403);
      expect((await reject(request.id, { reason: 'x' }, { token: asRole('pos_operator') })).status).toBe(403);
      expect((await cancel(request.id, {}, { token: asRole('storekeeper') })).status).toBe(403);

      // A manager does both.
      expect((await raise(body, { token: managerToken() })).status).toBe(201);
      expect((await issue(request.id, { lines: [{ stock_item_id: item, quantity: '1' }] }, { token: managerToken() })).status).toBe(200);
    });

    test('both sides read the list; a role with neither key cannot', async () => {
      const item = await newStockItem();
      const request = await pendingRequest([[item, '1']]);
      for (const token of [asRole('pos_operator'), asRole('storekeeper'), managerToken()]) {
        const res = await t.request.get('/api/v1/pos/stock/transfer-requests?status=pending').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.data.map((row) => row.id)).toContain(request.id);
        expect(res.body.data.every((row) => row.status === 'pending')).toBe(true);
      }
      const cashier = await t.request.get('/api/v1/pos/stock/transfer-requests').set('Authorization', `Bearer ${asRole('cashier')}`);
      expect(cashier.status).toBe(403);
    });

    test("the list never shows another tenant's requests, and filters by outlet on either side", async () => {
      const item = await newStockItem();
      const request = await pendingRequest([[item, '1']]);
      const all = await t.request.get('/api/v1/pos/stock/transfer-requests').set('Authorization', `Bearer ${managerToken()}`);
      expect(all.body.data.map((row) => row.id)).not.toContain(String(ctx.b.stockTransferRequests[0].id));

      const otherOutlet = await newOutlet('restaurant');
      const byStore = await t.request.get(`/api/v1/pos/stock/transfer-requests?outlet_id=${storeId}`).set('Authorization', `Bearer ${managerToken()}`);
      const byOther = await t.request.get(`/api/v1/pos/stock/transfer-requests?outlet_id=${otherOutlet}`).set('Authorization', `Bearer ${managerToken()}`);
      expect(byStore.body.data.map((row) => row.id)).toContain(request.id);
      expect(byOther.body.data).toEqual([]);
    });

    test('every decision is audited', async () => {
      const item = await newStockItem();
      await receive(storeId, item, '5.000');
      const request = await pendingRequest([[item, '1']]);
      await issue(request.id, { lines: [{ stock_item_id: item, quantity: '1' }] });
      const actions = (await t.trx('audit_log').where({ entity_type: 'stock_transfer_requests', entity_id: request.id }).select('action')).map((row) => row.action);
      expect(actions).toEqual(expect.arrayContaining(['create', 'issue']));
    });
  });
});
