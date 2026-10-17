'use strict';

/**
 * Discounts on REAL pooled connections (the shared-transaction harness cannot prove a rollback or a race — nested
 * transactions there are one session):
 *   1. One supermarket discount request on two simultaneous sales: exactly one sale takes it.
 *   2. A refused approval (the approver's own limit is too low) rolls its claim back: the token stays unused.
 *   3. Two approvals of one pending discount at once: exactly one wins and the row records that approver.
 *   4. Two order discounts asked for at once on one check: exactly one is created.
 *   5. A sale refused for its discount burns no receipt number.
 *   6. Settling and removing a discount at the same time stay consistent: either the sale carries it, or it was removed.
 */

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem } = require('../helpers/catalogue');
const { setApprovalPin, managerApproval } = require('../helpers/approvals');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');

const ROUNDS = 3;

describe('Discounts: real connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let managerId;
  let adminId;
  let cashierId;
  let barId;
  let terminalId;
  let beerId;
  let martId;
  let riceId;
  let reasonId;
  let counter = 0;
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  const post = (userId, url, approval = null) => {
    const r = req.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `dc-${next()}`);
    return approval ? r.set('X-Manager-Approval', approval) : r;
  };

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Discount Race Tenant', slug: `discount-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({ tenant_id: tenantId, slug: `discount-race-prop-${suffix}`, name: 'Discount Race Property', timezone: 'Africa/Lagos', base_currency: 'NGN', current_business_date: '2027-12-01' });
    const grant = async (code, keys) => {
      const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code, name: code, is_system: true });
      const perms = await db()('permissions').whereIn('permission_key', keys).select('id');
      await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));
    };
    await grant('manager', ['pos.operate', 'pos.manage', 'supermarket.sales', 'supermarket.manage', 'discount.apply', 'discount.approve', 'discount.comp', 'discount.manage']);
    await grant('admin', ['pos.operate', 'pos.manage', 'supermarket.sales', 'supermarket.manage', 'discount.apply', 'discount.approve', 'discount.comp', 'discount.manage']);
    await grant('pos_operator', ['pos.operate', 'supermarket.sales', 'discount.apply']);
    const mkUser = async (label, role) => {
      const [id] = await db()('users').insert({ tenant_id: tenantId, email: `${label}-${suffix}@example.com`, password_hash: `$2b$12$${'x'.repeat(53)}`, first_name: label, last_name: 'Race', status: 'active' });
      await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: id, role });
      return id;
    };
    managerId = await mkUser('manager', 'manager');
    adminId = await mkUser('admin', 'admin');
    cashierId = await mkUser('cashier', 'pos_operator');
    await setApprovalPin(db(), { tenantId, userId: managerId });
    await setApprovalPin(db(), { tenantId, userId: adminId });

    [barId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'DBAR', name: 'Disc Bar', type: 'bar' });
    [terminalId] = await db()('pos_terminals').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: barId, device_ref: 'DBAR-T' });
    [beerId] = await insertMenuItem(db(), { tenant_id: tenantId, property_id: propertyId, outlet_id: barId, name: 'Disc beer', category: 'Disc drinks', price: '100.00' });
    [martId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'DMRT', name: 'Disc Mart', type: 'supermarket' });
    [riceId] = await insertMenuItem(db(), { tenant_id: tenantId, property_id: propertyId, outlet_id: martId, name: 'Disc rice', category: 'Disc grocery', price: '100.00' });
    [reasonId] = await db()('discount_reasons').insert({ tenant_id: tenantId, property_id: propertyId, code: 'promo', name: 'Promotion', kind: 'both' });
  });

  afterAll(async () => {
    await db()('auth_events').where({ tenant_id: tenantId }).delete();
    for (const table of [
      'settlement_discounts', 'discounts', 'discount_limits', 'discount_reasons',
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

  async function openBarTab() {
    const opened = await post(cashierId, '/api/v1/pos/orders').send({ outlet_id: barId, terminal_id: terminalId, table_label: `T${next()}`.slice(0, 20) });
    expect(opened.status).toBe(201);
    expect((await post(cashierId, `/api/v1/pos/orders/${opened.body.data.id}/items`).send({ menu_item_id: beerId, quantity: 2 })).status).toBe(200);
    return opened.body.data.id; // 200.00
  }
  const askOrderDiscount = (orderId, body = {}) => post(cashierId, `/api/v1/pos/orders/${orderId}/discounts`).send({ scope: 'order', type: 'percent', value: '5', reason_id: String(reasonId), ...body });
  const askCartDiscount = (body = {}) =>
    post(cashierId, '/api/v1/supermarket/discounts').send({ outlet_id: martId, items: [{ menu_item_id: riceId, quantity: 2 }], scope: 'order', type: 'percent', value: '5', reason_id: String(reasonId), ...body });
  const sellAtMart = (ids) => post(cashierId, '/api/v1/supermarket/sales').send({ outlet_id: martId, method: 'cash', items: [{ menu_item_id: riceId, quantity: 2 }], discount_ids: ids });
  const approval = (action, targetId, approverUserId) => managerApproval(req, { token: tokenFor(cashierId), approverUserId, action, targetId });
  const approveCall = (id, token) => post(cashierId, `/api/v1/discounts/${id}/approve`, token).send({});

  it('CONC-DISC-1: one request on two simultaneous sales is used by exactly one', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const grant = await askCartDiscount();
      expect(grant.status).toBe(201);
      const salesBefore = Number((await db()('supermarket_sales').where({ tenant_id: tenantId }).count({ n: '*' }).first()).n);
      const results = await Promise.all([sellAtMart([grant.body.data.id]), sellAtMart([grant.body.data.id])]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(results.find((r) => r.status === 422).body.error.code).toBe('VALIDATION_DISCOUNT_GRANT_INVALID');
      expect(Number((await db()('supermarket_sales').where({ tenant_id: tenantId }).count({ n: '*' }).first()).n)).toBe(salesBefore + 1);
      expect(await db()('settlement_discounts').where({ discount_id: grant.body.data.id })).toHaveLength(1);
    }
  });

  it("CONC-DISC-2: a refused approval (the approver's limit is too low) leaves the token unused", async () => {
    const orderId = await openBarTab();
    const created = await askOrderDiscount(orderId, { value: '30' }); // above the manager's 25%
    expect(created.body.data.status).toBe('pending_approval');
    const token = await approval('pos.discount_approval', created.body.data.id, managerId);
    const refused = await approveCall(created.body.data.id, token);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN_APPROVER_NOT_ELIGIBLE');
    const used = await db()('manager_approvals').where({ tenant_id: tenantId, action: 'pos.discount_approval', target_id: String(created.body.data.id) });
    expect(used.every((row) => row.used_at === null)).toBe(true);
    expect((await db()('discounts').where({ id: created.body.data.id }).first()).status).toBe('pending_approval');
    // The admin, whose limit covers it, can still approve.
    const adminToken = await approval('pos.discount_approval', created.body.data.id, adminId);
    expect((await approveCall(created.body.data.id, adminToken)).status).toBe(200);
  });

  it('CONC-DISC-3: two managers approving one pending discount at once: exactly one wins', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const orderId = await openBarTab();
      const created = await askOrderDiscount(orderId, { value: '10' });
      const tokens = [await approval('pos.discount_approval', created.body.data.id, managerId), await approval('pos.discount_approval', created.body.data.id, adminId)];
      const results = await Promise.all(tokens.map((token) => approveCall(created.body.data.id, token)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const row = await db()('discounts').where({ id: created.body.data.id }).first();
      expect(row.status).toBe('active');
      expect([String(managerId), String(adminId)]).toContain(String(row.approved_by_user_id));
    }
  });

  it('CONC-DISC-4: two order discounts asked for at once on one check: exactly one is created', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const orderId = await openBarTab();
      const results = await Promise.all([askOrderDiscount(orderId), askOrderDiscount(orderId, { value: '4' })]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await db()('discounts').where({ pos_order_id: orderId, status: 'active' })).toHaveLength(1);
    }
  });

  it('CONC-DISC-5: a sale refused for its discount burns no receipt number', async () => {
    const first = await sellAtMart([]);
    expect(first.status).toBe(201);
    const pending = await askCartDiscount({ value: '10' }); // above the cashier's 5%: not usable yet
    expect((await sellAtMart([pending.body.data.id])).status).toBe(422);
    const second = await sellAtMart([]);
    expect(second.status).toBe(201);
    expect(Number(second.body.data.receipt_number)).toBe(Number(first.body.data.receipt_number) + 1);
  });

  it('CONC-DISC-6: settling and removing a discount at once stay consistent', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const orderId = await openBarTab();
      const created = await askOrderDiscount(orderId);
      const [settle, remove] = await Promise.all([
        post(cashierId, `/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }] }),
        post(cashierId, `/api/v1/discounts/${created.body.data.id}/remove`).send({ reason: 'racing' }),
      ]);
      expect(settle.status).toBe(200);
      const row = await db()('discounts').where({ id: created.body.data.id }).first();
      const settlement = settle.body.data.settlements[0];
      const frozen = await db()('settlement_discounts').where({ settlement_id: settlement.id });
      if (row.status === 'applied') {
        expect(remove.status).toBe(409);
        expect(frozen).toHaveLength(1);
        expect(settlement.subtotal).toBe('190.00');
      } else {
        expect(row.status).toBe('removed');
        expect(remove.status).toBe(200);
        expect(frozen).toHaveLength(0);
        expect(settlement.subtotal).toBe('200.00');
      }
    }
  });
});
