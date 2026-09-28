'use strict';

/**
 * Staff tied to outlets (user_outlet_assignments), for stock requests and
 * their alerts. Confirmed with the user: enforced by the server; unassigned
 * staff cover every outlet; manager/admin/super_admin are never limited;
 * "requested" alerts reach the storekeepers at the supplying store, and
 * "sent"/"rejected" reach whoever asked plus the staff at the receiving
 * outlet. Register, Tickets, Sales and Shifts are deliberately untouched.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertStockItem } = require('../helpers/catalogue');

describe('Stock requests tied to staff outlets', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let counter = 0;
  const outlets = {};
  const users = {};

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) =>
    signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });
  const as = (name) => tokenFor(users[name]);

  async function outlet(name, type) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `O${next()}`.slice(0, 30), name, type });
    return id;
  }

  async function staff(role, outletNames = []) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'Test', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    for (const name of outletNames) {
      await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, outlet_id: outlets[name] });
    }
    return id;
  }

  function post(path, token, body) {
    return t.request.post(`/api/v1/pos/stock/transfer-requests${path}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', `o-${next()}`).send(body);
  }
  const get = (path, token) => t.request.get(`/api/v1/pos/stock/transfer-requests${path}`).set('Authorization', `Bearer ${token}`);

  async function stocked(outletName, quantity = '50.000') {
    const [itemId] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: `Item ${next()}`, unit: 'bottle', purchase_cost: '1.00', reorder_level: '0.000' });
    const res = await t.request
      .post('/api/v1/pos/stock/goods-received')
      .set('Authorization', `Bearer ${tokenFor(ctx.a.users[0].id)}`)
      .set('Idempotency-Key', `g-${next()}`)
      .send({ outlet_id: outlets[outletName], lines: [{ stock_item_id: itemId, quantity, unit_cost: '1.00' }] });
    expect(res.status).toBe(201);
    return itemId;
  }

  async function raise(token, from, to, itemId) {
    return post('', token, { from_outlet_id: outlets[from], to_outlet_id: outlets[to], lines: [{ stock_item_id: itemId, quantity: '1' }] });
  }

  const bellCount = async (userId, type, requestId) =>
    (await t.trx('in_app_notifications').where({ user_id: userId, type })).filter((row) => Number((typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload).requestId) === Number(requestId)).length;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-08-01' });
    outlets.bar = ctx.a.posOutlets[0].id;
    outlets.pool = await outlet('Pool Bar', 'poolside');
    outlets.storeA = await outlet('Store A', 'store');
    outlets.storeB = await outlet('Store B', 'store');
    users.manager = ctx.a.users[0].id; // assigned to the bar by the fixture — and never limited
    users.barOp = await staff('pos_operator', ['bar']);
    users.poolOp = await staff('pos_operator', ['pool']);
    users.freeOp = await staff('pos_operator');
    users.keeperA = await staff('storekeeper', ['storeA']);
    users.keeperB = await staff('storekeeper', ['storeB']);
    users.freeKeeper = await staff('storekeeper');
    users.admin = await staff('admin');
  });

  describe('raising', () => {
    test('an assigned POS operator asks for their own outlet only; nothing is written for another', async () => {
      const item = await stocked('storeA');
      expect((await raise(as('barOp'), 'storeA', 'bar', item)).status).toBe(201);

      const before = await t.trx('stock_transfer_requests').count({ n: '*' }).first();
      const refused = await raise(as('barOp'), 'storeA', 'pool', item);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_OUTLET_NOT_ASSIGNED');
      expect(await t.trx('stock_transfer_requests').count({ n: '*' }).first()).toEqual(before);
    });

    test('an unassigned POS operator — everyone today — still asks for any outlet', async () => {
      const item = await stocked('storeA');
      expect((await raise(as('freeOp'), 'storeA', 'pool', item)).status).toBe(201);
      expect((await raise(as('freeOp'), 'storeA', 'bar', item)).status).toBe(201);
    });

    test('a manager is never limited, even with an assignment saved', async () => {
      const item = await stocked('storeA');
      expect((await raise(as('manager'), 'storeA', 'pool', item)).status).toBe(201);
    });
  });

  describe('seeing and deciding', () => {
    test('a limited operator sees only requests to or from their outlets; anyone else\'s is not found', async () => {
      const item = await stocked('storeA');
      const mine = (await raise(as('barOp'), 'storeA', 'bar', item)).body.data;
      const theirs = (await raise(as('poolOp'), 'storeA', 'pool', item)).body.data;

      const listed = (await get('', as('barOp'))).body.data.map((row) => row.id);
      expect(listed).toContain(mine.id);
      expect(listed).not.toContain(theirs.id);
      expect((await get(`/${theirs.id}`, as('barOp'))).status).toBe(404);
      expect((await post(`/${theirs.id}/cancel`, as('barOp'), {})).status).toBe(404);
      expect((await post(`/${mine.id}/cancel`, as('barOp'), {})).status).toBe(200);

      // Unassigned and managers see both.
      for (const who of ['freeOp', 'manager']) {
        const all = (await get('', as(who))).body.data.map((row) => row.id);
        expect(all).toEqual(expect.arrayContaining([theirs.id]));
      }
    });

    test('a storekeeper tied to one store works only that store\'s requests', async () => {
      const itemA = await stocked('storeA');
      const itemB = await stocked('storeB');
      const fromA = (await raise(as('freeOp'), 'storeA', 'bar', itemA)).body.data;
      const fromB = (await raise(as('freeOp'), 'storeB', 'bar', itemB)).body.data;

      const pending = (await get('?status=pending', as('keeperA'))).body.data.map((row) => row.id);
      expect(pending).toContain(fromA.id);
      expect(pending).not.toContain(fromB.id);

      const wrongStore = await post(`/${fromB.id}/issue`, as('keeperA'), { lines: [{ stock_item_id: itemB, quantity: '1' }] });
      expect(wrongStore.status).toBe(404); // not "already decided" or "forbidden" — it is not theirs to see
      expect((await post(`/${fromB.id}/reject`, as('keeperA'), { reason: 'no' })).status).toBe(404);
      expect((await t.trx('stock_transfer_requests').where({ id: fromB.id }).first()).status).toBe('pending');

      expect((await post(`/${fromA.id}/issue`, as('keeperA'), { lines: [{ stock_item_id: itemA, quantity: '1' }] })).status).toBe(200);
      expect((await post(`/${fromB.id}/issue`, as('freeKeeper'), { lines: [{ stock_item_id: itemB, quantity: '1' }] })).status).toBe(200);
    });

    test('my-outlets tells each person what they cover', async () => {
      expect((await get('/my-outlets', as('barOp'))).body.data).toEqual({ restricted: true, outletIds: [String(outlets.bar)] });
      expect((await get('/my-outlets', as('freeOp'))).body.data).toEqual({ restricted: false, outletIds: null });
      expect((await get('/my-outlets', as('manager'))).body.data).toEqual({ restricted: false, outletIds: null });
    });
  });

  describe('who hears about it', () => {
    test('"requested" reaches the storekeepers at the supplying store, not those tied to another store', async () => {
      const item = await stocked('storeA');
      const request = (await raise(as('barOp'), 'storeA', 'bar', item)).body.data;
      expect(await bellCount(users.keeperA, 'stock.transfer_requested', request.id)).toBe(1);
      expect(await bellCount(users.freeKeeper, 'stock.transfer_requested', request.id)).toBe(1);
      expect(await bellCount(users.manager, 'stock.transfer_requested', request.id)).toBe(1);
      expect(await bellCount(users.keeperB, 'stock.transfer_requested', request.id)).toBe(0);
    });

    test('"sent" reaches whoever asked and the staff at the receiving outlet — not operators tied elsewhere', async () => {
      const item = await stocked('storeA');
      const request = (await raise(as('barOp'), 'storeA', 'bar', item)).body.data;
      expect((await post(`/${request.id}/issue`, as('keeperA'), { lines: [{ stock_item_id: item, quantity: '1' }] })).status).toBe(200);
      expect(await bellCount(users.barOp, 'stock.transfer_request_issued', request.id)).toBe(1);
      expect(await bellCount(users.freeOp, 'stock.transfer_request_issued', request.id)).toBe(1);
      expect(await bellCount(users.poolOp, 'stock.transfer_request_issued', request.id)).toBe(0);
    });

    test('whoever asked hears back even when the property turned POS operators off for that alert', async () => {
      await t.trx('notification_role_rules').insert({ tenant_id: ctx.a.id, property_id: propertyId, event_type: 'stock.transfer_request_rejected', role: 'pos_operator', enabled: false });
      const item = await stocked('storeA');
      const request = (await raise(as('barOp'), 'storeA', 'bar', item)).body.data;
      expect((await post(`/${request.id}/reject`, as('keeperA'), { reason: 'Counting' })).status).toBe(200);
      expect(await bellCount(users.barOp, 'stock.transfer_request_rejected', request.id)).toBe(1);
      expect(await bellCount(users.freeOp, 'stock.transfer_request_rejected', request.id)).toBe(0);
    });
  });

  describe('assigning outlets on the Staff screen', () => {
    const put = (userId, body, token) => t.request.put(`/api/v1/users/${userId}/outlets`).set('Authorization', `Bearer ${token}`).send(body);

    test('an admin sets, lists and clears a staff member\'s outlets, and it is audited', async () => {
      const target = await staff('pos_operator');
      const set = await put(target, { outlet_ids: [String(outlets.pool), String(outlets.bar)] }, as('admin'));
      expect(set.status).toBe(200);
      expect([...set.body.data.outlet_ids].sort()).toEqual([String(outlets.bar), String(outlets.pool)].sort());

      const listed = (await t.request.get('/api/v1/users').set('Authorization', `Bearer ${as('admin')}`)).body.data.find((row) => String(row.id) === String(target));
      expect(listed.outlet_ids).toHaveLength(2);

      const cleared = await put(target, { outlet_ids: [] }, as('admin'));
      expect(cleared.body.data.outlet_ids).toEqual([]);
      expect(await t.trx('audit_log').where({ entity_type: 'user_outlet_assignments', entity_id: target, action: 'set_outlets' })).toHaveLength(2);
    });

    test('refuses another tenant\'s outlet, an archived outlet, a bad body, an unknown user and a manager', async () => {
      const target = await staff('pos_operator');
      const foreign = await put(target, { outlet_ids: [String(ctx.b.posOutlets[0].id)] }, as('admin'));
      expect(foreign.status).toBe(400);
      expect(foreign.body.error.code).toBe('VALIDATION_OUTLET_NOT_FOUND');

      const archived = await outlet('Old Bar', 'bar');
      await t.trx('pos_outlets').where({ id: archived }).update({ status: 'archived' });
      expect((await put(target, { outlet_ids: [String(archived)] }, as('admin'))).status).toBe(400);

      expect((await put(target, { outlet_ids: 'bar' }, as('admin'))).status).toBe(400);
      expect((await put('999999999', { outlet_ids: [] }, as('admin'))).status).toBe(404);
      expect((await put(target, { outlet_ids: [] }, as('manager'))).status).toBe(403); // setup.manage only
      expect(await t.trx('user_outlet_assignments').where({ user_id: target })).toHaveLength(0);
    });
  });
});
