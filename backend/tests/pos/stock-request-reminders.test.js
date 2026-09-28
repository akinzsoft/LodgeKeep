'use strict';

/**
 * The sign-in reminder of pending stock requests (user-requested: a pending
 * request pops up once each time the storekeeper signs in, until it is
 * issued, rejected or withdrawn). `GET /pos/stock/transfer-requests/awaiting-me`
 * answers "which requests are waiting on me": the same people the "Stock
 * requested" alert reaches — their role is on the property's recipient list
 * (Setup → Notifications) and they cover the SUPPLYING outlet.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertStockItem } = require('../helpers/catalogue');

describe('Pending stock requests awaiting me', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let counter = 0;
  const outlets = {};
  const users = {};
  const requests = {};

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId, tenant = ctx.a) =>
    signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const awaiting = (userId, tenant) =>
    t.request.get('/api/v1/pos/stock/transfer-requests/awaiting-me').set('Authorization', `Bearer ${tokenFor(userId, tenant)}`);
  const ids = (res) => res.body.data.map((row) => row.id);

  async function outlet(name, type) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `W${next()}`.slice(0, 30), name, type });
    return id;
  }

  async function staff(role, outletIds = []) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'Test', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    for (const outletId of outletIds) await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, outlet_id: outletId });
    return id;
  }

  async function raise(from, to, itemId) {
    const res = await t.request
      .post('/api/v1/pos/stock/transfer-requests')
      .set('Authorization', `Bearer ${tokenFor(ctx.a.users[0].id)}`)
      .set('Idempotency-Key', `w-${next()}`)
      .send({ from_outlet_id: from, to_outlet_id: to, lines: [{ stock_item_id: itemId, quantity: '1' }] });
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    // The fixture's own pending request is not part of this story.
    await t.trx('stock_transfer_requests').where({ tenant_id: ctx.a.id }).update({ status: 'cancelled' });
    outlets.bar = ctx.a.posOutlets[0].id;
    outlets.storeA = await outlet('Store A', 'store');
    outlets.storeB = await outlet('Store B', 'store');
    const [itemId] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: `Item ${next()}`, unit: 'bottle', purchase_cost: '1.00', reorder_level: '0.000' });

    users.keeper = await staff('storekeeper');
    users.keeperA = await staff('storekeeper', [outlets.storeA]);
    users.operator = await staff('pos_operator', [outlets.bar]);

    requests.fromA = await raise(outlets.storeA, outlets.bar, itemId);
    requests.fromB = await raise(outlets.storeB, outlets.bar, itemId);
    requests.toA = await raise(outlets.storeB, outlets.storeA, itemId); // delivered TO store A, supplied by B
    requests.cancelled = await raise(outlets.storeA, outlets.bar, itemId);
    requests.rejected = await raise(outlets.storeA, outlets.bar, itemId);
    await t.trx('stock_transfer_requests').where({ id: requests.cancelled }).update({ status: 'cancelled' });
    await t.trx('stock_transfer_requests').where({ id: requests.rejected }).update({ status: 'rejected' });
  });

  test('an unassigned storekeeper is reminded of every pending request, oldest first — never a decided one', async () => {
    const res = await awaiting(users.keeper);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([requests.fromA, requests.fromB, requests.toA]);
    expect(res.body.data[0]).toMatchObject({ status: 'pending', fromOutlet: { name: 'Store A' }, toOutlet: { id: String(outlets.bar) } });
  });

  test('a storekeeper tied to one store is reminded only of requests that store supplies', async () => {
    expect(ids(await awaiting(users.keeperA))).toEqual([requests.fromA]);
  });

  test('a manager is on the default recipient list and is never limited', async () => {
    expect(ids(await awaiting(ctx.a.users[0].id))).toEqual([requests.fromA, requests.fromB, requests.toA]);
  });

  test('a role the property switched off for "Stock requested" is not reminded', async () => {
    await t.trx('notification_role_rules').insert({ tenant_id: ctx.a.id, property_id: propertyId, event_type: 'stock.transfer_requested', role: 'storekeeper', enabled: false });
    try {
      const res = await awaiting(users.keeper);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    } finally {
      await t.trx('notification_role_rules').where({ tenant_id: ctx.a.id, event_type: 'stock.transfer_requested', role: 'storekeeper' }).delete();
    }
  });

  test('a request resolved since is no longer a reminder', async () => {
    await t.trx('stock_transfer_requests').where({ id: requests.fromB }).update({ status: 'issued' });
    try {
      expect(ids(await awaiting(users.keeper))).toEqual([requests.fromA, requests.toA]);
    } finally {
      await t.trx('stock_transfer_requests').where({ id: requests.fromB }).update({ status: 'pending' });
    }
  });

  test('someone who cannot issue stock is refused; another tenant sees none of these', async () => {
    expect((await awaiting(users.operator)).status).toBe(403);
    const other = await awaiting(ctx.b.users[0].id, ctx.b);
    expect(other.status).toBe(200);
    const mine = Object.values(requests);
    expect(ids(other).filter((id) => mine.includes(id))).toEqual([]);
    expect(other.body.data.every((row) => row.fromOutlet.name !== 'Store A' && row.fromOutlet.name !== 'Store B')).toBe(true);
  });
});
