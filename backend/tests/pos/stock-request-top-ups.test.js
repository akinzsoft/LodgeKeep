'use strict';

/**
 * Stock request top-ups ("Request the rest"). Confirmed with the user: a
 * request is still decided once — the store never sends more against an
 * issued request; an outlet whose request was issued short raises a NEW
 * request for the rest, linked to the one it tops up, from an editable
 * form (it may ask for less, drop lines or add items).
 *
 * Under test: the link both ways; the rules (only an issued-SHORT request,
 * same two outlets, one live top-up at a time — a rejected or withdrawn
 * one frees the shortfall again); visibility (404 for a request the caller
 * cannot see); the storekeeper's alert says it is a top-up. The race of two
 * top-ups at once is CONC-REQ-5 in stock-transfer-requests-concurrency.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertStockItem } = require('../helpers/catalogue');

describe('Stock request top-ups', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let barId;
  let poolId;
  let storeId;
  let counter = 0;
  const users = {};

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId, tenant = ctx.a) =>
    signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const as = (name) => tokenFor(users[name]);

  async function staff(role, outletIds = []) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'Test', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    for (const outletId of outletIds) {
      await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, outlet_id: outletId });
    }
    return id;
  }

  async function outlet(name, type) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `T${next()}`.slice(0, 30), name, type });
    return id;
  }

  async function stocked(quantity) {
    const [itemId] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: `Item ${next()}`, unit: 'bottle', purchase_cost: '2.00', reorder_level: '0.000' });
    if (quantity) {
      const res = await t.request
        .post('/api/v1/pos/stock/goods-received')
        .set('Authorization', `Bearer ${tokenFor(ctx.a.users[0].id)}`)
        .set('Idempotency-Key', `g-${next()}`)
        .send({ outlet_id: storeId, lines: [{ stock_item_id: itemId, quantity, unit_cost: '2.00' }] });
      expect(res.status).toBe(201);
    }
    return itemId;
  }

  function post(path, body, token = as('operator')) {
    return t.request.post(`/api/v1/pos/stock/transfer-requests${path}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', `u-${next()}`).send(body);
  }
  const get = (path, token = as('operator')) => t.request.get(`/api/v1/pos/stock/transfer-requests${path}`).set('Authorization', `Bearer ${token}`);
  const lines = (pairs) => pairs.map(([id, quantity]) => ({ stock_item_id: id, quantity }));
  const raise = (pairs, extra = {}, token) => post('', { from_outlet_id: storeId, to_outlet_id: barId, lines: lines(pairs), ...extra }, token);

  /** A request from the store to the bar, issued with the given amounts. */
  async function issuedRequest(asked, sent) {
    const raised = await raise(asked);
    expect(raised.status).toBe(201);
    const issued = await post(`/${raised.body.data.id}/issue`, { lines: lines(sent) }, as('keeper'));
    expect(issued.status).toBe(200);
    return issued.body.data;
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-10-01' });
    barId = ctx.a.posOutlets[0].id;
    poolId = await outlet('Pool Bar', 'poolside');
    storeId = await outlet('Main Store', 'store');
    users.operator = await staff('pos_operator');
    users.keeper = await staff('storekeeper');
    users.poolOp = await staff('pos_operator', [poolId]);
  });

  test('a top-up of a short issue is linked both ways, may differ from the shortfall, and tells the storekeeper it is a top-up', async () => {
    const coke = await stocked('4.000');
    const gin = await stocked('10.000');
    const malt = await stocked(null);
    const original = await issuedRequest([[coke, '10'], [gin, '3']], [[coke, '4'], [gin, '3']]);

    // The form starts from the shortfall (6 Coke); the outlet asks for 5 and adds Malt.
    const res = await raise([[coke, '5'], [malt, '2']], { top_up_of_request_id: original.id, note: 'Top-up of #' + original.id });
    expect(res.status).toBe(201);
    const topUp = res.body.data;
    expect(topUp).toMatchObject({ status: 'pending', topUpOfRequestId: String(original.id), topUps: [] });
    expect(topUp.lines.map((line) => [line.stockItemId, line.quantityRequested]).sort()).toEqual(
      [[String(coke), '5.000'], [String(malt), '2.000']].sort(),
    );

    const again = await get(`/${original.id}`);
    expect(again.body.data).toMatchObject({ status: 'issued', topUpOfRequestId: null, topUps: [{ id: topUp.id, status: 'pending' }] });
    // The original's own record is untouched: still decided once.
    expect(again.body.data.lines.find((line) => line.stockItemId === String(coke)).quantityIssued).toBe('4.000');

    const bells = await t.trx('in_app_notifications').where({ user_id: users.keeper, type: 'stock.transfer_requested' });
    const payload = bells.map((row) => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload)).find((p) => p.requestId === Number(topUp.id));
    expect(payload).toMatchObject({ topUpOfRequestId: Number(original.id) });
  });

  test('only an issued-short request can be topped up', async () => {
    const item = await stocked('20.000');
    const full = await issuedRequest([[item, '2']], [[item, '2']]);
    const fullRes = await raise([[item, '1']], { top_up_of_request_id: full.id });
    expect(fullRes.status).toBe(422);
    expect(fullRes.body.error).toMatchObject({ code: 'BUSINESS_RULE_TOP_UP_REQUIRES_SHORT_ISSUE', details: { status: 'issued' } });

    const pending = (await raise([[item, '1']])).body.data;
    const pendingRes = await raise([[item, '1']], { top_up_of_request_id: pending.id });
    expect(pendingRes.status).toBe(422);
    expect(pendingRes.body.error.details).toMatchObject({ status: 'pending' });

    const rejected = (await raise([[item, '1']])).body.data;
    expect((await post(`/${rejected.id}/reject`, { reason: 'No' }, as('keeper'))).status).toBe(200);
    expect((await raise([[item, '1']], { top_up_of_request_id: rejected.id })).body.error.code).toBe('BUSINESS_RULE_TOP_UP_REQUIRES_SHORT_ISSUE');

    // Nothing was created by any refusal.
    expect(await t.trx('stock_transfer_requests').whereIn('top_up_of_request_id', [full.id, pending.id, rejected.id])).toHaveLength(0);
  });

  test('one live top-up at a time: a pending or issued one blocks another; a withdrawn or rejected one frees the shortfall', async () => {
    const item = await stocked('3.000');
    const original = await issuedRequest([[item, '10']], [[item, '3']]);
    const ask = () => raise([[item, '7']], { top_up_of_request_id: original.id });

    const first = (await ask()).body.data;
    const blocked = await ask();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({
      code: 'CONFLICT_STOCK_REQUEST_ALREADY_TOPPED_UP',
      details: { requestId: Number(original.id), topUpRequestId: Number(first.id), topUpStatus: 'pending' },
    });

    expect((await post(`/${first.id}/cancel`, { reason: 'Found some' })).status).toBe(200);
    const second = (await ask()).body.data;
    expect((await post(`/${second.id}/reject`, { reason: 'Out' }, as('keeper'))).status).toBe(200);
    const third = await ask();
    expect(third.status).toBe(201);

    // The store restocks, and the third top-up is issued.
    const receive = await t.request
      .post('/api/v1/pos/stock/goods-received')
      .set('Authorization', `Bearer ${tokenFor(ctx.a.users[0].id)}`)
      .set('Idempotency-Key', `g-${next()}`)
      .send({ outlet_id: storeId, lines: [{ stock_item_id: item, quantity: '7', unit_cost: '2.00' }] });
    expect(receive.status).toBe(201);
    expect((await post(`/${third.body.data.id}/issue`, { lines: lines([[item, '7']]) }, as('keeper'))).status).toBe(200);
    expect((await ask()).body.error).toMatchObject({ code: 'CONFLICT_STOCK_REQUEST_ALREADY_TOPPED_UP', details: { topUpStatus: 'issued' } });

    const view = await get(`/${original.id}`);
    expect(view.body.data.topUps.map((topUp) => topUp.status)).toEqual(['cancelled', 'rejected', 'issued']);
  });

  test('a top-up goes between the same two outlets', async () => {
    const item = await stocked('1.000');
    const original = await issuedRequest([[item, '5']], [[item, '1']]);
    const res = await post('', { from_outlet_id: storeId, to_outlet_id: poolId, top_up_of_request_id: original.id, lines: lines([[item, '4']]) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_TOP_UP_OUTLETS_MISMATCH');
  });

  test('a request the caller cannot see is not found — unknown, another tenant\'s, or outside their outlets', async () => {
    const item = await stocked('1.000');
    const original = await issuedRequest([[item, '5']], [[item, '1']]);

    expect((await raise([[item, '4']], { top_up_of_request_id: '999999999' })).status).toBe(404);

    // Staff at the pool bar cannot see a bar request, so cannot top it up.
    const pool = await post('', { from_outlet_id: storeId, to_outlet_id: poolId, top_up_of_request_id: original.id, lines: lines([[item, '4']]) }, as('poolOp'));
    expect(pool.status).toBe(404);
    expect(pool.body.error.code).toBe('VALIDATION_STOCK_TRANSFER_REQUEST_NOT_FOUND');

    // Tenant B's manager naming tenant A's request: it simply does not exist for them.
    const [storeB] = await t.trx('pos_outlets').insert({ tenant_id: ctx.b.id, property_id: ctx.b.properties[0].id, code: `B${next()}`.slice(0, 30), name: 'B Store', type: 'store' });
    const [itemB] = await insertStockItem(t.trx, { tenant_id: ctx.b.id, property_id: ctx.b.properties[0].id, name: `B ${next()}`, unit: 'bottle', purchase_cost: '1.00', reorder_level: '0.000' });
    const other = await t.request
      .post('/api/v1/pos/stock/transfer-requests')
      .set('Authorization', `Bearer ${tokenFor(ctx.b.users[0].id, ctx.b)}`)
      .set('Idempotency-Key', `b-${next()}`)
      .send({ from_outlet_id: storeB, to_outlet_id: ctx.b.posOutlets[0].id, top_up_of_request_id: original.id, lines: lines([[itemB, '1']]) });
    expect(other.status).toBe(404);
    expect(await t.trx('stock_transfer_requests').where({ top_up_of_request_id: original.id })).toHaveLength(0);
  });

  test('a malformed top-up id is refused before anything is written', async () => {
    const item = await stocked(null);
    const res = await raise([[item, '1']], { top_up_of_request_id: 'twelve' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_FIELD');
  });
});
