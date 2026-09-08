'use strict';

/**
 * ARCHITECTURE.md §5's "POS tab edit" race, proved under real concurrent
 * connections — the same reasoning `tests/reservations/concurrency.test.js`'s
 * own header gives for why the shared-transaction `useTestApp()` harness
 * cannot prove this: two "concurrent" requests against one transaction are
 * really two savepoints on the same MySQL session, and a session never
 * blocks itself. This file binds the app to the real pooled test
 * connection and seeds real COMMITTED rows instead (cleaned up in
 * `afterAll`), the identical setup RES-5's own file uses.
 *
 * Two races proved here, both under genuinely concurrent connections:
 *
 * 1. Two concurrent settlement attempts against the SAME open tab, under
 *    different idempotency keys (so this proves the row lock itself, not
 *    idempotency replay) — `settleOrder`'s `SELECT ... FOR UPDATE` on
 *    `pos_orders` must serialize them so exactly one succeeds and the
 *    other sees the order already settled, with no double-processing and
 *    no partial write (exactly one settlement row, the order ends up
 *    cleanly `settled`, never corrupted).
 *
 * 2. Two concurrent void requests for the SAME order item — a real bug
 *    this pass's own quality-review step caught: an earlier draft of
 *    `voidOrderItem` read the item's own `voided_at` BEFORE acquiring the
 *    parent order's row lock, so both requests could pass that check
 *    before either wrote, and the second would silently overwrite the
 *    first voider's reason/attribution rather than being rejected. Fixed
 *    by locking the order first and re-checking `voided_at` under that
 *    lock; this test proves exactly one request wins and the recorded
 *    reason is genuinely whichever request the lock let through, never a
 *    value neither request sent.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');

describe('POS tab edit race under real concurrent connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let outletId;
  let terminalId;
  let menuItemId;
  let orderId;
  let userId;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    [tenantId] = await db()('tenants').insert({ name: 'POS Concurrency Tenant', slug: `pos-concurrency-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `pos-concurrency-property-${suffix}`,
      name: 'POS Concurrency Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2027-04-01',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'pos_operator', name: 'pos_operator', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `pos-concurrency-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'POS',
      last_name: 'Operator',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'pos_operator' });

    // pos.operate is migration-seeded globally (20260912097000) — grant, don't create.
    const perms = await db()('permissions').where({ permission_key: 'pos.operate' }).select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [outletId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'RACEBAR', name: 'Race Bar', type: 'bar' });
    [terminalId] = await db()('pos_terminals').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, device_ref: 'RACE-TERM' });
    [menuItemId] = await db()('pos_menu_items').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      outlet_id: outletId,
      name: 'Race Item',
      category: 'Drinks',
      price: '15.00',
    });
    [orderId] = await db()('pos_orders').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      outlet_id: outletId,
      terminal_id: terminalId,
      opened_by_user_id: userId,
      table_label: 'RACE',
    });
    await db()('pos_order_items').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      pos_order_id: orderId,
      menu_item_id: menuItemId,
      quantity: 1,
      unit_price: '15.00',
    });
  });

  afterAll(async () => {
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

  it('exactly one of two truly concurrent settlements on the same tab succeeds; the other sees it already settled, with no partial write', async () => {
    const token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });

    const settle = (key) =>
      req
        .post(`/api/v1/pos/orders/${orderId}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ settlements: [{ method: 'cash' }] });

    const [first, second] = await Promise.all([settle('pos-race-key-1'), settle('pos-race-key-2')]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    expect(winner.body.data.order.status).toBe('settled');
    expect(loser.body.error.code).toBe('CONFLICT_POS_ORDER_NOT_OPEN');

    // No partial write: exactly one settlement row, the order stays cleanly settled.
    const settlementCount = await db()('pos_order_settlements').where({ tenant_id: tenantId, pos_order_id: orderId }).count({ n: '*' }).first();
    expect(Number(settlementCount.n)).toBe(1);

    const order = await db()('pos_orders').where({ id: orderId }).first();
    expect(order.status).toBe('settled');
  });

  it('exactly one of two truly concurrent void requests for the same item succeeds; the audit trail is never silently overwritten', async () => {
    const token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });

    // A fresh order+item, independent of the settled one above — voidOrderItem
    // originally read the item's own `voided_at` BEFORE acquiring the parent
    // order's row lock, so two concurrent voids could both pass that check
    // before either wrote, with the second silently overwriting the first
    // voider's reason/attribution.
    const [raceOrderId] = await db()('pos_orders').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      outlet_id: outletId,
      terminal_id: terminalId,
      opened_by_user_id: userId,
      table_label: 'VOID-RACE',
    });
    const [raceItemId] = await db()('pos_order_items').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      pos_order_id: raceOrderId,
      menu_item_id: menuItemId,
      quantity: 1,
      unit_price: '15.00',
    });

    const voidItem = (reason) =>
      req
        .post(`/api/v1/pos/orders/${raceOrderId}/items/${raceItemId}/void`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason });

    const [first, second] = await Promise.all([voidItem('Reason A'), voidItem('Reason B')]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const winner = first.status === 200 ? first : second;
    expect(second.status === 409 || first.status === 409).toBe(true);

    // The winning reason is exactly whichever request actually won the lock
    // — never a value neither request sent, and never silently blank.
    const item = await db()('pos_order_items').where({ id: raceItemId }).first();
    expect(item.voided_at).not.toBeNull();
    expect(['Reason A', 'Reason B']).toContain(item.void_reason);
    expect(item.void_reason).toBe(winner.body.data.void_reason);

    await db()('pos_order_items').where({ id: raceItemId }).delete();
    await db()('pos_orders').where({ id: raceOrderId }).delete();
  });
});
