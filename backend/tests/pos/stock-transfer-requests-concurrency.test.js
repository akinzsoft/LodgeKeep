'use strict';

/**
 * Stock transfer requests under real concurrency — separate pooled
 * connections, real committed rows, the harness stock-transfer-concurrency
 * uses (a shared rolled-back transaction cannot prove a lock, and does not
 * roll back a failed inner transaction the way production does).
 *
 * What must hold whatever order the database grants locks in:
 *   - two storekeepers issuing the same request: one issue, one 409, one
 *     set of transfers (CONC-REQ-1);
 *   - an issue racing the requester's cancel: exactly one decision, and
 *     stock moved only if the issue won (CONC-REQ-2);
 *   - two requests issuing the same items in opposite directions neither
 *     deadlock nor lose a leg (CONC-REQ-3);
 *   - an issue racing a direct transfer for the same stock never takes the
 *     source below zero, and a refused issue sends NONE of its lines
 *     (CONC-REQ-4);
 *   - after every race, each transfer is exactly two legs that cancel, and
 *     every outlet's level equals the sum of its own ledger.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertStockItem } = require('../helpers/catalogue');
const { sumQuantity } = require('../../src/shared/quantity');

const BUSINESS_DATE = '2027-09-01';

describe('Stock transfer requests: real concurrency', () => {
  let req;
  let tenantId;
  let propertyId;
  let userId;
  let token;
  let storeId;
  let barId;
  let poolsideId;
  let terminalId;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Request Race Tenant', slug: `request-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `request-race-property-${suffix}`,
      name: 'Transfer Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: BUSINESS_DATE,
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `request-race-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Transfer',
      last_name: 'Manager',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });
    const perms = await db()('permissions')
      .whereIn('permission_key', ['pos.operate', 'pos.manage', 'pos.stock_view', 'pos.stock_manage', 'pos.stock_transfer', 'pos.stock_request'])
      .select('id');
    expect(perms).toHaveLength(6);
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [storeId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'STORE', name: 'Main Store', type: 'store' });
    [barId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'BAR', name: 'Bar', type: 'bar' });
    [poolsideId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'POOL', name: 'Poolside', type: 'poolside' });
    [terminalId] = await db()('pos_terminals').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: barId, device_ref: 'REQUEST-RACE-TERM' });

    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  });

  afterAll(async () => {
    for (const table of [
      'stock_transfer_request_lines', 'stock_transfer_requests', 'stock_movements', 'pos_menu_item_components', 'stock_levels', 'stock_items', 'audit_log', 'idempotency_keys',
      'outbox_events', 'pos_order_settlements', 'pos_order_items', 'pos_orders', 'pos_outlet_menu_items', 'pos_menu_items',
      'pos_terminals', 'pos_outlet_categories', 'pos_menu_categories', 'pos_outlets', 'user_property_access', 'role_permissions',
      'in_app_notifications', 'users', 'roles', 'properties',
    ]) {
      await db()(table).where({ tenant_id: tenantId }).delete();
    }
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  let keyCounter = 0;
  const idemKey = (label) => `request-race-${label}-${(keyCounter += 1)}`;

  async function newItem(name) {
    const [id] = await insertStockItem(db(), { tenant_id: tenantId, property_id: propertyId, name: `${name} ${keyCounter += 1}`, unit: 'bottle', purchase_cost: '3.00' });
    return id;
  }

  /** A real `received` movement plus the level it implies — what recompute would derive. */
  async function seed(outletId, stockItemId, quantity) {
    await db()('stock_movements').insert({
      tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, stock_item_id: stockItemId,
      type: 'received', quantity, unit_cost: '3.00', total_cost: '0.00', business_date: BUSINESS_DATE, reference: 'race seed',
    });
    await db()('stock_levels').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, stock_item_id: stockItemId, current_quantity: quantity });
    await db()('stock_items').where({ id: stockItemId }).update({ current_quantity: quantity });
  }

  function transfer(stockItemId, from, to, quantity) {
    return req
      .post('/api/v1/pos/stock/transfers')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey('transfer'))
      .send({ stock_item_id: stockItemId, from_outlet_id: from, to_outlet_id: to, quantity });
  }

  async function levelOf(outletId, stockItemId) {
    const row = await db()('stock_levels').where({ outlet_id: outletId, stock_item_id: stockItemId }).first('current_quantity');
    return row?.current_quantity ?? '0.000';
  }

  /** The invariants every race must leave behind. */
  async function assertLedgerConsistent(stockItemId) {
    const legs = await db()('stock_movements').where({ stock_item_id: stockItemId, type: 'transfer' });
    const byReference = new Map();
    for (const leg of legs) byReference.set(leg.reference, [...(byReference.get(leg.reference) ?? []), leg]);
    for (const pair of byReference.values()) {
      expect(pair).toHaveLength(2);
      expect(sumQuantity(pair.map((leg) => leg.quantity))).toBe('0.000');
    }
    const levels = await db()('stock_levels').where({ stock_item_id: stockItemId });
    for (const row of levels) {
      const ledger = await db()('stock_movements').where({ stock_item_id: stockItemId, outlet_id: row.outlet_id }).select('quantity');
      expect(row.current_quantity).toBe(sumQuantity(ledger.map((m) => m.quantity)));
    }
    const all = await db()('stock_movements').where({ stock_item_id: stockItemId }).select('quantity');
    expect((await db()('stock_items').where({ id: stockItemId }).first('current_quantity')).current_quantity).toBe(sumQuantity(all.map((m) => m.quantity)));
    return byReference.size;
  }

  function post(path, body) {
    return req.post(`/api/v1/pos/stock/transfer-requests${path}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', idemKey('req')).send(body);
  }

  /** A pending request, raised through the API (committed before any race starts). */
  async function raise(from, to, pairs) {
    const res = await post('', { from_outlet_id: from, to_outlet_id: to, lines: pairs.map(([id, quantity]) => ({ stock_item_id: id, quantity })) });
    expect(res.status).toBe(201);
    return res.body.data.id;
  }
  const issue = (requestId, pairs) => post(`/${requestId}/issue`, { lines: pairs.map(([id, quantity]) => ({ stock_item_id: id, quantity })) });
  const statusOf = async (requestId) => (await db()('stock_transfer_requests').where({ id: requestId }).first('status')).status;

  // -----------------------------------------------------------------------
  // CONC-REQ-1
  // -----------------------------------------------------------------------
  test.each([1, 2, 3])('CONC-REQ-1 (round %i): two storekeepers issue the same request — one issue, one 409, one set of transfers', async () => {
    const coke = await newItem('Coke');
    const fanta = await newItem('Fanta');
    await seed(storeId, coke, '20.000');
    await seed(storeId, fanta, '20.000');
    const requestId = await raise(storeId, barId, [[coke, '6'], [fanta, '4']]);

    const results = await Promise.all([1, 2].map(() => issue(requestId, [[coke, '6'], [fanta, '4']])));
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.status === 409).body.error.code).toBe('CONFLICT_STOCK_TRANSFER_REQUEST_NOT_PENDING');

    expect(await levelOf(storeId, coke)).toBe('14.000');
    expect(await levelOf(barId, fanta)).toBe('4.000');
    expect(await assertLedgerConsistent(coke)).toBe(1);
    expect(await assertLedgerConsistent(fanta)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // CONC-REQ-2
  // -----------------------------------------------------------------------
  test.each([1, 2, 3])('CONC-REQ-2 (round %i): an issue racing a cancel — exactly one decision, stock moved only if the issue won', async () => {
    const item = await newItem('Malt');
    await seed(storeId, item, '10.000');
    const requestId = await raise(storeId, barId, [[item, '5']]);

    const [issued, cancelled] = await Promise.all([issue(requestId, [[item, '5']]), post(`/${requestId}/cancel`, { reason: 'race' })]);
    expect([issued.status, cancelled.status].sort()).toEqual([200, 409]);
    if (issued.status === 200) {
      expect(await statusOf(requestId)).toBe('issued');
      expect(await levelOf(barId, item)).toBe('5.000');
      expect(await assertLedgerConsistent(item)).toBe(1);
    } else {
      expect(await statusOf(requestId)).toBe('cancelled');
      expect(await levelOf(barId, item)).toBe('0.000');
      expect(await assertLedgerConsistent(item)).toBe(0);
    }
  });

  // -----------------------------------------------------------------------
  // CONC-REQ-3
  // -----------------------------------------------------------------------
  test.each([1, 2, 3])('CONC-REQ-3 (round %i): two requests issuing the same items in opposite directions both land — no deadlock', async () => {
    const a = await newItem('Stout');
    const b = await newItem('Cider');
    for (const outlet of [storeId, barId]) {
      await seed(outlet, a, '10.000');
      await seed(outlet, b, '10.000');
    }
    // Opposite directions, and the lines listed in opposite orders.
    const toBar = await raise(storeId, barId, [[a, '3'], [b, '2']]);
    const toStore = await raise(barId, storeId, [[b, '4'], [a, '1']]);

    const results = await Promise.all([issue(toBar, [[b, '2'], [a, '3']]), issue(toStore, [[a, '1'], [b, '4']])]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await levelOf(storeId, a)).toBe('8.000'); // 10 - 3 + 1
    expect(await levelOf(barId, a)).toBe('12.000');
    expect(await levelOf(storeId, b)).toBe('12.000'); // 10 - 2 + 4
    expect(await levelOf(barId, b)).toBe('8.000');
    expect(await assertLedgerConsistent(a)).toBe(2);
    expect(await assertLedgerConsistent(b)).toBe(2);
  });

  // -----------------------------------------------------------------------
  // CONC-REQ-4
  // -----------------------------------------------------------------------
  test.each([1, 2, 3])('CONC-REQ-4 (round %i): an issue racing a direct transfer for the same stock — never below zero, and a refused issue sends none of its lines', async () => {
    const contested = await newItem('Gin');
    const other = await newItem('Tonic');
    await seed(storeId, contested, '10.000');
    await seed(storeId, other, '10.000');
    const requestId = await raise(storeId, barId, [[other, '4'], [contested, '8']]);

    const [issued, direct] = await Promise.all([
      issue(requestId, [[other, '4'], [contested, '8']]),
      req
        .post('/api/v1/pos/stock/transfers')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey('direct'))
        .send({ stock_item_id: contested, from_outlet_id: storeId, to_outlet_id: poolsideId, quantity: '5' }),
    ]);

    if (issued.status === 200) {
      expect(direct.status).toBe(422);
      expect(await levelOf(storeId, contested)).toBe('2.000');
      expect(await levelOf(barId, other)).toBe('4.000');
    } else {
      // The direct transfer locked first; the issue then saw 5 on hand and refused — including the line that could have been sent.
      expect(direct.status).toBe(201);
      expect(issued.status).toBe(422);
      expect(issued.body.error.details.lines.map((line) => line.name)).toEqual([expect.stringContaining('Gin')]);
      expect(await statusOf(requestId)).toBe('pending');
      expect(await levelOf(storeId, other)).toBe('10.000');
      expect(await levelOf(storeId, contested)).toBe('5.000');
    }
    await assertLedgerConsistent(contested);
    await assertLedgerConsistent(other);
  });
});
