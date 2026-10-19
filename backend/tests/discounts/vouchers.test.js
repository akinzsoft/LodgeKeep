'use strict';

/**
 * Vouchers (discounts PR 2). A voucher is an order-level discount a manager creates and a cashier redeems by typing
 * its code. The server prices everything (the cashier sends only the code), consumes a use at settlement under the
 * order lock, and gives it back when the sale is voided or fully refunded.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    refundTransaction: jest.fn(),
    fetchRefund: jest.fn(),
    listRefundsForTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn(),
  };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })),
  };
});

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { managerApproval, setApprovalPin } = require('../helpers/approvals');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');
const { signAccessToken } = require('../../src/auth/tokens');
const paystackModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackModule.__mockAdapter;
const { insertMenuItem } = require('../helpers/catalogue');
const { generateVoucherCode, formatVoucherCode } = require('../../src/shared/voucher-code');

const BUSINESS_DATE = '2027-08-01';

describe('vouchers', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let outlet;
  let otherOutlet;
  let counter = 0;
  const users = {};
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId, tenantId = ctx.a.id, property = propertyId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(property) });
  const as = (userId, tenantId, property) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId, tenantId, property)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId, tenantId, property)}`).set('Idempotency-Key', `vch-${next()}`),
  });

  async function userWithRole(role, { pin = false } = {}) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'Tester', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    if (pin) await setApprovalPin(t.trx, { tenantId: ctx.a.id, userId: id });
    return id;
  }

  async function openTab(userId = users.operator, lines = [[outlet.beer, 2]], outletRow = outlet) {
    const opened = await as(userId).post('/api/v1/pos/orders').send({ outlet_id: outletRow.outletId, terminal_id: outletRow.terminalId, table_label: `V${next()}`.slice(0, 20) });
    expect(opened.status).toBe(201);
    const orderId = opened.body.data.id;
    for (const [menuItemId, quantity] of lines) {
      const added = await as(userId).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: menuItemId, quantity });
      expect(added.status).toBe(200);
    }
    return orderId;
  }

  const createVoucher = (userId, body = {}) => as(userId).post('/api/v1/discounts/vouchers').send({ type: 'percent', value: '10', valid_to: '2030-12-31', ...body });
  async function makeVoucher(body = {}, userId = users.manager) {
    const res = await createVoucher(userId, body);
    expect(res.status).toBe(201);
    return res.body.data;
  }
  const applyVoucher = (userId, orderId, code, extra = {}) => as(userId).post(`/api/v1/pos/orders/${orderId}/voucher`).send({ code, ...extra });
  /** An open tab with `count` single-beer lines, each in its own split group (1..count). */
  async function openSplitTab(count = 2) {
    const orderId = await openTab(users.operator, []);
    for (let group = 1; group <= count; group += 1) {
      const added = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 1 });
      expect(added.status).toBe(200);
    }
    const items = await t.trx('pos_order_items').where({ pos_order_id: orderId }).orderBy('id');
    for (const [index, item] of items.entries()) {
      expect((await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items/${item.id}/split-group`).send({ split_group: index + 1 })).status).toBe(200);
    }
    return orderId;
  }
  const preview = async (userId, orderId) => (await as(userId).get(`/api/v1/pos/orders/${orderId}/settlement-preview`)).body.data;
  const settleCash = (userId, orderId) => as(userId).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }] });
  const voucherRow = (id) => t.trx('vouchers').where({ id }).first();
  const redemption = (voucherId) => t.trx('voucher_redemptions').where({ voucher_id: voucherId }).orderBy('id', 'desc').first();
  const setLimit = (role, percent) => t.trx('discount_limits').insert({ tenant_id: ctx.a.id, property_id: propertyId, role_code: role, max_percent: percent });

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BUSINESS_DATE });
    users.manager = await userWithRole('manager', { pin: true });
    users.admin = await userWithRole('admin', { pin: true });
    users.superAdmin = await userWithRole('super_admin', { pin: true });
    users.operator = await userWithRole('pos_operator');
    users.operator2 = await userWithRole('pos_operator');
    users.cashierNoDiscount = await userWithRole('front_desk');

    const suffix = Date.now().toString(36).slice(-6);
    const mk = async (code, name) => {
      const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `${code}-${suffix}`, name, type: 'bar' });
      const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `${code}-T-${suffix}` });
      const [beer] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `${name} Beer`, category: 'Drinks', price: '100.00' });
      return { outletId, terminalId, beer };
    };
    outlet = await mk('VB', 'Voucher Bar');
    otherOutlet = await mk('VR', 'Voucher Restaurant');
  });

  beforeEach(async () => {
    await flushRateLimitPrefixes(['voucher-user:', 'voucher-ip:']);
    paystack.initializeTransaction.mockReset();
  });

  describe('creating and managing', () => {
    it('a manager creates a voucher: the server generates the code, shown with dashes', async () => {
      const res = await createVoucher(users.manager, { value: '10', note: 'Launch' });
      expect(res.status).toBe(201);
      const v = res.body.data;
      expect(v.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(v).toMatchObject({ type: 'percent', value: '10.00', status: 'active', used_count: 0, max_total_uses: null, valid_from: BUSINESS_DATE, valid_to: '2030-12-31', note: 'Launch', outlet_ids: [] });
      const stored = await voucherRow(v.id);
      expect(stored.code).toBe(v.code.replace(/-/g, '')); // stored normalised
    });

    it('a code in the request is ignored: codes are never chosen by the client', async () => {
      const res = await createVoucher(users.manager, { code: 'MYCODE123456' });
      expect(res.status).toBe(201);
      expect(res.body.data.code.replace(/-/g, '')).not.toBe('MYCODE123456');
    });

    it('writes an audit row', async () => {
      const v = await makeVoucher();
      const audit = await t.trx('audit_log').where({ entity_type: 'vouchers', entity_id: v.id, action: 'voucher_created' }).first();
      expect(audit).toBeDefined();
      expect(String(audit.user_id)).toBe(String(users.manager));
    });

    it('only discount.manage creates, lists or disables: a cashier cannot', async () => {
      expect((await createVoucher(users.operator)).status).toBe(403);
      expect((await as(users.operator).get('/api/v1/discounts/vouchers')).status).toBe(403);
      const v = await makeVoucher();
      expect((await as(users.operator).post(`/api/v1/discounts/vouchers/${v.id}/disable`).send({ reason: 'x' })).status).toBe(403);
    });

    it('lists vouchers with usage, newest first', async () => {
      const a = await makeVoucher();
      const b = await makeVoucher({ max_total_uses: 5 });
      const res = await as(users.manager).get('/api/v1/discounts/vouchers');
      expect(res.status).toBe(200);
      const ids = res.body.data.map((row) => row.id);
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
      expect(res.body.data.find((row) => row.id === b.id)).toMatchObject({ max_total_uses: 5, used_count: 0 });
    });

    it.each([
      ['an unknown type', { type: 'bogus' }],
      ['a negative value', { value: '-5' }],
      ['a zero value', { value: '0' }],
      ['a percent above 100', { value: '101' }],
      ['an exponent', { value: '1e2' }],
      ['a JSON number', { value: 10 }],
      ['three decimals', { value: '10.123' }],
      ['a max_amount of zero', { max_amount: '0' }],
      ['valid_to before valid_from', { valid_from: '2027-09-01', valid_to: '2027-08-01' }],
      ['valid_to in the past', { valid_to: '2027-07-01' }],
      ['a malformed date', { valid_to: '31/12/2030' }],
      ['max_total_uses of 0', { max_total_uses: 0 }],
      ['max_total_uses as text', { max_total_uses: 'many' }],
      ['an outlet that is not this property\'s', { outlet_ids: ['999999999'] }],
      ['a note that is far too long', { note: 'x'.repeat(300) }],
    ])('refuses %s with nothing stored', async (_name, body) => {
      const before = (await t.trx('vouchers').where({ tenant_id: ctx.a.id }).count({ n: '*' }).first()).n;
      const res = await createVoucher(users.manager, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_VOUCHER');
      expect((await t.trx('vouchers').where({ tenant_id: ctx.a.id }).count({ n: '*' }).first()).n).toBe(before);
    });

    it('scopes a voucher to outlets', async () => {
      const v = await makeVoucher({ outlet_ids: [String(outlet.outletId)] });
      expect(v.outlet_ids).toEqual([String(outlet.outletId)]);
      expect(await t.trx('voucher_outlets').where({ voucher_id: v.id })).toHaveLength(1);
    });

    it('disabling needs a reason, is audited, and enabling brings it back', async () => {
      const v = await makeVoucher();
      expect((await as(users.manager).post(`/api/v1/discounts/vouchers/${v.id}/disable`).send({})).status).toBe(400);
      const off = await as(users.manager).post(`/api/v1/discounts/vouchers/${v.id}/disable`).send({ reason: 'Printed in error' });
      expect(off.status).toBe(200);
      expect((await voucherRow(v.id)).status).toBe('disabled');
      expect(await t.trx('audit_log').where({ entity_type: 'vouchers', entity_id: v.id, action: 'voucher_disabled' })).toHaveLength(1);
      const on = await as(users.manager).post(`/api/v1/discounts/vouchers/${v.id}/enable`).send({});
      expect(on.status).toBe(200);
      expect((await voucherRow(v.id)).status).toBe('active');
      expect(await t.trx('audit_log').where({ entity_type: 'vouchers', entity_id: v.id, action: 'voucher_enabled' })).toHaveLength(1);
    });

    it('a voucher is never edited: there is no update route', async () => {
      const v = await makeVoucher();
      expect((await t.request.patch(`/api/v1/discounts/vouchers/${v.id}`).set('Authorization', `Bearer ${tokenFor(users.manager)}`).send({ value: '99' })).status).toBe(404);
    });

    it("another tenant's vouchers are invisible", async () => {
      const v = await makeVoucher();
      const [otherUser] = await t.trx('users').insert({ tenant_id: ctx.b.id, email: `b-${next()}@example.com`, first_name: 'B', last_name: 'M', password_hash: 'x', status: 'active' });
      await t.trx('user_property_access').insert({ tenant_id: ctx.b.id, property_id: ctx.b.properties[0].id, user_id: otherUser, role: 'manager' });
      const list = await as(otherUser, ctx.b.id, ctx.b.properties[0].id).get('/api/v1/discounts/vouchers');
      expect(list.status).toBe(200);
      expect(list.body.data.map((row) => row.id)).not.toContain(v.id);
      const off = await as(otherUser, ctx.b.id, ctx.b.properties[0].id).post(`/api/v1/discounts/vouchers/${v.id}/disable`).send({ reason: 'x' });
      expect(off.status).toBe(404);
    });
  });

  describe("a voucher respects its creator's own discount limit", () => {
    it('a percent voucher above the creator\'s limit is refused (a manager may give 25% by default)', async () => {
      const res = await createVoucher(users.manager, { value: '30' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_VOUCHER_ABOVE_LIMIT');
      expect(res.body.error.details).toMatchObject({ limit: '25.00' });
    });

    it('exactly at the limit is fine, and the cap is remembered', async () => {
      const v = await makeVoucher({ value: '25' });
      expect(v.check_percent_cap).toBe('25.00');
    });

    it('follows the property\'s own limit for the role, not the built-in one', async () => {
      await setLimit('admin', '60.00');
      expect((await createVoucher(users.admin, { value: '60' })).status).toBe(201);
      expect((await createVoucher(users.admin, { value: '61' })).status).toBe(422);
    });

    it('a 100% voucher needs discount.comp, even from someone whose limit is 100', async () => {
      const [roleId] = await t.trx('roles').where({ tenant_id: ctx.a.id, code: 'super_admin' }).pluck('id');
      const [permissionId] = await t.trx('permissions').where({ permission_key: 'discount.comp' }).pluck('id');
      const grant = await t.trx('role_permissions').where({ role_id: roleId, permission_id: permissionId }).first();
      await t.trx('role_permissions').where({ id: grant.id }).delete();
      try {
        const refused = await createVoucher(users.superAdmin, { value: '100', override_limit: true });
        expect(refused.status).toBe(403);
        expect(refused.body.error.code).toBe('FORBIDDEN_VOUCHER_NEEDS_COMP');
      } finally {
        await t.trx('role_permissions').insert({ tenant_id: ctx.a.id, role_id: roleId, permission_id: permissionId });
      }
    });

    it('a 100% voucher needs discount.comp even without the override flag', async () => {
      const [roleId] = await t.trx('roles').where({ tenant_id: ctx.a.id, code: 'super_admin' }).pluck('id');
      const [permissionId] = await t.trx('permissions').where({ permission_key: 'discount.comp' }).pluck('id');
      const grant = await t.trx('role_permissions').where({ role_id: roleId, permission_id: permissionId }).first();
      await t.trx('role_permissions').where({ id: grant.id }).delete();
      try {
        const refused = await createVoucher(users.superAdmin, { value: '100' });
        expect(refused.status).toBe(403);
        expect(refused.body.error.code).toBe('FORBIDDEN_VOUCHER_NEEDS_COMP');
        expect((await createVoucher(users.superAdmin, { value: '99' })).status).toBe(201); // just under: within a super_admin's own 100% limit
      } finally {
        await t.trx('role_permissions').insert({ tenant_id: ctx.a.id, role_id: roleId, permission_id: permissionId });
      }
    });

    it('a 100% voucher by a comp holder is allowed and is not bounded by the check', async () => {
      const v = await makeVoucher({ value: '100', override_limit: true });
      expect(v.check_percent_cap).toBe('100.00');
    });

    it('a percent voucher above the limit is only possible with override_limit, which needs discount.comp', async () => {
      const res = await createVoucher(users.manager, { value: '40', override_limit: true });
      expect(res.status).toBe(201); // a manager holds discount.comp by default
      expect(res.body.data.check_percent_cap).toBe('100.00');
    });

    it('override_limit without discount.comp is refused', async () => {
      const [roleId] = await t.trx('roles').where({ tenant_id: ctx.a.id, code: 'admin' }).pluck('id');
      const [permissionId] = await t.trx('permissions').where({ permission_key: 'discount.comp' }).pluck('id');
      const grant = await t.trx('role_permissions').where({ role_id: roleId, permission_id: permissionId }).first();
      await t.trx('role_permissions').where({ id: grant.id }).delete();
      try {
        const res = await createVoucher(users.admin, { value: '70', override_limit: true });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_VOUCHER_NEEDS_COMP');
      } finally {
        await t.trx('role_permissions').insert({ tenant_id: ctx.a.id, role_id: roleId, permission_id: permissionId });
      }
    });

    it('a fixed voucher is bounded by the check it is used on: it may take off at most the creator\'s limit of that check', async () => {
      const v = await makeVoucher({ type: 'fixed', value: '100' }); // manager: 25% of any check
      expect(v.check_percent_cap).toBe('25.00');
      const small = await openTab(users.operator, [[outlet.beer, 2]]); // 200.00: 100 is 50% of it
      const refused = await applyVoucher(users.operator, small, v.code);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('BUSINESS_RULE_VOUCHER_CHECK_TOO_SMALL');
      const big = await openTab(users.operator, [[outlet.beer, 4]]); // 400.00: 100 is exactly 25%
      expect((await applyVoucher(users.operator, big, v.code)).status).toBe(201);
    });

    it('a fixed voucher made with override_limit is not bounded by the check (up to the check, never below zero)', async () => {
      const v = await makeVoucher({ type: 'fixed', value: '100', override_limit: true });
      const small = await openTab(users.operator, [[outlet.beer, 2]]);
      expect((await applyVoucher(users.operator, small, v.code)).status).toBe(201);
    });

    it('a percent voucher with a max_amount never takes off more than the cap', async () => {
      const v = await makeVoucher({ value: '20', max_amount: '30' });
      const orderId = await openTab(users.operator, [[outlet.beer, 5]]); // 500.00: 20% is 100, capped at 30
      expect((await applyVoucher(users.operator, orderId, v.code)).status).toBe(201);
      const priced = await preview(users.operator, orderId);
      expect(priced.groups[0].discountTotal).toBe('30.00');
    });
  });

  describe('applying a code at the Register', () => {
    it('a cashier types a code: the server prices it, the client sends nothing else', async () => {
      const v = await makeVoucher({ value: '10' });
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      const res = await applyVoucher(users.operator, orderId, v.code, { value: '99', type: 'fixed', amount: '150.00', max_amount: '999' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ kind: 'voucher', scope: 'order', type: 'percent', value: '10.00', status: 'active', amount: '20.00' });
      const priced = await preview(users.operator, orderId);
      expect(priced.groups[0].discountTotal).toBe('20.00');
      expect(priced.groups[0].discounts[0]).toMatchObject({ kind: 'voucher', amount: '20.00' });
    });

    it.each([
      ['lower case', (c) => c.replace(/-/g, '').toLowerCase()],
      ['with spaces', (c) => c.replace(/-/g, ' ')],
      ['padded', (c) => `  ${c}  `],
      ['dashes in other places', (c) => c.replace(/-/g, '').replace(/(.{3})/g, '$1-')],
    ])('accepts a code typed %s', async (_name, transform) => {
      const v = await makeVoucher({ value: '5' });
      const orderId = await openTab();
      const res = await applyVoucher(users.operator, orderId, transform(v.code));
      expect(res.status).toBe(201);
    });

    it('one identical answer for not found, expired, wrong outlet, disabled and used up (a code cannot be probed)', async () => {
      const expired = await makeVoucher({ valid_from: BUSINESS_DATE, valid_to: BUSINESS_DATE });
      await t.trx('vouchers').where({ id: expired.id }).update({ valid_to: '2027-07-31' });
      const wrongOutlet = await makeVoucher({ outlet_ids: [String(otherOutlet.outletId)] });
      const disabled = await makeVoucher();
      await as(users.manager).post(`/api/v1/discounts/vouchers/${disabled.id}/disable`).send({ reason: 'x' });
      const usedUp = await makeVoucher({ max_total_uses: 1 });
      await t.trx('vouchers').where({ id: usedUp.id }).update({ used_count: 1 });
      const future = await makeVoucher({ valid_from: '2027-09-01' });
      const answers = [];
      for (const code of [generateVoucherCode(), expired.code, wrongOutlet.code, disabled.code, usedUp.code, future.code, 'short', '!!!!']) {
        const orderId = await openTab();
        const res = await applyVoucher(users.operator, orderId, code);
        answers.push({ status: res.status, code: res.body.error?.code, message: res.body.error?.message, details: res.body.error?.details ?? null });
      }
      expect(answers[0].status).toBe(422);
      expect(answers[0].code).toBe('BUSINESS_RULE_VOUCHER_INVALID');
      for (const answer of answers) expect(answer).toEqual(answers[0]);
    });

    it('a code that is not text is the same answer, and no voucher row is touched', async () => {
      const orderId = await openTab();
      for (const code of [undefined, null, 12345, {}, ['A']]) {
        const res = await applyVoucher(users.operator, orderId, code);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('BUSINESS_RULE_VOUCHER_INVALID');
      }
    });

    it('is rate-limited per user: after 20 attempts the 21st is 429', async () => {
      const orderId = await openTab();
      let last;
      for (let i = 0; i < 21; i += 1) last = await applyVoucher(users.operator, orderId, generateVoucherCode());
      expect(last.status).toBe(429);
      // Another cashier has their own budget.
      const other = await openTab(users.operator2);
      expect((await applyVoucher(users.operator2, other, generateVoucherCode())).status).toBe(422);
    });

    it('needs discount.apply and the Register permission', async () => {
      const v = await makeVoucher();
      const orderId = await openTab();
      expect((await applyVoucher(users.cashierNoDiscount, orderId, v.code)).status).toBe(403);
    });

    it("someone else's tab cannot be given a voucher by a non-manager (the tab-owner rule)", async () => {
      const v = await makeVoucher();
      const orderId = await openTab(users.operator);
      const res = await applyVoucher(users.operator2, orderId, v.code);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_TAB_NOT_YOURS');
    });

    it('is not stackable with a manual order discount, in either order', async () => {
      const v = await makeVoucher();
      const reason = (await as(users.manager).get('/api/v1/discounts/reasons')).body.data.find((r) => r.code === 'promo');
      const withManual = await openTab();
      const manual = await as(users.operator).post(`/api/v1/pos/orders/${withManual}/discounts`).send({ scope: 'order', type: 'percent', value: '3', reason_id: reason.id });
      expect(manual.status).toBe(201);
      const refused = await applyVoucher(users.operator, withManual, v.code);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('CONFLICT_DISCOUNT_ALREADY_APPLIED');

      const withVoucher = await openTab();
      expect((await applyVoucher(users.operator, withVoucher, v.code)).status).toBe(201);
      const manual2 = await as(users.operator).post(`/api/v1/pos/orders/${withVoucher}/discounts`).send({ scope: 'order', type: 'percent', value: '3', reason_id: reason.id });
      expect(manual2.status).toBe(409);
    });

    it('a second voucher on the same check is refused', async () => {
      const a = await makeVoucher();
      const b = await makeVoucher();
      const orderId = await openTab();
      expect((await applyVoucher(users.operator, orderId, a.code)).status).toBe(201);
      expect((await applyVoucher(users.operator, orderId, b.code)).status).toBe(409);
    });

    it('a fixed voucher that would take the whole check is refused (that is a comp)', async () => {
      const v = await makeVoucher({ type: 'fixed', value: '500', override_limit: true });
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]); // 200.00
      const res = await applyVoucher(users.operator, orderId, v.code);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_DISCOUNT_USE_COMP');
    });

    it('is not available at a supermarket tab through the Register route', async () => {
      const v = await makeVoucher();
      const [martId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `VM-${next()}`.slice(0, 20), name: 'Voucher Mart', type: 'supermarket' });
      const [orderId] = await t.trx('pos_orders').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: martId, status: 'open', opened_by_user_id: users.operator, source: 'staff', table_label: 'M' });
      const res = await applyVoucher(users.operator, orderId, v.code);
      expect([400, 403, 404, 422]).toContain(res.status);
    });

    it('taking a voucher off before settling releases it, with an audit row', async () => {
      const v = await makeVoucher();
      const orderId = await openTab();
      const applied = await applyVoucher(users.operator, orderId, v.code);
      const removed = await as(users.operator).post(`/api/v1/discounts/${applied.body.data.id}/remove`).send({ reason: 'Wrong voucher' });
      expect(removed.status).toBe(200);
      expect((await redemption(v.id)).status).toBe('released');
      expect((await voucherRow(v.id)).used_count).toBe(0);
      expect((await preview(users.operator, orderId)).groups[0].discountTotal).toBeUndefined();
    });

    it("a tenant B manager cannot redeem tenant A's code on their own check: the same generic answer", async () => {
      const v = await makeVoucher();
      const [managerB] = await t.trx('users').insert({ tenant_id: ctx.b.id, email: `bm-${next()}@example.com`, first_name: 'B', last_name: 'M', password_hash: 'x', status: 'active' });
      const propertyB = ctx.b.properties[0].id;
      await t.trx('user_property_access').insert({ tenant_id: ctx.b.id, property_id: propertyB, user_id: managerB, role: 'manager' });
      const [orderB] = await t.trx('pos_orders').insert({ tenant_id: ctx.b.id, property_id: propertyB, outlet_id: ctx.b.posOutlets[0].id, terminal_id: ctx.b.posTerminals[0].id, status: 'open', opened_by_user_id: managerB, source: 'staff', table_label: 'B1' });
      await t.trx('pos_order_items').insert({ tenant_id: ctx.b.id, property_id: propertyB, pos_order_id: orderB, menu_item_id: ctx.b.posMenuItems[0].id, unit_price: '100.00', quantity: 2 });
      const res = await as(managerB, ctx.b.id, propertyB).post(`/api/v1/pos/orders/${orderB}/voucher`).send({ code: v.code });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_VOUCHER_INVALID');
    });
  });

  describe('redeeming at settlement', () => {
    it('a cash settlement consumes one use, freezes the voucher on the sale and writes the audit rows', async () => {
      const v = await makeVoucher({ value: '10', max_total_uses: 3 });
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      await applyVoucher(users.operator, orderId, v.code);
      const settled = await settleCash(users.operator, orderId);
      expect(settled.status).toBe(200);
      expect(settled.body.data.discounts[0].discounts[0]).toMatchObject({ kind: 'voucher', amount: '20.00' });
      expect((await voucherRow(v.id)).used_count).toBe(1);
      const red = await redemption(v.id);
      expect(red).toMatchObject({ status: 'redeemed', amount: '20.00' });
      expect(red.settlement_id).not.toBeNull();
      const frozen = await t.trx('settlement_discounts').where({ settlement_id: red.settlement_id }).first();
      expect(frozen).toMatchObject({ kind: 'voucher', amount: '20.00' });
      expect(await t.trx('audit_log').where({ entity_type: 'vouchers', entity_id: v.id, action: 'voucher_redeemed' })).toHaveLength(1);
    });

    it('the discounted amount is what was charged: the settlement subtotal is net of the voucher', async () => {
      const v = await makeVoucher({ value: '10' });
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      await applyVoucher(users.operator, orderId, v.code);
      const priced = await preview(users.operator, orderId);
      const settled = await settleCash(users.operator, orderId);
      expect(settled.body.data.settlements[0].subtotal).toBe(priced.groups[0].subtotal);
      expect(settled.body.data.settlements[0].subtotal).toBe('180.00');
    });

    it('preview tells the cashier BEFORE any money is taken when the voucher can no longer be used', async () => {
      const v = await makeVoucher();
      const orderId = await openTab();
      await applyVoucher(users.operator, orderId, v.code);
      expect((await preview(users.operator, orderId)).voucherProblem).toBeUndefined();
      await as(users.manager).post(`/api/v1/discounts/vouchers/${v.id}/disable`).send({ reason: 'Misprinted' });
      const after = await preview(users.operator, orderId);
      expect(after.voucherProblem).toMatchObject({ code: 'BUSINESS_RULE_VOUCHER_NO_LONGER_AVAILABLE', reason: 'disabled' });
      expect(after.voucherProblem.message).toMatch(/disabled/i);
      expect(after.voucherProblem.discountId).toBeDefined();
    });

    it('an order without a voucher has the same preview as before (no new keys)', async () => {
      const orderId = await openTab();
      expect(Object.keys(await preview(users.operator, orderId)).sort()).toEqual(['currency', 'groups', 'orderId']);
    });

    it('disabling a voucher already on an open check makes the settle fail with a clear message, not apply silently', async () => {
      const v = await makeVoucher();
      const orderId = await openTab();
      await applyVoucher(users.operator, orderId, v.code);
      await as(users.manager).post(`/api/v1/discounts/vouchers/${v.id}/disable`).send({ reason: 'Misprinted' });
      const settled = await settleCash(users.operator, orderId);
      expect(settled.status).toBe(422);
      expect(settled.body.error.code).toBe('BUSINESS_RULE_VOUCHER_NO_LONGER_AVAILABLE');
      expect(settled.body.error.message).toMatch(/disabled/i);
      expect(settled.body.error.message).toMatch(/remove/i);
      expect((await t.trx('pos_orders').where({ id: orderId }).first()).status).toBe('open');
      expect(await t.trx('pos_order_settlements').where({ pos_order_id: orderId })).toHaveLength(0);
      expect((await voucherRow(v.id)).used_count).toBe(0);
    });

    it('after a failed settle the voucher discount is still removable, and the check then settles at full price', async () => {
      const v = await makeVoucher();
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      const applied = await applyVoucher(users.operator, orderId, v.code);
      await as(users.manager).post(`/api/v1/discounts/vouchers/${v.id}/disable`).send({ reason: 'Misprinted' });
      expect((await settleCash(users.operator, orderId)).status).toBe(422);
      expect((await as(users.operator).post(`/api/v1/discounts/${applied.body.data.id}/remove`).send({ reason: 'Voucher no longer works' })).status).toBe(200);
      const settled = await settleCash(users.operator, orderId);
      expect(settled.status).toBe(200);
      expect(settled.body.data.settlements[0].subtotal).toBe('200.00');
    });

    it('the external terminal case: the failure is caught by the preview before the customer pays, and a failed settle leaves nothing recorded', async () => {
      const v = await makeVoucher({ max_total_uses: 1 });
      const orderId = await openTab();
      await applyVoucher(users.operator, orderId, v.code);
      // Someone else uses the last use first.
      await t.trx('vouchers').where({ id: v.id }).update({ used_count: 1 });
      const checked = await preview(users.operator, orderId);
      expect(checked.voucherProblem).toMatchObject({ reason: 'used_up' });
      const settled = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'terminal', terminal_provider: 'moniepoint', terminal_reference: 'RRN123' }] });
      expect(settled.status).toBe(422);
      expect(settled.body.error.code).toBe('BUSINESS_RULE_VOUCHER_NO_LONGER_AVAILABLE');
      expect(await t.trx('pos_order_settlements').where({ pos_order_id: orderId })).toHaveLength(0);
      expect((await t.trx('pos_orders').where({ id: orderId }).first()).status).toBe('open');
      expect((await t.trx('discounts').where({ pos_order_id: orderId, kind: 'voucher' }).first()).status).toBe('active');
    });

    it('a voucher that expired between applying and settling fails the settle', async () => {
      const v = await makeVoucher({ valid_to: '2027-08-05' });
      const orderId = await openTab();
      await applyVoucher(users.operator, orderId, v.code);
      await t.trx('vouchers').where({ id: v.id }).update({ valid_to: '2027-07-31' });
      expect((await preview(users.operator, orderId)).voucherProblem).toMatchObject({ reason: 'expired' });
      const settled = await settleCash(users.operator, orderId);
      expect(settled.status).toBe(422);
      expect(settled.body.error.message).toMatch(/expired/i);
    });

    it('a room charge also redeems, and fails the same way', async () => {
      const v = await makeVoucher({ max_total_uses: 1 });
      const orderId = await openTab();
      await applyVoucher(users.operator, orderId, v.code);
      await t.trx('vouchers').where({ id: v.id }).update({ status: 'disabled' });
      const settled = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'room_charge', reservation_id: '1', room_charge_auth_method: 'pin' }] });
      expect(settled.status).toBe(422);
      expect(settled.body.error.code).toBe('BUSINESS_RULE_VOUCHER_NO_LONGER_AVAILABLE');
      // Nothing was charged to a folio or recorded, and the cashier was told before asking the guest to sign.
      expect((await preview(users.operator, orderId)).voucherProblem).toMatchObject({ reason: 'disabled' });
      expect(await t.trx('pos_order_settlements').where({ pos_order_id: orderId })).toHaveLength(0);
      expect((await t.trx('pos_orders').where({ id: orderId }).first()).status).toBe('open');
    });

    it('card is not available with a voucher (deferred): the card checkout is refused and so is a card settlement', async () => {
      const v = await makeVoucher();
      const orderId = await openTab();
      await applyVoucher(users.operator, orderId, v.code);
      const checkout = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
      expect(checkout.status).toBe(422);
      expect(checkout.body.error.code).toBe('BUSINESS_RULE_VOUCHER_NOT_ON_CARD');
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      const settled = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'card' }] });
      expect(settled.status).toBe(422);
      expect(settled.body.error.code).toBe('BUSINESS_RULE_VOUCHER_NOT_ON_CARD');
      expect((await voucherRow(v.id)).used_count).toBe(0);
    });

    it('a voucher whose attachment was released cannot be redeemed even if its discount row is still active', async () => {
      const v = await makeVoucher();
      const orderId = await openTab();
      await applyVoucher(users.operator, orderId, v.code);
      await t.trx('voucher_redemptions').where({ voucher_id: v.id }).update({ status: 'released' });
      const settled = await settleCash(users.operator, orderId);
      expect(settled.status).toBe(422);
      expect(settled.body.error.code).toBe('BUSINESS_RULE_VOUCHER_NO_LONGER_AVAILABLE');
      expect((await voucherRow(v.id)).used_count).toBe(0);
    });

    it('a settle that fails for any other reason burns no use', async () => {
      const v = await makeVoucher();
      const orderId = await openTab();
      await applyVoucher(users.operator, orderId, v.code);
      const bad = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }, { method: 'cash' }] });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect((await voucherRow(v.id)).used_count).toBe(0);
      expect((await redemption(v.id)).status).toBe('attached');
    });

    it('a retry with the same Idempotency-Key replays the sale and consumes nothing twice', async () => {
      const v = await makeVoucher({ max_total_uses: 5 });
      const orderId = await openTab();
      await applyVoucher(users.operator, orderId, v.code);
      const key = `vch-replay-${next()}`;
      const send = () => t.request.post(`/api/v1/pos/orders/${orderId}/settle`).set('Authorization', `Bearer ${tokenFor(users.operator)}`).set('Idempotency-Key', key).send({ settlements: [{ method: 'cash' }] });
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect((await voucherRow(v.id)).used_count).toBe(1);
    });

    it('a split check shares one use: the voucher is spread over both groups and counted once', async () => {
      const v = await makeVoucher({ value: '10' });
      const orderId = await openSplitTab(2);
      await applyVoucher(users.operator, orderId, v.code);
      const priced = await preview(users.operator, orderId);
      expect(priced.groups.map((g) => g.discountTotal)).toEqual(['10.00', '10.00']);
      const settled = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash', split_group: 1 }, { method: 'cash', split_group: 2 }] });
      expect(settled.status).toBe(200);
      expect((await voucherRow(v.id)).used_count).toBe(1);
      expect(await t.trx('voucher_redemptions').where({ voucher_id: v.id, status: 'redeemed' })).toHaveLength(1);
    });
  });

  describe('giving the use back', () => {
    async function redeemed(options = {}) {
      const v = await makeVoucher({ value: '10', max_total_uses: 1, ...options });
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      await applyVoucher(users.operator, orderId, v.code);
      const settled = await settleCash(users.operator, orderId);
      expect(settled.status).toBe(200);
      return { v, orderId, settlementId: settled.body.data.settlements[0].id };
    }
    const voidIt = (settlementId, orderId) => {
      return (async () => {
        const approval = await managerApproval(t.request, { token: tokenFor(users.operator), approverUserId: users.manager, action: 'pos.void_settlement', targetId: settlementId });
        return as(users.operator).post(`/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`).set('X-Manager-Approval', approval).send({ reason: 'Customer changed mind' });
      })();
    };

    it('voiding the sale restores the use in the same transaction, reverses the redemption and audits it', async () => {
      const { v, orderId, settlementId } = await redeemed();
      expect((await voucherRow(v.id)).used_count).toBe(1);
      const res = await voidIt(settlementId, orderId);
      expect(res.status).toBe(200);
      expect((await voucherRow(v.id)).used_count).toBe(0);
      expect(await redemption(v.id)).toMatchObject({ status: 'reversed' });
      expect(await t.trx('audit_log').where({ entity_type: 'vouchers', entity_id: v.id, action: 'voucher_redemption_reversed' })).toHaveLength(1);
      // The use is genuinely available again.
      const again = await openTab();
      expect((await applyVoucher(users.operator, again, v.code)).status).toBe(201);
    });

    it('a void that fails restores nothing', async () => {
      const { v, orderId, settlementId } = await redeemed();
      const noApproval = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`).send({ reason: 'x' });
      expect(noApproval.status).toBeGreaterThanOrEqual(400);
      expect((await voucherRow(v.id)).used_count).toBe(1);
      expect((await redemption(v.id)).status).toBe('redeemed');
    });

    it('a second void of the same sale is refused and the count does not go down twice', async () => {
      const { v, orderId, settlementId } = await redeemed({ max_total_uses: 5 });
      await t.trx('vouchers').where({ id: v.id }).update({ used_count: 3 });
      expect((await voidIt(settlementId, orderId)).status).toBe(200);
      expect((await voidIt(settlementId, orderId)).status).toBeGreaterThanOrEqual(400);
      expect((await voucherRow(v.id)).used_count).toBe(2);
    });

    it('never goes below zero', async () => {
      const { v, orderId, settlementId } = await redeemed();
      await t.trx('vouchers').where({ id: v.id }).update({ used_count: 0 });
      expect((await voidIt(settlementId, orderId)).status).toBe(200);
      expect((await voucherRow(v.id)).used_count).toBe(0);
    });

    it('restoring a use after valid_to has passed gives the count back but never makes the voucher valid again', async () => {
      const { v, orderId, settlementId } = await redeemed({ valid_to: '2027-08-10' });
      await t.trx('vouchers').where({ id: v.id }).update({ valid_to: '2027-07-31' }); // time has moved on
      expect((await voidIt(settlementId, orderId)).status).toBe(200);
      const row = await voucherRow(v.id);
      expect(row.used_count).toBe(0);
      expect(String(row.valid_to).slice(0, 10)).toBe('2027-07-31'); // dates untouched
      expect(row.status).toBe('active');
      const again = await openTab();
      expect((await applyVoucher(users.operator, again, v.code)).body.error.code).toBe('BUSINESS_RULE_VOUCHER_INVALID');
    });

    it('restoring a use never re-enables a voucher that was disabled meanwhile', async () => {
      const { v, orderId, settlementId } = await redeemed();
      await as(users.manager).post(`/api/v1/discounts/vouchers/${v.id}/disable`).send({ reason: 'x' });
      expect((await voidIt(settlementId, orderId)).status).toBe(200);
      const row = await voucherRow(v.id);
      expect(row.used_count).toBe(0);
      expect(row.status).toBe('disabled');
    });

    it('a split check gives its use back only when the last of its settlements is voided', async () => {
      const v = await makeVoucher({ value: '10', max_total_uses: 1 });
      const orderId = await openSplitTab(2);
      await applyVoucher(users.operator, orderId, v.code);
      const settled = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash', split_group: 1 }, { method: 'cash', split_group: 2 }] });
      const [first, second] = settled.body.data.settlements.map((row) => row.id);
      expect((await voidIt(first, orderId)).status).toBe(200);
      expect((await voucherRow(v.id)).used_count).toBe(1);
      expect((await redemption(v.id)).status).toBe('redeemed');
      expect((await voidIt(second, orderId)).status).toBe(200);
      expect((await voucherRow(v.id)).used_count).toBe(0);
      expect((await redemption(v.id)).status).toBe('reversed');
    });
  });

  describe('refunds of a Register/QR card payment (#268): the same restore, and a partial refund keeps the sale', () => {
    // A voucher cannot be put on a card sale today (deferred), so the paid-by-card state is built directly: this pins
    // that the refund path restores the use the moment vouchers are ever allowed on card, and that a partial refund
    // does not.
    async function cardSaleWithRedeemedVoucher() {
      const v = await makeVoucher({ value: '10', max_total_uses: 1 });
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      const applied = await applyVoucher(users.operator, orderId, v.code);
      const [paymentId] = await t.trx('payments').insert({
        tenant_id: ctx.a.id, property_id: propertyId, folio_id: null, pos_order_id: orderId, settlement_target: 'pos_register', idempotency_key: `vc-${next()}`,
        provider: 'paystack', provider_reference: `vc-ref-${next()}`, provider_payment_id: `PID${next()}`, amount: '180.00', currency: 'NGN', status: 'CAPTURED', captured_at: new Date(),
      });
      const [settlementId] = await t.trx('pos_order_settlements').insert({
        tenant_id: ctx.a.id, property_id: propertyId, pos_order_id: orderId, method: 'card', tender: 'card', payment_id: paymentId,
        subtotal: '180.00', tax_amount: '0.00', tip_amount: '0.00', service_charge: '0.00', currency: 'NGN', settled_by_user_id: users.operator, settled_at: new Date(),
      });
      await t.trx('settlement_discounts').insert({
        tenant_id: ctx.a.id, property_id: propertyId, settlement_id: settlementId, discount_id: applied.body.data.id, outlet_id: outlet.outletId, scope: 'order', kind: 'voucher',
        type: 'percent', value: '10.00', base_before: '200.00', amount: '20.00', reason_id: applied.body.data.reason_id, reason_name: 'Voucher', applied_by_user_id: users.operator, currency: 'NGN',
      });
      await t.trx('discounts').where({ id: applied.body.data.id }).update({ status: 'applied' });
      await t.trx('vouchers').where({ id: v.id }).update({ used_count: 1 });
      await t.trx('voucher_redemptions').where({ voucher_id: v.id }).update({ status: 'redeemed', settlement_id: settlementId, amount: '20.00' });
      await t.trx('pos_orders').where({ id: orderId }).update({ status: 'settled' });
      return { v, paymentId, settlementId };
    }
    const refund = async (paymentId, amount) => {
      const approval = await managerApproval(t.request, { token: tokenFor(users.manager), approverUserId: users.manager, action: 'pos.refund_payment', targetId: paymentId });
      return as(users.manager).post(`/api/v1/cashiering/payments/${paymentId}/refund`).set('X-Manager-Approval', approval).send({ amount, reason: 'guest returned it' });
    };

    it('a FULL refund voids the sale and gives the use back in the same transaction', async () => {
      const { v, paymentId, settlementId } = await cardSaleWithRedeemedVoucher();
      paystack.refundTransaction.mockResolvedValue({ refundId: 'rf1', status: 'processed' });
      const res = await refund(paymentId, undefined);
      expect(res.status).toBe(201);
      expect((await t.trx('pos_order_settlements').where({ id: settlementId }).first()).voided_at).not.toBeNull();
      expect((await voucherRow(v.id)).used_count).toBe(0);
      expect((await redemption(v.id)).status).toBe('reversed');
    });

    it('a PARTIAL refund keeps the sale, so it does not restore the use', async () => {
      const { v, paymentId, settlementId } = await cardSaleWithRedeemedVoucher();
      paystack.refundTransaction.mockResolvedValue({ refundId: 'rf2', status: 'processed' });
      const res = await refund(paymentId, '10.00');
      expect(res.status).toBe(201);
      expect((await t.trx('pos_order_settlements').where({ id: settlementId }).first()).voided_at).toBeNull();
      expect((await voucherRow(v.id)).used_count).toBe(1);
      expect((await redemption(v.id)).status).toBe('redeemed');
    });

    it('a refund Paystack accepted but had not finished restores the use only when reconciliation later sees it processed', async () => {
      const { v, paymentId } = await cardSaleWithRedeemedVoucher();
      paystack.refundTransaction.mockResolvedValue({ refundId: 'rf3', status: 'pending' });
      const res = await refund(paymentId, undefined);
      expect(res.body.data.status).toBe('PENDING');
      expect((await voucherRow(v.id)).used_count).toBe(1);
      const { reconcileRefundIntent } = require('../../src/modules/cashiering/service');
      const { workerContext } = require('../../src/modules/tenancy');
      paystack.fetchRefund.mockResolvedValue({ status: 'processed', refundId: 'rf3' });
      await reconcileRefundIntent({ context: workerContext({ tenantId: String(ctx.a.id), propertyId: String(propertyId) }), intentId: res.body.data.id, source: 'sweep' });
      expect((await voucherRow(v.id)).used_count).toBe(0);
    });
  });

  describe('reports and receipts', () => {
    it('the Discounts report lists a voucher sale with its code, and counts it as a voucher', async () => {
      const v = await makeVoucher({ value: '10' });
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      await applyVoucher(users.operator, orderId, v.code);
      await settleCash(users.operator, orderId);
      const res = await as(users.manager).get(`/api/v1/discounts/report?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`);
      expect(res.status).toBe(200);
      const line = res.body.data.lines.find((row) => row.voucherCode === v.code);
      expect(line).toMatchObject({ kind: 'voucher', amount: '20.00' });
      expect(res.body.data.byKind.find((row) => row.key === 'voucher')).toMatchObject({ label: 'Vouchers', count: expect.any(Number), total: expect.any(String) });
    });

    it('shift cash-up shows vouchers separately, only when there were some', async () => {
      const opened = await as(users.operator).post('/api/v1/pos/shifts').send({ terminal_id: outlet.terminalId, opening_float: '0.00' });
      expect(opened.status).toBe(201);
      const empty = await as(users.operator).post(`/api/v1/pos/shifts/${opened.body.data.id}/close`).send({ counted_cash: '0.00' });
      expect(empty.body.data.discounts).toBeUndefined();

      const opened2 = await as(users.operator).post('/api/v1/pos/shifts').send({ terminal_id: outlet.terminalId, opening_float: '0.00' });
      const v = await makeVoucher({ value: '10' });
      const orderId = await openTab(users.operator, [[outlet.beer, 2]]);
      await applyVoucher(users.operator, orderId, v.code);
      await settleCash(users.operator, orderId);
      const closed = await as(users.operator).post(`/api/v1/pos/shifts/${opened2.body.data.id}/close`).send({ counted_cash: '180.00' });
      expect(closed.body.data.discounts).toMatchObject({ vouchers: '20.00', voucherCount: 1 });
    });
  });
});
