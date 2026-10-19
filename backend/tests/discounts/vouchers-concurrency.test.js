'use strict';

/**
 * Vouchers on REAL pooled connections (the shared-transaction harness cannot prove a race or a rollback: its nested
 * transactions are one session):
 *   CONC-VCH-1  a single-use voucher on N checks, all settled at the same moment: exactly one wins, the rest are
 *               refused with nothing written and stay open and removable.
 *   CONC-VCH-2  a voucher with 3 uses and 8 checks: exactly 3 win, `used_count` never passes the limit.
 *   CONC-VCH-3  one check settled twice at once (a double tap, different keys): one settlement, one use.
 *   CONC-VCH-4  N supermarket sales, each with its own request for one single-use voucher: exactly one wins.
 *   CONC-VCH-5  a use handed back by a void racing the next redemption: the count always equals the standing redemptions.
 *   CONC-VCH-6  the same code typed on N checks at once all attach (advisory), but still only one can settle.
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

describe('Vouchers: real connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let managerId;
  let cashierId;
  let barId;
  let terminalId;
  let beerId;
  let martId;
  let riceId;
  let counter = 0;
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  const post = (userId, url) => req.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `vc-${next()}`);

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Voucher Race Tenant', slug: `voucher-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({ tenant_id: tenantId, slug: `voucher-race-prop-${suffix}`, name: 'Voucher Race Property', timezone: 'Africa/Lagos', base_currency: 'NGN', current_business_date: '2027-12-01' });
    const grant = async (code, keys) => {
      const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code, name: code, is_system: true });
      const perms = await db()('permissions').whereIn('permission_key', keys).select('id');
      await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));
    };
    await grant('manager', ['pos.operate', 'pos.manage', 'supermarket.sales', 'supermarket.manage', 'discount.apply', 'discount.approve', 'discount.comp', 'discount.manage']);
    await grant('pos_operator', ['pos.operate', 'supermarket.sales', 'discount.apply']);
    const mkUser = async (label, role) => {
      const [id] = await db()('users').insert({ tenant_id: tenantId, email: `${label}-${suffix}@example.com`, password_hash: `$2b$12$${'x'.repeat(53)}`, first_name: label, last_name: 'Race', status: 'active' });
      await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: id, role });
      return id;
    };
    managerId = await mkUser('manager', 'manager');
    cashierId = await mkUser('cashier', 'pos_operator');
    await setApprovalPin(db(), { tenantId, userId: managerId });

    [barId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'VBAR', name: 'Voucher Bar', type: 'bar' });
    [terminalId] = await db()('pos_terminals').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: barId, device_ref: 'VBAR-T' });
    [beerId] = await insertMenuItem(db(), { tenant_id: tenantId, property_id: propertyId, outlet_id: barId, name: 'Voucher beer', category: 'Voucher drinks', price: '100.00' });
    [martId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'VMRT', name: 'Voucher Mart', type: 'supermarket' });
    [riceId] = await insertMenuItem(db(), { tenant_id: tenantId, property_id: propertyId, outlet_id: martId, name: 'Voucher rice', category: 'Voucher grocery', price: '100.00' });
  });

  afterAll(async () => {
    await db()('auth_events').where({ tenant_id: tenantId }).delete();
    for (const table of [
      'voucher_redemptions', 'voucher_outlets', 'vouchers', 'settlement_discounts', 'discounts', 'discount_limits', 'discount_reasons',
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

  beforeEach(() => flushRateLimitPrefixes(['voucher-user:', 'voucher-ip:', 'approvals-request:']));

  async function makeVoucher(body = {}) {
    const res = await post(managerId, '/api/v1/discounts/vouchers').send({ type: 'percent', value: '10', valid_to: '2030-12-31', ...body });
    expect(res.status).toBe(201);
    return res.body.data;
  }
  async function barCheckWith(code) {
    const opened = await post(cashierId, '/api/v1/pos/orders').send({ outlet_id: barId, terminal_id: terminalId, table_label: `V${next()}`.slice(0, 20) });
    expect(opened.status).toBe(201);
    const orderId = opened.body.data.id;
    expect((await post(cashierId, `/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: beerId, quantity: 2 })).status).toBe(200);
    if (code) expect((await post(cashierId, `/api/v1/pos/orders/${orderId}/voucher`).send({ code })).status).toBe(201);
    return orderId;
  }
  const settle = (orderId) => post(cashierId, `/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }] });
  const voucher = (id) => db()('vouchers').where({ id }).first();
  const standing = (voucherId) => db()('voucher_redemptions').where({ voucher_id: voucherId, status: 'redeemed' });

  it('CONC-VCH-1: a single-use voucher on 6 checks settled at once: exactly one wins, the rest write nothing and stay open', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const v = await makeVoucher({ max_total_uses: 1 });
      const orders = [];
      for (let i = 0; i < 6; i += 1) orders.push(await barCheckWith(v.code));
      const results = await Promise.all(orders.map(settle));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const losers = results.filter((r) => r.status !== 200);
      expect(losers.map((r) => r.status)).toEqual(Array(5).fill(422));
      expect(new Set(losers.map((r) => r.body.error.code))).toEqual(new Set(['BUSINESS_RULE_VOUCHER_NO_LONGER_AVAILABLE']));
      expect((await voucher(v.id)).used_count).toBe(1);
      expect(await standing(v.id)).toHaveLength(1);
      const losingOrders = orders.filter((id, index) => results[index].status !== 200);
      for (const orderId of losingOrders) {
        expect((await db()('pos_orders').where({ id: orderId }).first()).status).toBe('open');
        expect(await db()('pos_order_settlements').where({ pos_order_id: orderId })).toHaveLength(0);
        expect((await db()('discounts').where({ pos_order_id: orderId, kind: 'voucher' }).first()).status).toBe('active');
      }
    }
  });

  it('CONC-VCH-2: a voucher with 3 uses and 8 checks settled at once: exactly 3 win and the count never passes the limit', async () => {
    const v = await makeVoucher({ max_total_uses: 3 });
    const orders = [];
    for (let i = 0; i < 8; i += 1) orders.push(await barCheckWith(v.code));
    const results = await Promise.all(orders.map(settle));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 422)).toHaveLength(5);
    expect((await voucher(v.id)).used_count).toBe(3);
    expect(await standing(v.id)).toHaveLength(3);
  });

  it('CONC-VCH-3: one check settled twice at once under different keys: one settlement, one use', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const v = await makeVoucher({ max_total_uses: 5 });
      const orderId = await barCheckWith(v.code);
      const results = await Promise.all([settle(orderId), settle(orderId)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect((await voucher(v.id)).used_count).toBe(1);
      expect(await db()('pos_order_settlements').where({ pos_order_id: orderId })).toHaveLength(1);
    }
  });

  it('CONC-VCH-4: 5 supermarket sales, each with its own request for a single-use voucher: exactly one wins, no gap in receipts', async () => {
    const v = await makeVoucher({ max_total_uses: 1 });
    const grants = [];
    for (let i = 0; i < 5; i += 1) {
      const grant = await post(cashierId, '/api/v1/supermarket/voucher').send({ outlet_id: martId, items: [{ menu_item_id: riceId, quantity: 2 }], code: v.code });
      expect(grant.status).toBe(201);
      grants.push(grant.body.data.id);
    }
    const sell = (id) => post(cashierId, '/api/v1/supermarket/sales').send({ outlet_id: martId, method: 'cash', items: [{ menu_item_id: riceId, quantity: 2 }], discount_ids: [id] });
    const results = await Promise.all(grants.map(sell));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422)).toHaveLength(4);
    expect((await voucher(v.id)).used_count).toBe(1);
    // A refused sale burns no receipt number.
    const sales = await db()('supermarket_sales').where({ tenant_id: tenantId }).orderBy('receipt_number');
    expect(sales.map((s) => Number(s.receipt_number))).toEqual(sales.map((_, index) => Number(sales[0].receipt_number) + index));
  });

  it('CONC-VCH-5: a void giving a use back, racing the next redemption: the count always equals the standing redemptions', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const v = await makeVoucher({ max_total_uses: 1 });
      // Both checks carry the code before the first is settled (the check at typing time is advisory).
      const first = await barCheckWith(v.code);
      const second = await barCheckWith(v.code);
      const settled = await settle(first);
      expect(settled.status).toBe(200);
      const settlementId = settled.body.data.settlements[0].id;
      const approval = await managerApproval(req, { token: tokenFor(cashierId), approverUserId: managerId, action: 'pos.void_settlement', targetId: settlementId });
      const [voided, redeemed] = await Promise.all([
        post(cashierId, `/api/v1/pos/orders/${first}/settlements/${settlementId}/void`).set('X-Manager-Approval', approval).send({ reason: 'race' }),
        settle(second),
      ]);
      expect(voided.status).toBe(200);
      // Either order of the two is fine, but the books must agree and the limit must hold.
      const row = await voucher(v.id);
      expect(row.used_count).toBeLessThanOrEqual(1);
      expect(row.used_count).toBe((await standing(v.id)).length);
      expect([200, 422]).toContain(redeemed.status);
      expect(row.used_count).toBe(redeemed.status === 200 ? 1 : 0);
    }
  });

  it('CONC-VCH-6: the same code typed on 6 checks at once all attach (the check is advisory) and still only one can settle', async () => {
    const v = await makeVoucher({ max_total_uses: 1 });
    const orders = [];
    for (let i = 0; i < 6; i += 1) orders.push(await barCheckWith(null));
    const attached = await Promise.all(orders.map((orderId) => post(cashierId, `/api/v1/pos/orders/${orderId}/voucher`).send({ code: v.code })));
    expect(attached.every((r) => r.status === 201)).toBe(true);
    const results = await Promise.all(orders.map(settle));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await voucher(v.id)).used_count).toBe(1);
  });

  it('CONC-VCH-7: different vouchers typed on different checks at the same moment all attach: no 500s from lock collisions', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const orders = [];
      const codes = [];
      for (let i = 0; i < 6; i += 1) {
        orders.push(await barCheckWith(null));
        codes.push((await makeVoucher({ max_total_uses: 1 })).code);
      }
      const attached = await Promise.all(orders.map((orderId, index) => post(cashierId, `/api/v1/pos/orders/${orderId}/voucher`).send({ code: codes[index] })));
      expect(attached.map((r) => r.status)).toEqual(Array(6).fill(201));
      const settled = await Promise.all(orders.map(settle));
      expect(settled.map((r) => r.status)).toEqual(Array(6).fill(200));
    }
  });

  it('CONC-VCH-8: a settlement of one check and a voucher typed on another at the same moment both succeed', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const a = await makeVoucher({ max_total_uses: 1 });
      const b = await makeVoucher({ max_total_uses: 1 });
      const first = await barCheckWith(a.code);
      const second = await barCheckWith(null);
      const [settled, attached] = await Promise.all([settle(first), post(cashierId, `/api/v1/pos/orders/${second}/voucher`).send({ code: b.code })]);
      expect(settled.status).toBe(200);
      expect(attached.status).toBe(201);
    }
  });

  it('CONC-VCH-9: manual discounts requested on different checks at the same moment (the PR 1 path) do not collide either', async () => {
    const reasons = (await post(managerId, '/api/v1/discounts/reasons').send({ code: `conc${next()}`.slice(0, 30), name: 'Conc reason', kind: 'both' })).body.data;
    for (let round = 0; round < ROUNDS; round += 1) {
      const orders = [];
      for (let i = 0; i < 6; i += 1) orders.push(await barCheckWith(null));
      const asked = await Promise.all(orders.map((orderId) => post(cashierId, `/api/v1/pos/orders/${orderId}/discounts`).send({ scope: 'order', type: 'percent', value: '3', reason_id: String(reasons.id) })));
      expect(asked.map((r) => r.status)).toEqual(Array(6).fill(201));
    }
  });
});
