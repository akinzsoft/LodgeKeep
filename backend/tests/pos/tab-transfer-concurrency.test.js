'use strict';

/**
 * Tab transfers under real concurrent connections (not the shared test
 * transaction, which cannot show a lock wait or a deadlock). Two managers
 * hand the SAME two tabs to different people at the same time, naming them
 * in opposite orders: `transferTabs` locks every tab in ascending id order,
 * so neither request deadlocks, and because each request is all or nothing
 * the two tabs always end with the same owner.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

describe('tab transfer under real concurrent connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let outletId;
  let terminalId;
  const users = {};

  const token = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    [tenantId] = await db()('tenants').insert({ name: 'Transfer Race Tenant', slug: `transfer-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `transfer-race-property-${suffix}`,
      name: 'Transfer Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2027-04-01',
    });
    const grants = { manager: ['pos.operate', 'pos.manage'], pos_operator: ['pos.operate'] };
    for (const [code, keys] of Object.entries(grants)) {
      const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code, name: code, is_system: true });
      const perms = await db()('permissions').whereIn('permission_key', keys).select('id');
      await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));
    }
    for (const [name, role] of [
      ['managerOne', 'manager'],
      ['managerTwo', 'manager'],
      ['receiverOne', 'pos_operator'],
      ['receiverTwo', 'pos_operator'],
    ]) {
      const [id] = await db()('users').insert({ tenant_id: tenantId, email: `${name}-${suffix}@example.com`, password_hash: `$2b$12$${'x'.repeat(53)}`, first_name: name, last_name: 'Race', status: 'active' });
      await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: id, role });
      users[name] = id;
    }
    [outletId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: `TR-${suffix}`.slice(0, 30), name: 'Race Bar', type: 'bar' });
    [terminalId] = await db()('pos_terminals').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, device_ref: `TR-T-${suffix}` });
  });

  afterAll(async () => {
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('pos_orders').where({ tenant_id: tenantId }).delete();
    await db()('pos_terminals').where({ tenant_id: tenantId }).delete();
    await db()('pos_outlets').where({ tenant_id: tenantId }).delete();
    await db()('user_property_access').where({ tenant_id: tenantId }).delete();
    await db()('role_permissions').where({ tenant_id: tenantId }).delete();
    await db()('in_app_notifications').where({ tenant_id: tenantId }).delete();
    await db()('users').where({ tenant_id: tenantId }).delete();
    await db()('roles').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  async function openTab(label) {
    const res = await req.post('/api/v1/pos/orders').set('Authorization', `Bearer ${token(users.managerOne)}`).send({ outlet_id: outletId, terminal_id: terminalId, table_label: label });
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  it.each([1, 2, 3])('two crossing transfers of the same tabs never deadlock and leave both tabs with one owner (round %i)', async (round) => {
    const first = await openTab(`R${round}-A`);
    const second = await openTab(`R${round}-B`);
    const send = (managerId, orderIds, toUserId) =>
      req.post('/api/v1/pos/orders/transfer').set('Authorization', `Bearer ${token(managerId)}`).send({ order_ids: orderIds, to_user_id: toUserId, reason: 'Shift change' });

    const [one, two] = await Promise.all([send(users.managerOne, [first, second], users.receiverOne), send(users.managerTwo, [second, first], users.receiverTwo)]);
    expect([one.status, two.status]).toEqual([200, 200]);

    const owners = await db()('pos_orders').whereIn('id', [first, second]).pluck('owner_user_id');
    expect(new Set(owners.map(String)).size).toBe(1);
    expect([String(users.receiverOne), String(users.receiverTwo)]).toContain(String(owners[0]));
  });
});
