'use strict';

/**
 * Discounts and comps on the POS Register (PR 1). The server prices everything: a request names a scope, a type, a
 * value and a reason, and a discount comes off the item base BEFORE tax, so VAT and the service charge follow the
 * discounted amount. Above a role's limit, and every comp, a manager approves with their PIN, bound to that exact row.
 * A decided discount is immutable.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    refundTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    createSubaccount: jest.fn(),
    resolveBankAccount: jest.fn(),
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
const { signAccessToken } = require('../../src/auth/tokens');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const { insertMenuItem } = require('../helpers/catalogue');

const BUSINESS_DATE = '2027-08-01';

describe('discounts and comps on the Register', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let outlet;
  let counter = 0;
  const users = {};
  let reasons;

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId, tenantId = ctx.a.id, property = propertyId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(property) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', `disc-${next()}`),
    put: (url) => t.request.put(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    patch: (url) => t.request.patch(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
  });

  async function userWithRole(role, { pin = false } = {}) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'Tester', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    if (pin) await setApprovalPin(t.trx, { tenantId: ctx.a.id, userId: id });
    return id;
  }

  async function openTab(userId = users.operator, lines = [[outlet.beer, 1], [outlet.snack, 1]]) {
    const opened = await as(userId).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `D${next()}`.slice(0, 20) });
    expect(opened.status).toBe(201);
    const orderId = opened.body.data.id;
    for (const [menuItemId, quantity] of lines) {
      const added = await as(userId).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: menuItemId, quantity });
      expect(added.status).toBe(200);
    }
    return orderId;
  }

  const requestDiscount = (userId, orderId, body) => as(userId).post(`/api/v1/pos/orders/${orderId}/discounts`).send({ reason_id: reasons.complaint, scope: 'order', type: 'percent', value: '5', ...body });
  const preview = async (userId, orderId) => (await as(userId).get(`/api/v1/pos/orders/${orderId}/settlement-preview`)).body.data;
  const approve = async (requesterId, approverId, discountId) => {
    const token = await managerApproval(t.request, { token: tokenFor(requesterId), approverUserId: approverId, action: 'pos.discount_approval', targetId: discountId });
    return as(requesterId).post(`/api/v1/discounts/${discountId}/approve`).set('X-Manager-Approval', token).send({});
  };
  const settleCash = (userId, orderId, extra = {}) => as(userId).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash', ...extra }] });
  const discountRow = (id) => t.trx('discounts').where({ id }).first();

  beforeEach(() => {
    paystack.initializeTransaction.mockReset();
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay/x', accessCode: 'x-access', reference }));
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
  });

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BUSINESS_DATE });
    users.manager = await userWithRole('manager', { pin: true });
    users.admin = await userWithRole('admin', { pin: true });
    users.superAdmin = await userWithRole('super_admin', { pin: true });
    users.operator = await userWithRole('pos_operator');
    users.operator2 = await userWithRole('pos_operator');

    const suffix = Date.now().toString(36).slice(-6);
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `DS-${suffix}`, name: 'Discount Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `DS-T-${suffix}` });
    const [beer] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Disc Beer', category: 'Drinks', price: '100.00' });
    const [snack] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Disc Snack', category: 'Drinks', price: '40.00' });
    outlet = { outletId, terminalId, beer, snack };

    const list = await as(users.manager).get('/api/v1/discounts/reasons');
    expect(list.status).toBe(200);
    reasons = Object.fromEntries(list.body.data.map((reason) => [reason.code, String(reason.id)]));
  });

  describe('reasons', () => {
    test('a property gets the default reasons the first time it lists them, even if it already had one of its own', () => {
      expect(Object.keys(reasons)).toEqual(expect.arrayContaining(['complaint', 'damaged_goods', 'managers_gift', 'promo', 'staff_meal']));
    });

    test('an operator can read the reasons but not change them; a manager can add one, a duplicate code is refused', async () => {
      expect((await as(users.operator).get('/api/v1/discounts/reasons')).status).toBe(200);
      expect((await as(users.operator).post('/api/v1/discounts/reasons').send({ code: 'vip', name: 'VIP guest', kind: 'discount' })).status).toBe(403);
      const created = await as(users.manager).post('/api/v1/discounts/reasons').send({ code: 'vip', name: 'VIP guest', kind: 'discount' });
      expect(created.status).toBe(201);
      const dup = await as(users.manager).post('/api/v1/discounts/reasons').send({ code: 'vip', name: 'Again', kind: 'discount' });
      expect(dup.status).toBe(409);
      expect((await t.trx('audit_log').where({ entity_type: 'discount_reasons', action: 'create' })).length).toBeGreaterThan(0);
    });

    test('an archived reason cannot be used, and a comp-only reason cannot back a plain discount', async () => {
      const created = await as(users.manager).post('/api/v1/discounts/reasons').send({ code: `old_${next()}`.slice(0, 30), name: 'Old reason', kind: 'discount' });
      await as(users.manager).patch(`/api/v1/discounts/reasons/${created.body.data.id}`).send({ status: 'archived' });
      const orderId = await openTab();
      const archived = await requestDiscount(users.operator, orderId, { reason_id: String(created.body.data.id) });
      expect(archived.status).toBe(400);
      expect(archived.body.error.code).toBe('VALIDATION_INVALID_DISCOUNT_REASON');
      const compOnly = await requestDiscount(users.operator, orderId, { reason_id: reasons.staff_meal });
      expect(compOnly.status).toBe(400);
      expect(compOnly.body.error.code).toBe('VALIDATION_INVALID_DISCOUNT_REASON');
      const missing = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/discounts`).send({ scope: 'order', type: 'percent', value: '5' });
      expect(missing.status).toBe(400);
    });
  });

  describe('role limits', () => {
    test('defaults are 5 / 25 / 50 / 100 and a manager can change one', async () => {
      const list = await as(users.operator).get('/api/v1/discounts/limits');
      expect(Object.fromEntries(list.body.data.map((row) => [row.role, row.max_percent]))).toEqual({ pos_operator: '5.00', manager: '25.00', admin: '50.00', super_admin: '100.00' });
      expect((await as(users.operator).put('/api/v1/discounts/limits/pos_operator').send({ max_percent: '9' })).status).toBe(403);
      const bad = await as(users.manager).put('/api/v1/discounts/limits/pos_operator').send({ max_percent: '101' });
      expect(bad.status).toBe(400);
      expect((await as(users.manager).put('/api/v1/discounts/limits/waiter').send({ max_percent: '5' })).status).toBe(400);
      const set = await as(users.manager).put('/api/v1/discounts/limits/pos_operator').send({ max_percent: '8' });
      expect(set.status).toBe(200);
      const orderId = await openTab();
      const eight = await requestDiscount(users.operator, orderId, { value: '8' });
      expect(eight.body.data.status).toBe('active');
      await as(users.manager).put('/api/v1/discounts/limits/pos_operator').send({ max_percent: '5' });
      const audit = await t.trx('audit_log').where({ entity_type: 'discount_limits', action: 'set_limit' });
      expect(audit.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('pricing: VAT and the service charge follow the discounted amount', () => {
    test('an order discount within the limit is active at once and the preview, settlement and cash-up use the discounted net', async () => {
      const orderId = await openTab(); // 100.00 + 40.00 = 140.00
      const before = await preview(users.operator, orderId);
      expect(before.groups[0]).toEqual({ splitGroup: null, subtotal: '140.00', taxAmount: '10.50', serviceCharge: '10.50', total: '161.00' });
      expect(before.groups[0].discountTotal).toBeUndefined(); // no discount: the shape is unchanged

      const created = await requestDiscount(users.operator, orderId, { value: '5' });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ status: 'active', amount: '7.00', approvalRequired: false });

      const after = await preview(users.operator, orderId);
      // 140.00 - 7.00 = 133.00; VAT 7.5% = 9.98 (9.975 half-up); service 7.5% of 133.00 = 9.98
      expect(after.groups[0]).toMatchObject({ subtotal: '133.00', taxAmount: '9.98', serviceCharge: '9.98', total: '152.96', gross: '140.00', discountTotal: '7.00' });
      expect(after.groups[0].discounts).toEqual([expect.objectContaining({ kind: 'discount', scope: 'order', reason: 'Customer complaint', amount: '7.00' })]);

      const settled = await settleCash(users.operator, orderId);
      expect(settled.status).toBe(200);
      const settlement = settled.body.data.settlements[0];
      expect(settlement).toMatchObject({ subtotal: '133.00', tax_amount: '9.98', service_charge: '9.98' });
      expect(settled.body.data.discounts[0]).toMatchObject({ gross: '140.00', discountTotal: '7.00' });

      const frozen = await t.trx('settlement_discounts').where({ settlement_id: settlement.id });
      expect(frozen).toHaveLength(1);
      expect(frozen[0]).toMatchObject({ kind: 'discount', scope: 'order', type: 'percent', amount: '7.00', base_before: '140.00', reason_name: 'Customer complaint' });
      expect(String(frozen[0].applied_by_user_id)).toBe(String(users.operator));
      expect((await discountRow(created.body.data.id)).status).toBe('applied');
    });

    test('a checkout without any discount is exactly what it always was (no discount keys at all)', async () => {
      const orderId = await openTab();
      const settled = await settleCash(users.operator, orderId);
      expect(settled.body.data.discounts).toBeUndefined();
      expect(Object.keys(settled.body.data).sort()).toEqual(['order', 'settlements']);
      expect(await t.trx('settlement_discounts').where({ settlement_id: settled.body.data.settlements[0].id })).toHaveLength(0);
    });

    test('a line discount applies to that line only; a line and an order discount stack in that order', async () => {
      const orderId = await openTab();
      const items = (await as(users.operator).get(`/api/v1/pos/orders/${orderId}`)).body.data.items;
      const beerLine = items.find((item) => String(item.menu_item_id) === String(outlet.beer));
      const line = await requestDiscount(users.operator, orderId, { scope: 'line', item_id: String(beerLine.id), type: 'fixed', value: '4' });
      expect(line.body.data).toMatchObject({ status: 'active', amount: '4.00' });
      const order = await requestDiscount(users.operator, orderId, { value: '5' });
      // After the line discount: 136.00; 5% of that is 6.80
      expect(order.body.data.amount).toBe('6.80');
      const view = await preview(users.operator, orderId);
      expect(view.groups[0]).toMatchObject({ gross: '140.00', discountTotal: '10.80', subtotal: '129.20' });
    });

    test('a client-sent amount, total or percent is never read', async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, { value: '5', amount: '139.00', total: '1.00', discount_amount: '139.00' });
      expect(created.body.data.amount).toBe('7.00');
      expect((await preview(users.operator, orderId)).groups[0].discountTotal).toBe('7.00');
    });
  });

  describe('input validation', () => {
    test.each([
      ['negative', { value: '-5' }],
      ['exponent', { value: '1e1' }],
      ['three decimals', { value: '1.005' }],
      ['separator', { value: '1,0' }],
      ['a JSON number', { value: 5 }],
      ['zero', { value: '0' }],
      ['text', { value: 'abc' }],
      ['percent above 100', { value: '100.01' }],
      ['unknown type', { type: 'bogus' }],
      ['unknown scope', { scope: 'basket' }],
      ['unknown kind', { kind: 'gift' }],
    ])('refuses %s with 400 and writes nothing', async (_label, body) => {
      const orderId = await openTab();
      const res = await requestDiscount(users.operator, orderId, body);
      expect(res.status).toBe(400);
      expect(await t.trx('discounts').where({ pos_order_id: orderId })).toHaveLength(0);
    });

    test('a fixed discount larger than the check is refused (use a comp), and a 100% discount must be a comp', async () => {
      const orderId = await openTab(users.manager);
      const tooBig = await requestDiscount(users.manager, orderId, { type: 'fixed', value: '500' });
      expect(tooBig.status).toBe(422);
      expect(tooBig.body.error.code).toBe('BUSINESS_RULE_DISCOUNT_USE_COMP');
      const hundred = await requestDiscount(users.manager, orderId, { type: 'percent', value: '100' });
      expect(hundred.status).toBe(422);
      expect(hundred.body.error.code).toBe('BUSINESS_RULE_DISCOUNT_USE_COMP');
      expect(await t.trx('discounts').where({ pos_order_id: orderId })).toHaveLength(0);
    });

    test('an empty check has nothing to discount', async () => {
      const opened = await as(users.operator).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `E${next()}`.slice(0, 20) });
      const res = await requestDiscount(users.operator, opened.body.data.id, {});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_NOTHING_TO_DISCOUNT');
    });

    test('only one order discount per check and one per line', async () => {
      const orderId = await openTab();
      expect((await requestDiscount(users.operator, orderId, {})).status).toBe(201);
      const second = await requestDiscount(users.operator, orderId, {});
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('CONFLICT_DISCOUNT_ALREADY_APPLIED');
      const items = (await as(users.operator).get(`/api/v1/pos/orders/${orderId}`)).body.data.items;
      const line = await requestDiscount(users.operator, orderId, { scope: 'line', item_id: String(items[0].id) });
      expect(line.status).toBe(201);
      expect((await requestDiscount(users.operator, orderId, { scope: 'line', item_id: String(items[0].id) })).status).toBe(409);
    });

    test('a line from another check cannot be discounted here', async () => {
      const mine = await openTab();
      const other = await openTab(users.operator, [[outlet.beer, 1]]);
      const otherItem = (await as(users.operator).get(`/api/v1/pos/orders/${other}`)).body.data.items[0];
      const res = await requestDiscount(users.operator, mine, { scope: 'line', item_id: String(otherItem.id) });
      expect(res.status).toBe(400);
      expect(await t.trx('discounts').where({ pos_order_id: mine })).toHaveLength(0);
    });
  });

  describe('approval', () => {
    test('above the limit the discount waits, is not priced, and a manager PIN approval activates it', async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, { value: '10' });
      expect(created.body.data).toMatchObject({ status: 'pending_approval', approvalRequired: true, approvalAction: 'pos.discount_approval' });
      expect((await preview(users.operator, orderId)).groups[0].discountTotal).toBeUndefined();

      const withoutToken = await as(users.operator).post(`/api/v1/discounts/${created.body.data.id}/approve`).send({});
      expect(withoutToken.status).toBe(403);
      expect(withoutToken.body.error.code).toBe('FORBIDDEN_MANAGER_APPROVAL_REQUIRED');

      const approved = await approve(users.operator, users.manager, created.body.data.id);
      expect(approved.status).toBe(200);
      const row = await discountRow(created.body.data.id);
      expect(row.status).toBe('active');
      expect(String(row.approved_by_user_id)).toBe(String(users.manager));
      expect(row.approval_id).not.toBeNull();
      expect((await preview(users.operator, orderId)).groups[0]).toMatchObject({ discountTotal: '14.00', subtotal: '126.00' });

      const settled = await settleCash(users.operator, orderId);
      const frozen = await t.trx('settlement_discounts').where({ settlement_id: settled.body.data.settlements[0].id }).first();
      expect(String(frozen.approved_by_user_id)).toBe(String(users.manager));
    });

    test('an approval is bound to its discount: a token for one cannot approve another', async () => {
      const orderA = await openTab();
      const orderB = await openTab();
      const a = await requestDiscount(users.operator, orderA, { value: '10' });
      const b = await requestDiscount(users.operator, orderB, { value: '12' });
      const tokenForA = await managerApproval(t.request, { token: tokenFor(users.operator), approverUserId: users.manager, action: 'pos.discount_approval', targetId: a.body.data.id });
      const wrong = await as(users.operator).post(`/api/v1/discounts/${b.body.data.id}/approve`).set('X-Manager-Approval', tokenForA).send({});
      expect(wrong.status).toBe(422);
      expect((await discountRow(b.body.data.id)).status).toBe('pending_approval');
      const right = await as(users.operator).post(`/api/v1/discounts/${a.body.data.id}/approve`).set('X-Manager-Approval', tokenForA).send({});
      expect(right.status).toBe(200);
    });

    test("the approver's own limit must cover the discount: a manager cannot approve 30%, an admin can", async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, { value: '30' });
      const token = await managerApproval(t.request, { token: tokenFor(users.operator), approverUserId: users.manager, action: 'pos.discount_approval', targetId: created.body.data.id });
      const refused = await as(users.operator).post(`/api/v1/discounts/${created.body.data.id}/approve`).set('X-Manager-Approval', token).send({});
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN_APPROVER_NOT_ELIGIBLE');
      expect((await discountRow(created.body.data.id)).status).toBe('pending_approval');
      expect((await approve(users.operator, users.admin, created.body.data.id)).status).toBe(200);
    });

    test('an approval cannot be reused and an active discount cannot be approved again', async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, { value: '10' });
      const token = await managerApproval(t.request, { token: tokenFor(users.operator), approverUserId: users.manager, action: 'pos.discount_approval', targetId: created.body.data.id });
      expect((await as(users.operator).post(`/api/v1/discounts/${created.body.data.id}/approve`).set('X-Manager-Approval', token).send({})).status).toBe(200);
      expect((await as(users.operator).post(`/api/v1/discounts/${created.body.data.id}/approve`).set('X-Manager-Approval', token).send({})).status).toBe(422);
      const again = await approve(users.operator, users.manager, created.body.data.id);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CONFLICT_DISCOUNT_STATE');
    });

    test('an approver who lacks discount.approve cannot be asked at all', async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, { value: '10' });
      const res = await t.request
        .post('/api/v1/approvals')
        .set('Authorization', `Bearer ${tokenFor(users.operator)}`)
        .send({ action: 'pos.discount_approval', approver_user_id: String(users.operator2), pin: '482915', reason: 'x', target_id: String(created.body.data.id) });
      expect(res.status).toBe(403);
    });
  });

  describe('comps', () => {
    test('a comp always needs approval, takes everything, and carries no tax and no service charge', async () => {
      const orderId = await openTab(users.manager);
      const created = await requestDiscount(users.manager, orderId, { kind: 'comp', reason_id: reasons.staff_meal, type: 'fixed', value: '1' });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ kind: 'comp', type: 'percent', value: '100.00', status: 'pending_approval' });
      expect((await approve(users.manager, users.manager, created.body.data.id)).status).toBe(200);

      const view = await preview(users.manager, orderId);
      expect(view.groups[0]).toMatchObject({ subtotal: '0.00', taxAmount: '0.00', serviceCharge: '0.00', total: '0.00', gross: '140.00', discountTotal: '140.00' });

      const room = await as(users.manager).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'room_charge', room_charge: { reservation_id: '1', auth_method: 'pin', auth_reference: 'x' } }] });
      expect(room.status).toBe(400);
      const card = await as(users.manager).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
      expect(card.status).toBe(400);

      const settled = await settleCash(users.manager, orderId);
      expect(settled.status).toBe(200);
      expect(settled.body.data.settlements[0]).toMatchObject({ subtotal: '0.00', tax_amount: '0.00', service_charge: '0.00' });
      const frozen = await t.trx('settlement_discounts').where({ settlement_id: settled.body.data.settlements[0].id }).first();
      expect(frozen).toMatchObject({ kind: 'comp', amount: '140.00' });
    });

    test('a comp needs a manager even for a role whose percent limit is 100', async () => {
      const orderId = await openTab(users.superAdmin);
      const created = await requestDiscount(users.superAdmin, orderId, { kind: 'comp', reason_id: reasons.staff_meal });
      expect(created.status).toBe(201);
      expect(created.body.data.status).toBe('pending_approval');
      expect((await preview(users.superAdmin, orderId)).groups[0].discountTotal).toBeUndefined();
    });

    test('a comp carries no tax even when a tax adds a flat amount per charge', async () => {
      const [flatId] = await t.trx('taxes').insert({ tenant_id: ctx.a.id, property_id: propertyId, tax_code: 'FLATFEE', name: 'Flat fee', rate: '5.0000', effective_from: '2026-01-01', is_inclusive: false, calculation_method: 'flat_amount' });
      try {
        const orderId = await openTab(users.manager);
        const created = await requestDiscount(users.manager, orderId, { kind: 'comp', reason_id: reasons.staff_meal });
        await approve(users.manager, users.manager, created.body.data.id);
        const view = await preview(users.manager, orderId);
        expect(view.groups[0]).toMatchObject({ subtotal: '0.00', taxAmount: '0.00', total: '0.00' });
        const other = await openTab(users.manager); // the flat fee does apply to an undiscounted check
        expect((await preview(users.manager, other)).groups[0].taxAmount).toBe('15.50'); // 7.5% of 140.00 = 10.50, plus 5.00
      } finally {
        await t.trx('taxes').where({ id: flatId }).delete();
      }
    });

    test('an approver without discount.comp cannot approve a comp even within any percent limit', async () => {
      // A role that may approve discounts but not comps.
      const permissionId = (await t.trx('permissions').where({ permission_key: 'discount.approve' }).first('id')).id;
      await t.trx('role_permissions').insert({ tenant_id: ctx.a.id, role_id: ctx.a.roles.cashier, permission_id: permissionId });
      const cashierApprover = await userWithRole('cashier', { pin: true });
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, { kind: 'comp', reason_id: reasons.staff_meal });
      const token = await managerApproval(t.request, { token: tokenFor(users.operator), approverUserId: cashierApprover, action: 'pos.discount_approval', targetId: created.body.data.id });
      const res = await as(users.operator).post(`/api/v1/discounts/${created.body.data.id}/approve`).set('X-Manager-Approval', token).send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_APPROVER_NOT_ELIGIBLE');
    });
  });

  describe('an approval covers what the manager saw', () => {
    test('a discount stays at the amount it was asked for when items are added afterwards', async () => {
      const orderId = await openTab(); // 140.00
      const created = await requestDiscount(users.operator, orderId, { value: '10' }); // 14.00, above the cashier's limit
      expect(created.body.data.amount).toBe('14.00');
      await approve(users.operator, users.manager, created.body.data.id);
      await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 5 }); // +500.00
      const view = await preview(users.operator, orderId);
      expect(view.groups[0]).toMatchObject({ gross: '640.00', discountTotal: '14.00', subtotal: '626.00' });
      expect(String((await discountRow(created.body.data.id)).max_amount)).toBe('14.00');
    });

    test('an approved comp cannot be stretched over items added after the manager approved it', async () => {
      const orderId = await openTab(users.manager); // 140.00
      const comp = await requestDiscount(users.manager, orderId, { kind: 'comp', reason_id: reasons.staff_meal });
      await approve(users.manager, users.manager, comp.body.data.id);
      await as(users.manager).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 10 }); // +1000.00
      const view = await preview(users.manager, orderId);
      expect(view.groups[0]).toMatchObject({ gross: '1140.00', discountTotal: '140.00', subtotal: '1000.00' });
      const settled = await settleCash(users.manager, orderId);
      expect(settled.body.data.settlements[0].subtotal).toBe('1000.00');
    });

    test('the cap holds when a big item is moved to another split group after approval', async () => {
      const orderId = await openTab(); // 140.00
      const created = await requestDiscount(users.operator, orderId, { value: '10' }); // 14.00, above the cashier's limit
      await approve(users.operator, users.manager, created.body.data.id);
      await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 5 }); // +500.00
      const items = (await as(users.operator).get(`/api/v1/pos/orders/${orderId}`)).body.data.items;
      for (const item of items.filter((row) => String(row.menu_item_id) === String(outlet.beer))) {
        expect((await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items/${item.id}/split-group`).send({ split_group: 2 })).status).toBe(200);
      }
      const view = await preview(users.operator, orderId);
      const total = view.groups.reduce((sum, group) => sum + Number(group.discountTotal ?? 0), 0);
      expect(total.toFixed(2)).toBe('14.00');
      expect(String((await discountRow(created.body.data.id)).max_amount)).toBe('14.00');
    });

    test('the cap is applied again at settlement: the sale takes the approved amount, not the percent of the grown check', async () => {
      const orderId = await openTab(); // 140.00
      const created = await requestDiscount(users.operator, orderId, { value: '10' });
      await approve(users.operator, users.manager, created.body.data.id);
      await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 5 });
      const settled = await settleCash(users.operator, orderId);
      expect(settled.status).toBe(200);
      expect(settled.body.data.settlements[0].subtotal).toBe('626.00'); // 640.00 - 14.00, not 640.00 - 64.00
      const frozen = await t.trx('settlement_discounts').where({ discount_id: created.body.data.id });
      expect(frozen.map((row) => String(row.amount))).toEqual(['14.00']);
    });

    test('a request is frozen at the amount it was shown for: a check that grew before approval is not covered by the extra', async () => {
      const orderId = await openTab(); // 140.00
      const created = await requestDiscount(users.operator, orderId, { value: '10' });
      expect(created.body.data.amount).toBe('14.00');
      await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 5 }); // 640.00
      // The list the manager's screen reads shows the exact money being approved while the request waits.
      const waiting = (await as(users.manager).get(`/api/v1/pos/orders/${orderId}/discounts`)).body.data;
      expect(waiting.find((row) => String(row.id) === String(created.body.data.id))).toMatchObject({ status: 'pending_approval', amount: '14.00' });
      await approve(users.operator, users.manager, created.body.data.id);
      expect(String((await discountRow(created.body.data.id)).max_amount)).toBe('14.00');
      expect((await preview(users.operator, orderId)).groups[0]).toMatchObject({ gross: '640.00', discountTotal: '14.00' });
    });

    test('a line discount does not grow with the quantity of its product', async () => {
      const orderId = await openTab(users.operator, [[outlet.beer, 1]]); // 100.00
      const items = (await as(users.operator).get(`/api/v1/pos/orders/${orderId}`)).body.data.items;
      const line = await requestDiscount(users.operator, orderId, { scope: 'line', item_id: String(items[0].id), value: '5' }); // 5.00
      expect(line.body.data.amount).toBe('5.00');
      await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 3 });
      expect((await preview(users.operator, orderId)).groups[0]).toMatchObject({ gross: '400.00', discountTotal: '5.00' });
    });
  });

  describe('immutability', () => {
    test('there is no way to edit a discount: no update route exists', async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, {});
      const id = created.body.data.id;
      const body = { value: '90', scope: 'order', reason_id: reasons.promo };
      expect((await as(users.manager).patch(`/api/v1/discounts/${id}`).send(body)).status).toBe(404);
      expect((await as(users.manager).put(`/api/v1/discounts/${id}`).send(body)).status).toBe(404);
      expect((await as(users.manager).post(`/api/v1/discounts/${id}`).send(body)).status).toBe(404);
      expect(await discountRow(id)).toMatchObject({ value: '5.00', type: 'percent', scope: 'order' });
    });

    test('approving never changes what was requested: value, scope, reason, order and line stay as they were', async () => {
      const orderId = await openTab();
      const items = (await as(users.operator).get(`/api/v1/pos/orders/${orderId}`)).body.data.items;
      const created = await requestDiscount(users.operator, orderId, { scope: 'line', item_id: String(items[0].id), type: 'fixed', value: '20' });
      const before = await discountRow(created.body.data.id);
      expect((await approve(users.operator, users.manager, created.body.data.id)).status).toBe(200);
      const after = await discountRow(created.body.data.id);
      for (const column of ['scope', 'kind', 'type', 'value', 'reason_id', 'pos_order_id', 'pos_order_item_id', 'outlet_id', 'applied_by_user_id', 'menu_item_id']) {
        expect(String(after[column])).toBe(String(before[column]));
      }
    });

    test('an active discount can be removed (with a reason, audited) but then a new one needs its own approval', async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, { value: '10' });
      await approve(users.operator, users.manager, created.body.data.id);
      const noReason = await as(users.operator).post(`/api/v1/discounts/${created.body.data.id}/remove`).send({});
      expect(noReason.status).toBe(400);
      const removed = await as(users.operator).post(`/api/v1/discounts/${created.body.data.id}/remove`).send({ reason: 'customer changed mind' });
      expect(removed.status).toBe(200);
      expect((await discountRow(created.body.data.id)).status).toBe('removed');
      expect((await preview(users.operator, orderId)).groups[0].discountTotal).toBeUndefined();
      // The old approval does nothing for a new request.
      const replacement = await requestDiscount(users.operator, orderId, { value: '10' });
      expect(replacement.body.data.status).toBe('pending_approval');
      expect(String(replacement.body.data.id)).not.toBe(String(created.body.data.id));
      const actions = (await t.trx('audit_log').where({ entity_type: 'discounts', entity_id: String(created.body.data.id) })).map((row) => row.action);
      expect(actions).toEqual(expect.arrayContaining(['discount_request', 'discount_approve', 'discount_remove']));
    });

    test('a settled (applied) discount can no longer be removed or approved', async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, {});
      await settleCash(users.operator, orderId);
      const removal = await as(users.operator).post(`/api/v1/discounts/${created.body.data.id}/remove`).send({ reason: 'too late' });
      expect(removal.status).toBe(409);
      expect((await discountRow(created.body.data.id)).status).toBe('applied');
    });

    test('a discount cannot be re-pointed at another check: it is created on the check named in the URL only', async () => {
      const mine = await openTab();
      const other = await openTab();
      const created = await requestDiscount(users.operator, mine, { value: '10' });
      await approve(users.operator, users.manager, created.body.data.id);
      // The body's order or outlet is ignored.
      const second = await requestDiscount(users.operator, other, { pos_order_id: mine, order_id: mine, outlet_id: '999999', value: '5' });
      expect(String((await discountRow(second.body.data.id)).pos_order_id)).toBe(String(other));
      expect(String((await discountRow(created.body.data.id)).pos_order_id)).toBe(String(mine));
      expect((await preview(users.operator, other)).groups[0].discountTotal).toBe('7.00');
    });

    test('a fixed discount is re-checked against its giver when the check shrinks (it stops the sale, nothing is written)', async () => {
      const orderId = await openTab(); // 140.00
      const created = await requestDiscount(users.operator, orderId, { type: 'fixed', value: '7' }); // 5% exactly: active
      expect(created.body.data.status).toBe('active');
      const items = (await as(users.operator).get(`/api/v1/pos/orders/${orderId}`)).body.data.items;
      const beer = items.find((item) => String(item.menu_item_id) === String(outlet.beer));
      await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items/${beer.id}/void`).send({ reason: 'dropped' });
      const settled = await settleCash(users.operator, orderId);
      expect(settled.status).toBe(422);
      expect(settled.body.error.code).toBe('BUSINESS_RULE_DISCOUNT_NEEDS_APPROVAL');
      expect((await t.trx('pos_orders').where({ id: orderId }).first()).status).toBe('open');
      expect((await discountRow(created.body.data.id)).status).toBe('active');
    });
  });

  describe('who may touch a check', () => {
    test("another operator cannot discount someone else's tab; a manager can with a reason", async () => {
      const orderId = await openTab(users.operator);
      const blocked = await requestDiscount(users.operator2, orderId, {});
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('FORBIDDEN_TAB_NOT_YOURS');
      const noReason = await requestDiscount(users.manager, orderId, {});
      expect(noReason.status).toBe(400);
      const withReason = await requestDiscount(users.manager, orderId, { override_reason: 'helping the cashier' });
      expect(withReason.status).toBe(201);
    });

    test('a role without discount.apply cannot ask for one', async () => {
      const cashier = await userWithRole('cashier');
      const orderId = await openTab();
      expect((await requestDiscount(cashier, orderId, {})).status).toBe(403);
    });

    test('a closed check cannot be discounted', async () => {
      const orderId = await openTab();
      await settleCash(users.operator, orderId);
      const res = await requestDiscount(users.operator, orderId, {});
      expect(res.status).toBe(409);
    });
  });

  describe('splits', () => {
    test('an order discount is shared across split groups to the cent and each settlement freezes its share', async () => {
      const orderId = await openTab(users.operator, [[outlet.beer, 1], [outlet.beer, 1], [outlet.snack, 1]]); // 100 + 100 + 40
      const items = (await as(users.operator).get(`/api/v1/pos/orders/${orderId}`)).body.data.items;
      await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items/${items[0].id}/split-group`).send({ split_group: 1 });
      await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items/${items[1].id}/split-group`).send({ split_group: 2 });
      await as(users.operator).post(`/api/v1/pos/orders/${orderId}/items/${items[2].id}/split-group`).send({ split_group: 3 });
      const created = await requestDiscount(users.operator, orderId, { type: 'fixed', value: '10' });
      expect(created.body.data.status).toBe('active'); // 10 of 240 is about 4.17%
      const view = await preview(users.operator, orderId);
      const shares = view.groups.map((group) => group.discountTotal).sort();
      expect(shares.reduce((sum, share) => sum + Math.round(Number(share) * 100), 0)).toBe(1000);

      const settled = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({
        settlements: [{ method: 'cash', split_group: 1 }, { method: 'cash', split_group: 2 }, { method: 'cash', split_group: 3 }],
      });
      expect(settled.status).toBe(200);
      const frozen = await t.trx('settlement_discounts').whereIn('settlement_id', settled.body.data.settlements.map((s) => s.id));
      expect(frozen).toHaveLength(3);
      expect(frozen.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0)).toBe(1000);
    });
  });

  describe('card payments and refunds', () => {
    async function capturedCard(userId, orderId) {
      const started = await as(userId).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
      expect(started.status).toBe(201);
      await t.trx('payments').where({ id: started.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date(), provider_channel: 'card' });
      return started.body.data;
    }

    test('the card intent carries the discounted total and settles against it', async () => {
      const orderId = await openTab();
      await requestDiscount(users.operator, orderId, {});
      const payment = await capturedCard(users.operator, orderId);
      expect(payment.amount).toBe('152.96');
      const settled = await settleCash(users.operator, orderId, { method: 'card', payment_id: payment.id });
      expect(settled.status).toBe(200);
      expect(settled.body.data.settlements[0]).toMatchObject({ subtotal: '133.00', method: 'card' });
    });

    test('a discount added after the intent is created supersedes it (restart the payment); after capture it is refused', async () => {
      const orderId = await openTab();
      const first = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
      expect(first.body.data.amount).toBe('161.00');
      await requestDiscount(users.operator, orderId, {});
      const second = await as(users.operator).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
      expect(second.body.data.amount).toBe('152.96');
      expect(String(second.body.data.id)).not.toBe(String(first.body.data.id));
      await t.trx('payments').where({ id: second.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date(), provider_channel: 'card' });
      const items = (await as(users.operator).get(`/api/v1/pos/orders/${orderId}`)).body.data.items;
      const late = await requestDiscount(users.operator, orderId, { scope: 'line', item_id: String(items[0].id), value: '2' });
      expect(late.status).toBe(422);
      expect(late.body.error.code).toBe('BUSINESS_RULE_DISCOUNT_PAYMENT_IN_PROGRESS');
    });

    test('a refund can never be more than was paid, and a refunded card sale leaves its frozen discount as history', async () => {
      const orderId = await openTab();
      await requestDiscount(users.operator, orderId, {});
      const payment = await capturedCard(users.operator, orderId);
      const settled = await settleCash(users.operator, orderId, { method: 'card', payment_id: payment.id });
      const settlementId = settled.body.data.settlements[0].id;
      paystack.refundTransaction.mockResolvedValue({ refundId: 'r1', status: 'processed' });
      const refund = async (amount) => {
        const approval = await managerApproval(t.request, { token: tokenFor(users.manager), approverUserId: users.manager, action: 'pos.refund_payment', targetId: payment.id });
        return as(users.manager).post(`/api/v1/cashiering/payments/${payment.id}/refund`).set('X-Manager-Approval', approval).send({ amount, reason: 'guest returned it' });
      };
      // The guest paid 152.96 (the discounted total); asking for the undiscounted 161.00 back is refused.
      const tooMuch = await refund('161.00');
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.error.code).toMatch(/REFUND/);
      expect(await t.trx('pos_order_settlements').where({ id: settlementId, voided_at: null })).toHaveLength(1);
      const exact = await refund('152.96');
      expect(exact.status).toBeLessThan(300);
      expect(await t.trx('settlement_discounts').where({ settlement_id: settlementId })).toHaveLength(1);
    });
  });

  describe('voiding a settled sale', () => {
    test('the sale drops out of the discounts report; the frozen rows stay', async () => {
      const orderId = await openTab();
      await requestDiscount(users.operator, orderId, {});
      const settled = await settleCash(users.operator, orderId);
      const settlementId = settled.body.data.settlements[0].id;
      const before = await as(users.manager).get(`/api/v1/discounts/report?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`);
      const countBefore = before.body.data.summary.count;
      const token = await managerApproval(t.request, { token: tokenFor(users.manager), approverUserId: users.manager, action: 'pos.void_settlement', targetId: settlementId });
      const voided = await as(users.manager).post(`/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`).set('X-Manager-Approval', token).send({ reason: 'keyed in error' });
      expect(voided.status).toBe(200);
      const after = await as(users.manager).get(`/api/v1/discounts/report?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`);
      expect(after.body.data.summary.count).toBe(countBefore - 1);
      expect(await t.trx('settlement_discounts').where({ settlement_id: settlementId })).toHaveLength(1);
    });
  });

  describe('shift cash-up', () => {
    test('expected cash reflects the discounted sale and the close result lists discounts only when there were some', async () => {
      const shiftUser = await userWithRole('pos_operator');
      const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outlet.outletId, device_ref: `SH-${next()}` });
      const opened = await as(shiftUser).post('/api/v1/pos/shifts').send({ terminal_id: terminalId, opening_float: '10.00' });
      expect(opened.status).toBe(201);
      const order = await as(shiftUser).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: terminalId, table_label: `S${next()}`.slice(0, 20) });
      await as(shiftUser).post(`/api/v1/pos/orders/${order.body.data.id}/items`).send({ menu_item_id: outlet.beer, quantity: 1 });
      await requestDiscount(shiftUser, order.body.data.id, {});
      const settled = await settleCash(shiftUser, order.body.data.id);
      expect(settled.status).toBe(200);
      const closed = await as(shiftUser).post(`/api/v1/pos/shifts/${opened.body.data.id}/close`).send({ counted_cash: '0.00' });
      expect(closed.status).toBe(200);
      // 100.00 - 5.00 = 95.00; VAT 7.13 (7.125); service 7.13 (7.125): expected = 10.00 + 109.26
      expect(closed.body.data.expected_cash).toBe('119.26');
      expect(closed.body.data.discounts).toEqual({ count: 1, total: '5.00', discounts: '5.00', comps: '0.00', compCount: 0 });
    });

    test('a shift with no discounts keeps its old shape', async () => {
      const shiftUser = await userWithRole('pos_operator');
      const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outlet.outletId, device_ref: `SN-${next()}` });
      const opened = await as(shiftUser).post('/api/v1/pos/shifts').send({ terminal_id: terminalId, opening_float: '0.00' });
      const closed = await as(shiftUser).post(`/api/v1/pos/shifts/${opened.body.data.id}/close`).send({ counted_cash: '0.00' });
      expect(closed.status).toBe(200);
      expect(closed.body.data.discounts).toBeUndefined();
    });
  });

  describe('the POS sales report', () => {
    test('the item rows add up to the summary under a discount, and the summary lists the discounts', async () => {
      const orderId = await openTab();
      await requestDiscount(users.operator, orderId, { value: '5' });
      await settleCash(users.operator, orderId);
      const res = await as(users.manager).get(`/api/v1/pos/reports/sales?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&outlet_id=${outlet.outletId}`);
      expect(res.status).toBe(200);
      const { summary, topItems, tabs } = res.body.data;
      expect(summary.discounts.count).toBeGreaterThan(0);
      expect(topItems.reduce((sum, row) => sum + Math.round(Number(row.sales) * 100), 0)).toBe(Math.round(Number(summary.subtotal) * 100));
      const tab = tabs.find((row) => String(row.orderId) === String(orderId));
      expect(tab.discountTotal).toBe('7.00');
    });

    test('a report with no discounts keeps its old shape', async () => {
      const [freshOutlet] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `ND${next()}`.slice(0, 30), name: 'No Discount Bar', type: 'bar' });
      const res = await as(users.manager).get(`/api/v1/pos/reports/sales?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&outlet_id=${freshOutlet}`);
      expect(res.status).toBe(200);
      expect(res.body.data.summary.discounts).toBeUndefined();
    });
  });

  describe('report', () => {
    test('groups by reason, giver, approver, outlet and kind; needs reports.view_discounts', async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, { value: '10', reason_id: reasons.promo });
      await approve(users.operator, users.manager, created.body.data.id);
      await settleCash(users.operator, orderId);

      expect((await as(users.operator).get(`/api/v1/discounts/report?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`)).status).toBe(403);
      const res = await as(users.manager).get(`/api/v1/discounts/report?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`);
      expect(res.status).toBe(200);
      const report = res.body.data;
      expect(report.summary.count).toBeGreaterThan(0);
      expect(report.byReason.map((row) => row.label)).toEqual(expect.arrayContaining(['Promotion']));
      expect(report.byApprover.map((row) => row.label)).toEqual(expect.arrayContaining(['manager Tester']));
      expect(report.byOutlet.map((row) => row.label)).toEqual(['Discount Bar']);
      expect(report.lines.find((line) => line.reason === 'Promotion')).toMatchObject({ kind: 'discount', approved_by: 'manager Tester', given_by: 'pos_operator Tester' });

      const csv = await t.request.get(`/api/v1/discounts/report?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv`).set('Authorization', `Bearer ${tokenFor(users.manager)}`);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text.split('\n')[0]).toContain('business_date,outlet,kind');
    });

    test('rejects a malformed or over-long range', async () => {
      expect((await as(users.manager).get('/api/v1/discounts/report?date_from=nope&date_to=2027-08-01')).status).toBe(400);
      expect((await as(users.manager).get('/api/v1/discounts/report?date_from=2027-08-02&date_to=2027-08-01')).status).toBe(400);
      expect((await as(users.manager).get('/api/v1/discounts/report?date_from=2027-01-01&date_to=2027-08-01')).status).toBe(400);
    });
  });

  describe('tenant isolation', () => {
    test("tenant B cannot see, approve or remove tenant A's discount, and gets none of tenant A's reasons", async () => {
      const orderId = await openTab();
      const created = await requestDiscount(users.operator, orderId, { value: '10' });
      const bProperty = ctx.b.properties[0].id;
      const bUser = ctx.b.users[0].id;
      const asB = (method, url) => t.request[method](url).set('Authorization', `Bearer ${tokenFor(bUser, ctx.b.id, bProperty)}`).set('Idempotency-Key', `b-${next()}`);
      expect((await asB('get', `/api/v1/discounts/${created.body.data.id}`)).status).toBe(400);
      expect((await asB('post', `/api/v1/discounts/${created.body.data.id}/remove`).send({ reason: 'x' })).status).toBe(400);
      expect((await asB('post', `/api/v1/discounts/${created.body.data.id}/approve`).send({})).status).toBeGreaterThanOrEqual(400);
      expect((await discountRow(created.body.data.id)).status).toBe('pending_approval');
      const bReasons = await asB('get', '/api/v1/discounts/reasons');
      expect(bReasons.status).toBe(200);
      expect(bReasons.body.data.every((reason) => String(reason.tenant_id) === String(ctx.b.id))).toBe(true);
      const onAOrder = await asB('post', `/api/v1/pos/orders/${orderId}/discounts`).send({ scope: 'order', type: 'percent', value: '5', reason_id: String(bReasons.body.data[0].id) });
      expect(onAOrder.status).toBeGreaterThanOrEqual(400);
      expect(await t.trx('discounts').where({ pos_order_id: orderId })).toHaveLength(1);
    });
  });
});
