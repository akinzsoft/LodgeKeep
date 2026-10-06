'use strict';

/**
 * Manager approvals on REAL pooled connections (the shared-transaction
 * harness cannot prove a rollback or a race — nested transactions there are
 * one session):
 *   1. One approval sent on two simultaneous requests: exactly one is
 *      approved, the other refused; one sale, one `approval_used` row.
 *   2. A gated action that fails rolls its claim back: the approval stays
 *      unused and works on the corrected request.
 *   3. An approver demoted between PIN and use: refused, claim rolled back.
 *   4. Simultaneous wrong PINs are all counted (row lock): 4 refusals, then
 *      the lock — no guess slips past the count.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem } = require('../helpers/catalogue');
const { setApprovalPin, managerApproval, TEST_APPROVAL_PIN } = require('../helpers/approvals');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');

const ROUNDS = 3;

describe('Manager approvals: real connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let managerId;
  let deputyId;
  let cashierId;
  let barId;
  let terminalId;
  let beerId;
  let martId;
  let martItemId;
  let martStockId;
  let counter = 0;
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  const post = (userId, url, approval = null) => {
    const r = req.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `apc-${next()}`);
    return approval ? r.set('X-Manager-Approval', approval) : r;
  };

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Approval Race Tenant', slug: `approval-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({ tenant_id: tenantId, slug: `approval-race-prop-${suffix}`, name: 'Approval Race Property', timezone: 'Africa/Lagos', base_currency: 'NGN', current_business_date: '2027-12-01' });
    const grant = async (code, keys) => {
      const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code, name: code, is_system: true });
      const perms = await db()('permissions').whereIn('permission_key', keys).select('id');
      await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));
    };
    await grant('manager', ['pos.operate', 'pos.manage', 'supermarket.sales', 'supermarket.manage']);
    await grant('pos_operator', ['pos.operate', 'supermarket.sales']);
    await grant('front_desk', ['front_desk.view']);
    const mkUser = async (label, role) => {
      const [id] = await db()('users').insert({ tenant_id: tenantId, email: `${label}-${suffix}@example.com`, password_hash: `$2b$12$${'x'.repeat(53)}`, first_name: label, last_name: 'Race', status: 'active' });
      await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: id, role });
      return id;
    };
    managerId = await mkUser('manager', 'manager');
    deputyId = await mkUser('deputy', 'manager');
    cashierId = await mkUser('cashier', 'pos_operator');
    await setApprovalPin(db(), { tenantId, userId: managerId });
    await setApprovalPin(db(), { tenantId, userId: deputyId });

    [barId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'RBAR', name: 'Race Bar', type: 'bar' });
    [terminalId] = await db()('pos_terminals').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: barId, device_ref: 'RBAR-T' });
    [beerId] = await insertMenuItem(db(), { tenant_id: tenantId, property_id: propertyId, outlet_id: barId, name: 'Race beer', category: 'Race drinks', price: '20.00' });

    [martId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'RMRT', name: 'Race Mart', type: 'supermarket' });
    [martItemId] = await insertMenuItem(db(), { tenant_id: tenantId, property_id: propertyId, outlet_id: martId, name: 'Race biscuit', category: 'Race snacks', price: '10.00' });
    [martStockId] = await db()('stock_items').insert({ tenant_id: tenantId, property_id: propertyId, name: 'Race pack', unit: 'pack', purchase_cost: '4.00' });
    await db()('pos_menu_item_components').insert({ tenant_id: tenantId, property_id: propertyId, menu_item_id: martItemId, stock_item_id: martStockId, quantity: '1.000' });
    await db()('stock_levels').insert({ tenant_id: tenantId, property_id: propertyId, stock_item_id: martStockId, outlet_id: martId, current_quantity: '0.000' });
  });

  afterAll(async () => {
    await db()('auth_events').where({ tenant_id: tenantId }).delete();
    for (const table of [
      'supermarket_sale_lines', 'supermarket_sales', 'supermarket_receipt_sequences', 'stock_movements', 'pos_menu_item_components', 'stock_levels', 'stock_items',
      'audit_log', 'idempotency_keys', 'outbox_events', 'pos_order_settlements', 'pos_order_items', 'pos_orders', 'pos_shifts',
      'pos_outlet_menu_items', 'pos_menu_items', 'pos_terminals', 'pos_outlet_categories', 'pos_menu_categories', 'pos_outlets',
      'in_app_notifications', 'manager_approvals', 'approval_pins', 'user_property_access', 'role_permissions', 'users', 'roles', 'properties',
    ]) {
      await db()(table).where({ tenant_id: tenantId }).delete();
    }
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  beforeEach(() => flushRateLimitPrefixes(['approvals-request:']));

  async function cashSale() {
    const opened = await post(cashierId, '/api/v1/pos/orders').send({ outlet_id: barId, terminal_id: terminalId, table_label: `T${next()}` });
    expect(opened.status).toBe(201);
    const orderId = opened.body.data.id;
    expect((await post(cashierId, `/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: beerId, quantity: 1 })).status).toBe(200);
    const settled = await post(cashierId, `/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }] });
    expect(settled.status).toBe(200);
    return { orderId, settlementId: settled.body.data.settlements[0].id };
  }
  const approve = (action, targetId = null, approverUserId = managerId) => managerApproval(req, { token: tokenFor(cashierId), approverUserId, action, targetId });

  it('CONC-APPROVAL-1: one approval on two simultaneous sales approves exactly one', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const salesBefore = Number((await db()('supermarket_sales').where({ tenant_id: tenantId }).count({ n: '*' }).first()).n);
      const approval = await approve('supermarket.oversell');
      const body = { outlet_id: martId, method: 'cash', confirm_oversell: true, items: [{ menu_item_id: martItemId, quantity: 1 }] };
      const results = await Promise.all([post(cashierId, '/api/v1/supermarket/sales', approval).send(body), post(cashierId, '/api/v1/supermarket/sales', approval).send(body)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 422]);
      expect(results.find((r) => r.status === 422).body.error.code).toBe('VALIDATION_APPROVAL_INVALID');
      expect(Number((await db()('supermarket_sales').where({ tenant_id: tenantId }).count({ n: '*' }).first()).n)).toBe(salesBefore + 1);
      const row = await db()('manager_approvals').where({ tenant_id: tenantId, action: 'supermarket.oversell' }).orderBy('id', 'desc').first();
      expect(row.used_at).not.toBeNull();
      expect((await db()('audit_log').where({ tenant_id: tenantId, entity_type: 'manager_approvals', entity_id: row.id, action: 'approval_used' })).length).toBe(1);
    }
  });

  it('CONC-APPROVAL-2: a void that fails rolls its claim back; the same approval then works', async () => {
    const sale = await cashSale();
    const elsewhere = await cashSale();
    const approval = await approve('pos.void_settlement', sale.settlementId);
    const wrongTab = await post(cashierId, `/api/v1/pos/orders/${elsewhere.orderId}/settlements/${sale.settlementId}/void`, approval).send({ reason: 'Wrong tab' });
    expect(wrongTab.body.error.code).toBe('VALIDATION_SETTLEMENT_NOT_FOUND');
    const row = await db()('manager_approvals').where({ tenant_id: tenantId, action: 'pos.void_settlement', target_id: sale.settlementId }).first();
    expect(row.used_at).toBeNull();
    expect(await db()('audit_log').where({ tenant_id: tenantId, entity_type: 'manager_approvals', entity_id: row.id, action: 'approval_used' }).first()).toBeUndefined();

    const ok = await post(cashierId, `/api/v1/pos/orders/${sale.orderId}/settlements/${sale.settlementId}/void`, approval).send({ reason: 'Right tab' });
    expect(ok.status).toBe(200);
    expect((await db()('manager_approvals').where({ id: row.id }).first()).used_at).not.toBeNull();
  });

  it('CONC-APPROVAL-3: an approver demoted between PIN and use is refused, and the claim is rolled back', async () => {
    const sale = await cashSale();
    const approval = await approve('pos.void_settlement', sale.settlementId, deputyId);
    await db()('user_property_access').where({ tenant_id: tenantId, user_id: deputyId }).update({ role: 'front_desk' });
    try {
      const res = await post(cashierId, `/api/v1/pos/orders/${sale.orderId}/settlements/${sale.settlementId}/void`, approval).send({ reason: 'Demoted' });
      expect(res.body.error.code).toBe('VALIDATION_APPROVAL_INVALID');
      expect((await db()('pos_order_settlements').where({ id: sale.settlementId }).first()).voided_at).toBeNull();
      expect((await db()('manager_approvals').where({ tenant_id: tenantId, approver_user_id: deputyId }).first()).used_at).toBeNull();
    } finally {
      await db()('user_property_access').where({ tenant_id: tenantId, user_id: deputyId }).update({ role: 'manager' });
    }
  });

  it('CONC-APPROVAL-4: six wrong PINs at once are all counted — four refusals, then the lock', async () => {
    const sale = await cashSale();
    await setApprovalPin(db(), { tenantId, userId: deputyId });
    const guess = () =>
      req
        .post('/api/v1/approvals')
        .set('Authorization', `Bearer ${tokenFor(cashierId)}`)
        .send({ action: 'pos.void_settlement', approver_user_id: String(deputyId), pin: '000001', reason: 'Guess', target_id: String(sale.settlementId) });
    const results = await Promise.all(Array.from({ length: 6 }, guess));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([422, 422, 422, 422, 423, 423]);
    const pin = await db()('approval_pins').where({ tenant_id: tenantId, user_id: deputyId }).first();
    expect(pin.locked_until).not.toBeNull();
    // Locked: even the right PIN is refused now.
    const right = await req
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${tokenFor(cashierId)}`)
      .send({ action: 'pos.void_settlement', approver_user_id: String(deputyId), pin: TEST_APPROVAL_PIN, reason: 'Right PIN', target_id: String(sale.settlementId) });
    expect(right.status).toBe(423);
  });
});
