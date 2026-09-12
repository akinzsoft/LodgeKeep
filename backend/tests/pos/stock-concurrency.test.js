'use strict';

/**
 * Real-concurrency tests for POS inventory & stock control — PLAN.md
 * Phase 6, ARCHITECTURE.md §5. The same discipline
 * `tests/reservations/concurrency.test.js` (RES-5), `tests/pos/concurrency.test.js`,
 * and `tests/ar/concurrency.test.js` all establish: the shared,
 * rolled-back transaction `useTestApp()` harness cannot prove a real lock
 * — two "concurrent" requests against it are really two savepoints on the
 * same MySQL session, and a session never blocks itself. This file binds
 * the app to the REAL POOLED test connection and seeds real COMMITTED
 * rows, cleaned up in `afterAll`.
 *
 * Five races, all serialized by `stock/service.js`'s own shared
 * `lockStockItemsSorted` helper (and, for CONC-STOCK-5, the additional
 * `pos_menu_items` row lock `applyStockAvailabilityEffects` takes AFTER
 * it, in the same global ordering):
 *
 *   1. Two concurrent settlements against the SAME stock item — proves
 *      the lock genuinely serializes the read-recompute-write cycle, not
 *      merely "nothing crashed" (an unlocked race would silently lose one
 *      of the two deductions — see the test's own comment for the exact
 *      mechanism).
 *   2. A settlement touching stock items [A, B] racing a goods-received
 *      batch touching [B, A] (the OPPOSITE natural order) — proves the
 *      ascending-id lock ordering is genuinely identical at both call
 *      sites, the same `ar/service.js` `applyPaymentApplications` fix
 *      this module's own header cites.
 *   3. Two concurrent stock-take completions against the same open take —
 *      exactly one succeeds.
 *   4. A sale settlement racing a stock-take completion against the same
 *      stock item — the take's own `theoretical_quantity` genuinely
 *      reflects whichever committed first, never a stale unlocked read.
 *   5. Two stock items belonging to the SAME menu item's recipe both
 *      independently hit zero via two unrelated concurrent transactions
 *      (one sale, one wastage) — the menu item ends up correctly
 *      unavailable, proving the `pos_menu_items` row lock in
 *      `applyStockAvailabilityEffects`.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

describe('POS inventory & stock: real concurrency', () => {
  let req;
  let tenantId;
  let propertyId;
  let outletId;
  let terminalId;
  let userId;
  let token;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    [tenantId] = await db()('tenants').insert({ name: 'Stock Concurrency Tenant', slug: `stock-concurrency-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `stock-concurrency-property-${suffix}`,
      name: 'Stock Concurrency Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2027-09-01',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `stock-concurrency-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Stock',
      last_name: 'Manager',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });

    // All four keys are migration-seeded globally (20260912097000,
    // 20261001096000) — grant, don't create.
    const perms = await db()('permissions').whereIn('permission_key', ['pos.operate', 'pos.manage', 'pos.stock_view', 'pos.stock_manage']).select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [outletId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'STOCKRACE', name: 'Stock Race Bar', type: 'bar' });
    [terminalId] = await db()('pos_terminals').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, device_ref: 'STOCKRACE-TERM' });

    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  });

  afterAll(async () => {
    await db()('stock_movements').where({ tenant_id: tenantId }).delete();
    await db()('stock_take_lines').where({ tenant_id: tenantId }).delete();
    await db()('stock_takes').where({ tenant_id: tenantId }).delete();
    await db()('pos_menu_item_components').where({ tenant_id: tenantId }).delete();
    await db()('stock_items').where({ tenant_id: tenantId }).delete();
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('idempotency_keys').where({ tenant_id: tenantId }).delete();
    await db()('outbox_events').where({ tenant_id: tenantId }).delete();
    await db()('pos_order_settlements').where({ tenant_id: tenantId }).delete();
    await db()('pos_order_items').where({ tenant_id: tenantId }).delete();
    await db()('pos_orders').where({ tenant_id: tenantId }).delete();
    await db()('pos_menu_items').where({ tenant_id: tenantId }).delete();
    await db()('pos_terminals').where({ tenant_id: tenantId }).delete();
    await db()('pos_outlets').where({ tenant_id: tenantId }).delete();
    await db()('user_property_access').where({ tenant_id: tenantId }).delete();
    await db()('role_permissions').where({ tenant_id: tenantId }).delete();
    await db()('users').where({ tenant_id: tenantId }).delete();
    await db()('roles').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  let keyCounter = 0;
  function idemKey(label) {
    keyCounter += 1;
    return `stock-race-${label}-${keyCounter}`;
  }

  async function createStockItem({ name, purchaseCost = '1.00' }) {
    const [id] = await db()('stock_items').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      outlet_id: outletId,
      name,
      unit: 'ml',
      purchase_cost: purchaseCost,
      current_quantity: '0.000',
    });
    return id;
  }

  /** Seeds a real backing "received" movement AND sets current_quantity to match — the recompute-safe way to give a stock item a real starting baseline (see `stock/service.js`'s own "never independently maintained" rule). */
  async function seedReceipt(stockItemId, quantity, { unitCost = '1.00', businessDate = '2027-09-01' } = {}) {
    await db()('stock_movements').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      outlet_id: outletId,
      stock_item_id: stockItemId,
      type: 'received',
      quantity,
      unit_cost: unitCost,
      total_cost: (Number(unitCost) * Number(quantity)).toFixed(2),
      business_date: businessDate,
      reference: 'Concurrency seed',
    });
    await db()('stock_items').where({ id: stockItemId }).update({ current_quantity: quantity });
  }

  async function createMenuItem({ name, price = '10.00' }) {
    const [id] = await db()('pos_menu_items').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, name, category: 'Drinks', price });
    return id;
  }

  async function linkComponent(menuItemId, stockItemId, quantity) {
    await db()('pos_menu_item_components').insert({ tenant_id: tenantId, property_id: propertyId, menu_item_id: menuItemId, stock_item_id: stockItemId, quantity });
  }

  async function openOrderWithItem(menuItemId, quantity = 1) {
    const [orderId] = await db()('pos_orders').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      outlet_id: outletId,
      terminal_id: terminalId,
      opened_by_user_id: userId,
      table_label: `RACE-${orderCounter()}`,
    });
    await db()('pos_order_items').insert({ tenant_id: tenantId, property_id: propertyId, pos_order_id: orderId, menu_item_id: menuItemId, quantity, unit_price: '10.00' });
    return orderId;
  }

  let orderCounterValue = 0;
  function orderCounter() {
    orderCounterValue += 1;
    return orderCounterValue;
  }

  function settleCash(orderId) {
    return req.post(`/api/v1/pos/orders/${orderId}/settle`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', idemKey('settle')).send({ settlements: [{ method: 'cash' }] });
  }

  // -----------------------------------------------------------------------
  // CONC-STOCK-1
  // -----------------------------------------------------------------------

  it('CONC-STOCK-1: two concurrent settlements each needing 1 unit both succeed; the final quantity is exactly -1, never 0', async () => {
    const stockItemId = await createStockItem({ name: 'Race Item 1' });
    await seedReceipt(stockItemId, '1.000');
    const menuItemId = await createMenuItem({ name: 'Race Menu 1' });
    await linkComponent(menuItemId, stockItemId, '1.000');

    const orderA = await openOrderWithItem(menuItemId);
    const orderB = await openOrderWithItem(menuItemId);

    const [resA, resB] = await Promise.all([settleCash(orderA), settleCash(orderB)]);
    // Deduction is never blocked (this session's confirmed decision) —
    // BOTH settlements succeed regardless of the resulting balance.
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const item = await db()('stock_items').where({ id: stockItemId }).first();
    // If the lock did not genuinely serialize the read-recompute-write
    // cycle, each transaction could establish its own REPEATABLE READ
    // snapshot of `stock_movements` before seeing the other's insert, and
    // whichever commits last would overwrite `current_quantity` with a
    // sum that silently drops the other's own -1 deduction — landing on
    // 0, not -1. The genuine, fully-serialized answer is -1.
    expect(item.current_quantity).toBe('-1.000');

    const soldCount = await db()('stock_movements').where({ stock_item_id: stockItemId, type: 'sold' }).count({ n: '*' }).first();
    expect(Number(soldCount.n)).toBe(2);
  });

  // -----------------------------------------------------------------------
  // CONC-STOCK-2
  // -----------------------------------------------------------------------

  it('CONC-STOCK-2: a settlement locking [A, B] and a goods-received batch locking [B, A] never deadlock', async () => {
    const stockItemAId = await createStockItem({ name: 'Race Item A (2)' });
    const stockItemBId = await createStockItem({ name: 'Race Item B (2)' });
    // Guaranteed A < B by insertion order — the goods-received request
    // below deliberately lists them in the OPPOSITE order.
    expect(Number(stockItemAId)).toBeLessThan(Number(stockItemBId));

    await seedReceipt(stockItemAId, '100.000');
    await seedReceipt(stockItemBId, '100.000');

    const menuItemId = await createMenuItem({ name: 'Race Menu 2' });
    await linkComponent(menuItemId, stockItemAId, '1.000');
    await linkComponent(menuItemId, stockItemBId, '1.000');
    const orderId = await openOrderWithItem(menuItemId);

    const goodsReceived = () =>
      req
        .post('/api/v1/pos/stock/goods-received')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey('goods'))
        .send({
          outlet_id: outletId,
          // Deliberately B THEN A — the opposite of ascending id order.
          lines: [
            { stock_item_id: stockItemBId, quantity: '5.000', unit_cost: '1.00' },
            { stock_item_id: stockItemAId, quantity: '5.000', unit_cost: '1.00' },
          ],
        });

    const [settleRes, goodsRes] = await Promise.all([settleCash(orderId), goodsReceived()]);
    expect(settleRes.status).toBe(200);
    expect(goodsRes.status).toBe(201);

    const soldA = await db()('stock_movements').where({ stock_item_id: stockItemAId, type: 'sold' }).first();
    const soldB = await db()('stock_movements').where({ stock_item_id: stockItemBId, type: 'sold' }).first();
    expect(soldA).toBeDefined();
    expect(soldB).toBeDefined();
    // Every movement from both real requests genuinely committed —
    // neither side was silently lost to a deadlock rollback.
    const totalMovements = await db()('stock_movements').whereIn('stock_item_id', [stockItemAId, stockItemBId]).count({ n: '*' }).first();
    expect(Number(totalMovements.n)).toBe(6); // 2 seed receipts + 2 sold + 2 goods-received.
  });

  // -----------------------------------------------------------------------
  // CONC-STOCK-3
  // -----------------------------------------------------------------------

  it('CONC-STOCK-3: two concurrent completions of the same open stock take — exactly one succeeds', async () => {
    const stockItemId = await createStockItem({ name: 'Race Item 3' });
    await seedReceipt(stockItemId, '50.000');

    const [stockTakeId] = await db()('stock_takes').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, opened_by_user_id: userId });
    await db()('stock_take_lines').insert({ tenant_id: tenantId, property_id: propertyId, stock_take_id: stockTakeId, stock_item_id: stockItemId, counted_quantity: '45.000' });

    const complete = () =>
      req.post(`/api/v1/pos/stock/takes/${stockTakeId}/complete`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', idemKey('complete')).send({});

    const [resA, resB] = await Promise.all([complete(), complete()]);
    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const failure = resA.status === 409 ? resA : resB;
    expect(failure.body.error.code).toBe('CONFLICT_STOCK_TAKE_ALREADY_COMPLETED');

    const adjustmentCount = await db()('stock_movements').where({ stock_take_id: stockTakeId, type: 'count_adjustment' }).count({ n: '*' }).first();
    expect(Number(adjustmentCount.n)).toBe(1);

    const stockTake = await db()('stock_takes').where({ id: stockTakeId }).first();
    expect(stockTake.status).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // CONC-STOCK-4
  // -----------------------------------------------------------------------

  it('CONC-STOCK-4: a sale settlement racing a stock-take completion on the same item resolves to one genuinely self-consistent outcome', async () => {
    const stockItemId = await createStockItem({ name: 'Race Item 4' });
    await seedReceipt(stockItemId, '100.000');

    const menuItemId = await createMenuItem({ name: 'Race Menu 4' });
    await linkComponent(menuItemId, stockItemId, '10.000');
    const orderId = await openOrderWithItem(menuItemId);

    const [stockTakeId] = await db()('stock_takes').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, opened_by_user_id: userId });
    await db()('stock_take_lines').insert({ tenant_id: tenantId, property_id: propertyId, stock_take_id: stockTakeId, stock_item_id: stockItemId, counted_quantity: '90.000' });

    const complete = () =>
      req.post(`/api/v1/pos/stock/takes/${stockTakeId}/complete`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', idemKey('complete4')).send({});

    const [settleRes, completeRes] = await Promise.all([settleCash(orderId), complete()]);
    expect(settleRes.status).toBe(200);
    expect(completeRes.status).toBe(200);

    const line = await db()('stock_take_lines').where({ stock_take_id: stockTakeId, stock_item_id: stockItemId }).first();
    const theoretical = line.theoretical_quantity;
    expect(['100.000', '90.000']).toContain(theoretical);

    const finalItem = await db()('stock_items').where({ id: stockItemId }).first();
    if (theoretical === '100.000') {
      // The stock take's own lock won first — it saw the real, true
      // PRE-sale baseline (100), posted a real -10 count_adjustment, and
      // the sale's own -10 deduction landed on top of that afterward:
      // 100 - 10 (adjustment) - 10 (sale) = 80.
      expect(line.variance).toBe('-10.000');
      expect(finalItem.current_quantity).toBe('80.000');
    } else {
      // The sale's own lock won first — the stock take's later read
      // correctly saw the ALREADY-deducted, genuinely current value (90),
      // exactly matching the count, so no adjustment was needed at all.
      expect(line.variance).toBe('0.000');
      expect(finalItem.current_quantity).toBe('90.000');
    }
  });

  // -----------------------------------------------------------------------
  // CONC-STOCK-5
  // -----------------------------------------------------------------------

  it('CONC-STOCK-5: two components of the same menu item independently hit zero via unrelated concurrent transactions — the item ends up correctly unavailable', async () => {
    const stockItemAId = await createStockItem({ name: 'Race Item A (5)' });
    const stockItemBId = await createStockItem({ name: 'Race Item B (5)' });
    await seedReceipt(stockItemAId, '1.000');
    await seedReceipt(stockItemBId, '1.000');

    // The menu item under test — depends on BOTH A and B.
    const menuItemId = await createMenuItem({ name: 'Race Menu 5' });
    await linkComponent(menuItemId, stockItemAId, '1.000');
    await linkComponent(menuItemId, stockItemBId, '1.000');

    // A SEPARATE menu item that depends ONLY on A, so a real sale can
    // deplete A alone without touching B in the same transaction —
    // genuinely independent from the wastage event on B below.
    const soloMenuItemId = await createMenuItem({ name: 'Race Menu 5 (A only)' });
    await linkComponent(soloMenuItemId, stockItemAId, '1.000');
    const soloOrderId = await openOrderWithItem(soloMenuItemId);

    const wasteB = () =>
      req
        .post(`/api/v1/pos/stock/items/${stockItemBId}/wastage`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey('waste5'))
        .send({ quantity: '1.000', reason: 'Concurrency test spill' });

    const [settleRes, wasteRes] = await Promise.all([settleCash(soloOrderId), wasteB()]);
    expect(settleRes.status).toBe(200);
    expect(wasteRes.status).toBe(200);

    const itemA = await db()('stock_items').where({ id: stockItemAId }).first();
    const itemB = await db()('stock_items').where({ id: stockItemBId }).first();
    expect(itemA.current_quantity).toBe('0.000');
    expect(itemB.current_quantity).toBe('0.000');

    const menuItem = await db()('pos_menu_items').where({ id: menuItemId }).first();
    expect(menuItem.is_available).toBe(0);
    expect(menuItem.stock_auto_unavailable).toBe(1);
  });

  // -----------------------------------------------------------------------
  // CONC-STOCK-6
  // -----------------------------------------------------------------------

  it('CONC-STOCK-6: two components of the same auto-unavailable menu item are independently restocked via unrelated concurrent transactions — the item ends up correctly reactivated', async () => {
    // The mirror-image race of CONC-STOCK-5: a code-review-caught bug fix
    // (`applyStockAvailabilityEffects`'s own sibling-component read used to
    // be a plain, non-locking SELECT) meant one of two concurrent restocks
    // could see the OTHER restock's own component as still-zero — a stale
    // REPEATABLE READ snapshot, not the real, already-committed value —
    // and wrongly leave the item disabled. The fix locks every component
    // of every affected menu item, sorted ascending, BEFORE any
    // pos_menu_items row, so both transactions' final reads are genuinely
    // fresh regardless of which one commits first.
    const stockItemAId = await createStockItem({ name: 'Race Item A (6)' });
    const stockItemBId = await createStockItem({ name: 'Race Item B (6)' });
    // Both start at zero — the menu item is already auto-disabled.
    await seedReceipt(stockItemAId, '0.000');
    await seedReceipt(stockItemBId, '0.000');

    const menuItemId = await createMenuItem({ name: 'Race Menu 6' });
    await linkComponent(menuItemId, stockItemAId, '1.000');
    await linkComponent(menuItemId, stockItemBId, '1.000');
    await db()('pos_menu_items').where({ id: menuItemId }).update({ is_available: false, stock_auto_unavailable: true });

    const receiveA = () =>
      req
        .post('/api/v1/pos/stock/goods-received')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey('receiveA6'))
        .send({ outlet_id: outletId, reference: 'Race delivery A', lines: [{ stock_item_id: stockItemAId, quantity: '5.000', unit_cost: '1.00' }] });
    const receiveB = () =>
      req
        .post('/api/v1/pos/stock/goods-received')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey('receiveB6'))
        .send({ outlet_id: outletId, reference: 'Race delivery B', lines: [{ stock_item_id: stockItemBId, quantity: '5.000', unit_cost: '1.00' }] });

    const [resA, resB] = await Promise.all([receiveA(), receiveB()]);
    // Goods-received always creates a movement — 201, matching CONC-STOCK-2's
    // own assertion for the identical endpoint.
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    const itemA = await db()('stock_items').where({ id: stockItemAId }).first();
    const itemB = await db()('stock_items').where({ id: stockItemBId }).first();
    expect(itemA.current_quantity).toBe('5.000');
    expect(itemB.current_quantity).toBe('5.000');

    // Both components are genuinely positive now — the menu item must be
    // reactivated regardless of which of the two concurrent deliveries
    // happened to commit last.
    const menuItem = await db()('pos_menu_items').where({ id: menuItemId }).first();
    expect(menuItem.is_available).toBe(1);
    expect(menuItem.stock_auto_unavailable).toBe(0);
  });
});
