'use strict';

/**
 * Stock transfers under real concurrency — separate pooled connections,
 * real committed rows, the same harness as stock-concurrency.test.js (a
 * shared rolled-back transaction cannot prove a lock: a session never
 * blocks itself).
 *
 * What must hold whatever order the database grants locks in:
 *   - a transfer never takes its source below zero, even when several race
 *     for the same stock (CONC-TRANSFER-1);
 *   - a transfer racing a sale at the source sees the sale, and the sale is
 *     never blocked (CONC-TRANSFER-2);
 *   - transfers crossing between the same outlets in opposite directions
 *     neither deadlock nor lose a leg (CONC-TRANSFER-3);
 *   - after every race, each transfer is exactly two legs that cancel, and
 *     every outlet's level equals the sum of its own ledger.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');
const { sumQuantity } = require('../../src/shared/quantity');

const BUSINESS_DATE = '2027-09-01';

describe('Stock transfers: real concurrency', () => {
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
    [tenantId] = await db()('tenants').insert({ name: 'Transfer Race Tenant', slug: `transfer-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `transfer-race-property-${suffix}`,
      name: 'Transfer Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: BUSINESS_DATE,
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `transfer-race-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Transfer',
      last_name: 'Manager',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });
    const perms = await db()('permissions')
      .whereIn('permission_key', ['pos.operate', 'pos.manage', 'pos.stock_view', 'pos.stock_manage', 'pos.stock_transfer'])
      .select('id');
    expect(perms).toHaveLength(5);
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [storeId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'STORE', name: 'Main Store', type: 'store' });
    [barId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'BAR', name: 'Bar', type: 'bar' });
    [poolsideId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'POOL', name: 'Poolside', type: 'poolside' });
    [terminalId] = await db()('pos_terminals').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: barId, device_ref: 'TRANSFER-RACE-TERM' });

    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  });

  afterAll(async () => {
    for (const table of [
      'stock_movements', 'pos_menu_item_components', 'stock_levels', 'stock_items', 'audit_log', 'idempotency_keys',
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
  const idemKey = (label) => `transfer-race-${label}-${(keyCounter += 1)}`;

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

  // -----------------------------------------------------------------------
  // CONC-TRANSFER-1
  // -----------------------------------------------------------------------
  test.each([1, 2, 3])('CONC-TRANSFER-1 (round %i): four transfers racing for 10 bottles — exactly two land and the store never goes negative', async () => {
    const itemId = await newItem('Lager');
    await seed(storeId, itemId, '10.000');

    const results = await Promise.all([1, 2, 3, 4].map(() => transfer(itemId, storeId, barId, '4')));
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 201, 422, 422]);
    for (const res of results.filter((r) => r.status === 422)) {
      expect(res.body.error.code).toBe('BUSINESS_RULE_INSUFFICIENT_STOCK_FOR_TRANSFER');
    }

    expect(await levelOf(storeId, itemId)).toBe('2.000');
    expect(await levelOf(barId, itemId)).toBe('8.000');
    expect(await assertLedgerConsistent(itemId)).toBe(2);
  });

  // -----------------------------------------------------------------------
  // CONC-TRANSFER-2
  // -----------------------------------------------------------------------
  test.each([1, 2, 3])('CONC-TRANSFER-2 (round %i): a transfer racing a sale at its source sees the sale; the sale is never blocked', async () => {
    const itemId = await newItem('Wine');
    await seed(barId, itemId, '5.000');
    const [menuItemId] = await insertMenuItem(db(), { tenant_id: tenantId, property_id: propertyId, outlet_id: barId, name: `Glass ${keyCounter}`, category: 'Drinks', price: '10.00' });
    await db()('pos_menu_item_components').insert({ tenant_id: tenantId, property_id: propertyId, menu_item_id: menuItemId, stock_item_id: itemId, quantity: '2.000' });
    const [orderId] = await db()('pos_orders').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: barId, terminal_id: terminalId, opened_by_user_id: userId, table_label: `R${keyCounter}` });
    await db()('pos_order_items').insert({ tenant_id: tenantId, property_id: propertyId, pos_order_id: orderId, menu_item_id: menuItemId, quantity: 1, unit_price: '10.00' });

    const [move, sale] = await Promise.all([
      transfer(itemId, barId, poolsideId, '5'),
      req
        .post(`/api/v1/pos/orders/${orderId}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey('settle'))
        .send({ settlements: [{ method: 'cash' }], stock_override_reason: 'race test' }),
    ]);

    expect(sale.status).toBe(200);
    if (move.status === 201) {
      // The transfer locked first and emptied the bar; the sale then took it negative (allowed for a sale).
      expect(await levelOf(barId, itemId)).toBe('-2.000');
      expect(await levelOf(poolsideId, itemId)).toBe('5.000');
    } else {
      // The sale locked first; the transfer then saw only 3 on hand and refused.
      expect(move.status).toBe(422);
      expect(move.body.error.details.available).toBe('3.000');
      expect(await levelOf(barId, itemId)).toBe('3.000');
      expect(await levelOf(poolsideId, itemId)).toBe('0.000');
    }
    await assertLedgerConsistent(itemId);
  });

  // -----------------------------------------------------------------------
  // CONC-TRANSFER-3
  // -----------------------------------------------------------------------
  test.each([1, 2, 3])('CONC-TRANSFER-3 (round %i): crossing transfers between the same outlets all land, with no deadlock and no lost leg', async () => {
    const itemId = await newItem('Juice');
    await seed(storeId, itemId, '20.000');
    await seed(barId, itemId, '20.000');
    await seed(poolsideId, itemId, '20.000');

    const results = await Promise.all([
      transfer(itemId, storeId, barId, '3'),
      transfer(itemId, barId, storeId, '2'),
      transfer(itemId, poolsideId, barId, '4'),
      transfer(itemId, barId, poolsideId, '1'),
      transfer(itemId, storeId, poolsideId, '5'),
      transfer(itemId, poolsideId, storeId, '6'),
    ]);
    expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201, 201, 201]);

    expect(await levelOf(storeId, itemId)).toBe('20.000'); // -3 +2 -5 +6
    expect(await levelOf(barId, itemId)).toBe('24.000'); // +3 -2 +4 -1
    expect(await levelOf(poolsideId, itemId)).toBe('16.000'); // -4 +1 +5 -6
    expect(await assertLedgerConsistent(itemId)).toBe(6);
  });
});
