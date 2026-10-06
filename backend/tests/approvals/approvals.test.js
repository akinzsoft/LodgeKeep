'use strict';

/**
 * Manager approvals (src/modules/approvals) — the PIN re-authentication a
 * sensitive action needs at the moment it happens: setting a PIN, asking a
 * manager to approve, the PIN lock, and every way a gated action refuses an
 * approval that does not fit it (missing, used, expired, another action,
 * record or person, or an approver who lost the right to approve).
 *
 * The real-connection race (one approval sent on two requests at once) is in
 * approvals-concurrency.test.js.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { initializeTransaction: jest.fn(), verifyTransaction: jest.fn(), refundTransaction: jest.fn(), fetchRefund: jest.fn(), verifyWebhookSignature: jest.fn() };
  return { ...actual, __mockAdapter: mockAdapter, resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })) };
});

const fs = require('fs');
const path = require('path');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { managerApproval, setApprovalPin, TEST_APPROVAL_PIN } = require('../helpers/approvals');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');
const { signAccessToken } = require('../../src/auth/tokens');
const { hashPassword } = require('../../src/auth/password');
const { APPROVAL_ACTIONS } = require('../../src/modules/approvals');
const { isTrivialPin } = require('../../src/modules/approvals/service');
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;

const BUSINESS_DATE = '2027-08-10';
const PASSWORD = 'correct horse battery staple';

describe('Manager approvals (PIN re-authentication for sensitive actions)', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let manager;
  let operator;
  let outletId;
  let terminalId;
  let beerId;
  let counter = 0;

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId, tenant = ctx.a) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const post = (userId, url, { approval, key = `ap-${next()}` } = {}) => {
    const req = t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`).set('Idempotency-Key', key);
    return approval ? req.set('X-Manager-Approval', approval) : req;
  };
  const ask = (userId, body) => t.request.post('/api/v1/approvals').set('Authorization', `Bearer ${tokenFor(userId)}`).send(body);
  const approve = (requesterId, action, targetId = null, approverUserId = manager) =>
    managerApproval(t.request, { token: tokenFor(requesterId), approverUserId, action, targetId, reason: `Approved: ${action}` });

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  async function newUser(role, { pin = false } = {}) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: next(), password_hash: await hashPassword(PASSWORD), status: 'active' });
    await setRole(id, role);
    if (pin) await setApprovalPin(t.trx, { tenantId: ctx.a.id, userId: id });
    return id;
  }

  /** A settled cash Register sale: its tab and settlement. */
  async function cashSale(userId = operator) {
    const opened = await post(userId, '/api/v1/pos/orders').send({ outlet_id: outletId, terminal_id: terminalId, table_label: `T${next()}` });
    expect(opened.status).toBe(201);
    const orderId = opened.body.data.id;
    expect((await post(userId, `/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: beerId, quantity: 1 })).status).toBe(200);
    const settled = await post(userId, `/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }] });
    expect(settled.status).toBe(200);
    return { orderId, settlementId: settled.body.data.settlements[0].id };
  }

  const voidUrl = ({ orderId, settlementId }) => `/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`;
  const settlementRow = (id) => t.trx('pos_order_settlements').where({ id }).first();

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    manager = ctx.a.users[0].id; // manager at property 0, holds the test PIN (fixtures)
    operator = ctx.a.users[1].id;
    await setRole(operator, 'pos_operator');
    await t.trx('users').where({ id: operator }).update({ password_hash: await hashPassword(PASSWORD) });
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BUSINESS_DATE });
    outletId = ctx.a.posOutlets[0].id;
    terminalId = ctx.a.posTerminals[0].id;
    [beerId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Approval Beer', category: 'Approval Drinks', price: '20.00' });
  });

  beforeEach(() => flushRateLimitPrefixes(['approvals-request:', 'approvals-pin-set:']));

  // ------------------------------------------------------------------
  describe('setting an approval PIN', () => {
    it('needs the current password and 6 digits that are not trivial; never echoes or logs the PIN', async () => {
      const me = await newUser('manager');
      const put = (body) => t.request.put('/api/v1/me/approval-pin').set('Authorization', `Bearer ${tokenFor(me)}`).send(body);

      expect((await t.request.get('/api/v1/me/approval-pin').set('Authorization', `Bearer ${tokenFor(me)}`)).body.data.has_pin).toBe(false);
      expect((await put({ current_password: PASSWORD, pin: '12345' })).body.error.code).toBe('VALIDATION_APPROVAL_PIN_FORMAT');
      expect((await put({ current_password: PASSWORD, pin: '12a456' })).body.error.code).toBe('VALIDATION_APPROVAL_PIN_FORMAT');
      for (const trivial of ['111111', '123456', '654321']) {
        expect((await put({ current_password: PASSWORD, pin: trivial })).body.error.code).toBe('VALIDATION_APPROVAL_PIN_TOO_SIMPLE');
      }
      const wrong = await put({ current_password: 'not my password', pin: '730194' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.code).toBe('VALIDATION_CURRENT_PASSWORD_INCORRECT');
      const failedEvent = await t.trx('auth_events').where({ user_id: me, event_type: 'approval_pin_set', failure_reason: 'invalid_password' }).first();
      expect(failedEvent).toBeDefined();
      expect(await t.trx('approval_pins').where({ user_id: me }).first()).toBeUndefined();

      const res = await put({ current_password: PASSWORD, pin: '730194' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ has_pin: true, set_at: expect.any(String) });
      expect(JSON.stringify(res.body)).not.toContain('730194');
      const row = await t.trx('approval_pins').where({ user_id: me }).first();
      expect(row.pin_hash).toMatch(/^\$2[aby]\$12\$/);
      const audit = await t.trx('audit_log').where({ entity_type: 'approval_pins', user_id: me, action: 'approval_pin_set' }).first();
      expect(audit.after_state).toBeNull();
      expect((await t.trx('auth_events').where({ user_id: me, event_type: 'approval_pin_set' }).whereNull('failure_reason')).length).toBe(1);
      expect((await t.request.get('/api/v1/me/approval-pin').set('Authorization', `Bearer ${tokenFor(me)}`)).body.data.has_pin).toBe(true);

      // Changing it is the same call, recorded as a change.
      expect((await put({ current_password: PASSWORD, pin: '918273' })).status).toBe(200);
      expect(await t.trx('audit_log').where({ entity_type: 'approval_pins', user_id: me, action: 'approval_pin_changed' }).first()).toBeDefined();
    });

    it('recognises trivial PINs', () => {
      expect(['000000', '999999', '012345', '345678', '987654', '210987'.slice(0, 6)].filter((pin) => isTrivialPin(pin))).toEqual(['000000', '999999', '012345', '345678', '987654']);
      expect(isTrivialPin('482915')).toBe(false);
      expect(isTrivialPin('112233')).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  describe('asking a manager to approve', () => {
    it('lists who may approve, by name, with whether each has a PIN — never another tenant’s staff or a cashier', async () => {
      const noPin = await newUser('manager');
      const res = await t.request.get('/api/v1/approvals/approvers?action=pos.void_settlement').set('Authorization', `Bearer ${tokenFor(operator)}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((row) => row.id);
      expect(ids).toContain(String(manager));
      expect(ids).toContain(String(noPin));
      expect(ids).not.toContain(String(operator));
      expect(ids).not.toContain(String(ctx.b.users[0].id));
      expect(res.body.data.find((row) => row.id === String(manager))).toEqual({ id: String(manager), name: 'Sam Okoro', hasPin: true });
      expect(res.body.data.find((row) => row.id === String(noPin)).hasPin).toBe(false);
      expect(Object.keys(res.body.data[0]).sort()).toEqual(['hasPin', 'id', 'name']);

      const unknown = await t.request.get('/api/v1/approvals/approvers?action=pos.give_away_the_bar').set('Authorization', `Bearer ${tokenFor(operator)}`);
      expect(unknown.body.error.code).toBe('VALIDATION_UNKNOWN_APPROVAL_ACTION');
    });

    it('issues a single-use approval for the right PIN and records who approved, for what and why', async () => {
      const sale = await cashSale();
      const res = await ask(operator, { action: 'pos.void_settlement', approver_user_id: manager, pin: TEST_APPROVAL_PIN, reason: 'Rung up twice', target_id: sale.settlementId });
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({ token: expect.any(String), expires_at: expect.any(String), approval_id: expect.any(String), approver: { id: String(manager), name: 'Sam Okoro' } });
      const row = await t.trx('manager_approvals').where({ id: res.body.data.approval_id }).first();
      expect(row).toMatchObject({ action: 'pos.void_settlement', target_type: 'pos_order_settlements', reason: 'Rung up twice', used_at: null });
      expect(String(row.target_id)).toBe(String(sale.settlementId));
      expect(String(row.requested_by_user_id)).toBe(String(operator));
      expect(String(row.approver_user_id)).toBe(String(manager));
      expect(row.token_hash).not.toBe(res.body.data.token); // only a hash is stored
      const lifetime = new Date(row.expires_at) - new Date(row.created_at);
      expect(lifetime).toBeGreaterThan(110_000);
      expect(lifetime).toBeLessThanOrEqual(121_000);
      const audit = await t.trx('audit_log').where({ entity_type: 'manager_approvals', entity_id: row.id, action: 'approval_issued' }).first();
      expect(String(audit.user_id)).toBe(String(manager));
      expect(audit.reason).toBe('Rung up twice');
    });

    it('refuses a wrong PIN (counted), a cashier as approver, a manager with no PIN, and a missing record or reason', async () => {
      const sale = await cashSale();
      const base = { action: 'pos.void_settlement', approver_user_id: manager, pin: TEST_APPROVAL_PIN, reason: 'x', target_id: sale.settlementId };
      const wrong = await ask(operator, { ...base, pin: '000001' });
      expect(wrong.status).toBe(422);
      expect(wrong.body.error).toMatchObject({ code: 'VALIDATION_APPROVAL_PIN_INCORRECT', details: { attemptsLeft: 4 } });
      expect(await t.trx('auth_events').where({ user_id: manager, event_type: 'approval_pin_failed' }).first()).toBeDefined();
      // The right PIN clears the count.
      expect((await ask(operator, base)).status).toBe(201);
      expect((await t.trx('approval_pins').where({ user_id: manager }).first()).failed_count).toBe(0);

      expect((await ask(operator, { ...base, approver_user_id: operator })).body.error.code).toBe('FORBIDDEN_APPROVER_NOT_ELIGIBLE');
      expect((await ask(operator, { ...base, approver_user_id: ctx.b.users[0].id })).body.error.code).toBe('FORBIDDEN_APPROVER_NOT_ELIGIBLE');
      const noPin = await newUser('manager');
      expect((await ask(operator, { ...base, approver_user_id: noPin })).body.error.code).toBe('BUSINESS_RULE_APPROVAL_PIN_NOT_SET');
      expect((await ask(operator, { ...base, target_id: undefined })).body.error.code).toBe('VALIDATION_MISSING_FIELD');
      expect((await ask(operator, { ...base, reason: '  ' })).body.error.code).toBe('VALIDATION_MISSING_FIELD');
      expect((await ask(operator, { ...base, pin: '12345' })).body.error.code).toBe('VALIDATION_APPROVAL_PIN_FORMAT');
    });

    it('locks a manager’s PIN after 5 wrong PINs in 15 minutes, bells the managers, and the owner can reset it', async () => {
      const target = await newUser('manager', { pin: true });
      const sale = await cashSale();
      const base = { action: 'pos.void_settlement', approver_user_id: target, reason: 'x', target_id: sale.settlementId };
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const res = await ask(operator, { ...base, pin: '000001' });
        expect(res.body.error.details.attemptsLeft).toBe(5 - attempt);
      }
      const fifth = await ask(operator, { ...base, pin: '000001' });
      expect(fifth.status).toBe(423);
      expect(fifth.body.error.code).toBe('LOCKED_APPROVAL_PIN');
      // Even the right PIN is refused while locked.
      expect((await ask(operator, { ...base, pin: TEST_APPROVAL_PIN })).body.error.code).toBe('LOCKED_APPROVAL_PIN');
      expect(await t.trx('auth_events').where({ user_id: target, event_type: 'approval_pin_locked' }).first()).toBeDefined();
      const bell = await t.trx('in_app_notifications').where({ tenant_id: ctx.a.id, user_id: manager, type: 'approvals.pin_locked' }).first();
      expect(bell).toBeDefined();
      expect(typeof bell.payload === 'string' ? JSON.parse(bell.payload) : bell.payload).toMatchObject({ approverUserId: String(target), action: 'pos.void_settlement' });

      const reset = await t.request.put('/api/v1/me/approval-pin').set('Authorization', `Bearer ${tokenFor(target)}`).send({ current_password: PASSWORD, pin: '730194' });
      expect(reset.status).toBe(200);
      expect((await ask(operator, { ...base, pin: '730194' })).status).toBe(201);
    });
  });

  // ------------------------------------------------------------------
  describe('using an approval: a POS settlement void', () => {
    it('refuses a void with no approval — for a cashier and for the signed-in manager alike', async () => {
      const sale = await cashSale();
      for (const who of [operator, manager]) {
        const res = await post(who, voidUrl(sale)).send({ reason: 'No approval' });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_MANAGER_APPROVAL_REQUIRED');
      }
      expect((await settlementRow(sale.settlementId)).voided_at).toBeNull();
    });

    it('a cashier starts it, the manager approves: voided, the approval used once and audited apart from the void', async () => {
      const sale = await cashSale();
      const approval = await approve(operator, 'pos.void_settlement', sale.settlementId);
      const res = await post(operator, voidUrl(sale), { approval }).send({ reason: 'Keyed in error' });
      expect(res.status).toBe(200);
      expect(res.body.data.voided_at).not.toBeNull();

      const row = await t.trx('manager_approvals').where({ target_id: sale.settlementId, action: 'pos.void_settlement' }).first();
      expect(row.used_at).not.toBeNull();
      const used = await t.trx('audit_log').where({ entity_type: 'manager_approvals', entity_id: row.id, action: 'approval_used' }).first();
      expect(String(used.user_id)).toBe(String(manager));
      expect(used.reason).toBe('Approved: pos.void_settlement');
      expect(used.after_state).toEqual({ action: 'pos.void_settlement', target_type: 'pos_order_settlements', target_id: String(sale.settlementId), requested_by_user_id: String(operator), approver_user_id: String(manager) });

      // The void's own audit row is exactly what it always was: the till user, the void's reason, no approval fields.
      const voidAudit = await t.trx('audit_log').where({ entity_type: 'pos_order_settlements', entity_id: sale.settlementId, action: 'void' }).first();
      expect(String(voidAudit.user_id)).toBe(String(operator));
      expect(voidAudit.reason).toBe('Keyed in error');
      expect(JSON.stringify(voidAudit.after_state)).not.toMatch(/approv/i);

      // Used once: the same approval cannot void anything again.
      const other = await cashSale();
      const reused = await post(operator, voidUrl(other), { approval }).send({ reason: 'Again' });
      expect(reused.body.error.code).toBe('VALIDATION_APPROVAL_INVALID');
      expect((await settlementRow(other.settlementId)).voided_at).toBeNull();
    });

    it('refuses an approval for another record, another action, another person, or one that expired — voiding nothing', async () => {
      const sale = await cashSale();
      const other = await cashSale();
      const cases = [
        ['another settlement', await approve(operator, 'pos.void_settlement', other.settlementId), operator],
        ['another action', await approve(operator, 'pos.stock_override', sale.orderId), operator],
        ['another person', await approve(operator, 'pos.void_settlement', sale.settlementId), manager],
        ['an unknown token', 'not-a-real-approval-token', operator],
      ];
      const expired = await approve(operator, 'pos.void_settlement', sale.settlementId);
      // Only the approval just issued expires (the "another person" one above stays valid, so that case is judged on its own).
      const newest = await t.trx('manager_approvals').where({ target_id: sale.settlementId, action: 'pos.void_settlement' }).orderBy('id', 'desc').first('id');
      await t.trx('manager_approvals').where({ id: newest.id }).update({ expires_at: new Date(Date.now() - 1000) });
      cases.push(['an expired approval', expired, operator]);
      for (const [label, approval, who] of cases) {
        const res = await post(who, voidUrl(sale), { approval }).send({ reason: label });
        expect([label, res.status, res.body.error?.code]).toEqual([label, 422, 'VALIDATION_APPROVAL_INVALID']);
      }
      expect((await settlementRow(sale.settlementId)).voided_at).toBeNull();
    });

    it('an approval from another tenant is refused', async () => {
      const sale = await cashSale();
      await t.trx('user_property_access').where({ tenant_id: ctx.b.id, user_id: ctx.b.users[1].id, property_id: ctx.b.properties[0].id }).update({ role: 'pos_operator' });
      const theirs = await managerApproval(t.request, { token: tokenFor(ctx.b.users[1].id, ctx.b), approverUserId: ctx.b.users[0].id, action: 'pos.void_settlement', targetId: sale.settlementId });
      const res = await post(operator, voidUrl(sale), { approval: theirs }).send({ reason: 'Borrowed approval' });
      expect(res.body.error.code).toBe('VALIDATION_APPROVAL_INVALID');
      expect((await settlementRow(sale.settlementId)).voided_at).toBeNull();
    });

    it('a manager demoted after typing their PIN no longer approves anything', async () => {
      const deputy = await newUser('manager', { pin: true });
      const sale = await cashSale();
      const approval = await approve(operator, 'pos.void_settlement', sale.settlementId, deputy);
      await setRole(deputy, 'front_desk');
      const res = await post(operator, voidUrl(sale), { approval }).send({ reason: 'Demoted in between' });
      expect(res.body.error.code).toBe('VALIDATION_APPROVAL_INVALID');
      expect((await settlementRow(sale.settlementId)).voided_at).toBeNull();
      // (That the refused claim is rolled back — the approval left unused — needs real connections:
      // approvals-concurrency.test.js.)
    });

    it('a replayed request (same Idempotency-Key) returns the stored result and uses no second approval', async () => {
      const sale = await cashSale();
      const approval = await approve(operator, 'pos.void_settlement', sale.settlementId);
      const key = `ap-${next()}`;
      const first = await post(operator, voidUrl(sale), { approval, key }).send({ reason: 'Once' });
      expect(first.status).toBe(200);
      const replay = await post(operator, voidUrl(sale), { key }).send({ reason: 'Once' });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect((await t.trx('audit_log').where({ entity_type: 'manager_approvals', action: 'approval_used' }).whereRaw("JSON_EXTRACT(after_state, '$.target_id') = ?", [String(sale.settlementId)])).length).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('refunds through the cashiering refund route', () => {
    it('a hotel folio refund needs no approval (unchanged)', async () => {
      const payment = ctx.a.payments[0];
      const res = await post(manager, `/api/v1/cashiering/payments/${payment.id}/refund`).send({ amount: '10.00', reason: 'Folio refund' });
      expect(res.status).toBe(201);
      expect(await t.trx('manager_approvals').where({ action: 'pos.refund_payment' }).first()).toBeUndefined();
    });

    it('a Register card payment refund needs a manager approval; without one Paystack is never asked', async () => {
      const { orderId } = await cashSale();
      const [paymentId] = await t.trx('payments').insert({
        tenant_id: ctx.a.id,
        property_id: propertyId,
        pos_order_id: orderId,
        settlement_target: 'pos_register',
        idempotency_key: `ap-reg-${next()}`,
        provider: 'paystack',
        provider_reference: `REG-${next()}`,
        amount: '21.50',
        currency: 'NGN',
        status: 'CAPTURED',
        captured_at: new Date(),
      });
      const res = await post(manager, `/api/v1/cashiering/payments/${paymentId}/refund`).send({ reason: 'No approval' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_MANAGER_APPROVAL_REQUIRED');
      expect(paystack.refundTransaction).not.toHaveBeenCalled();
      expect(await t.trx('payments').where({ parent_payment_id: paymentId }).first()).toBeUndefined();

      // With an approval it passes the gate (claimed before Paystack is asked).
      paystack.refundTransaction.mockRejectedValueOnce(new Error('Stop here'));
      const approval = await approve(manager, 'pos.refund_payment', paymentId);
      await post(manager, `/api/v1/cashiering/payments/${paymentId}/refund`, { approval }).send({ reason: 'Approved refund' });
      expect(paystack.refundTransaction).toHaveBeenCalledTimes(1);
      expect((await t.trx('manager_approvals').where({ action: 'pos.refund_payment', target_id: paymentId }).first()).used_at).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  describe('stock overrides at the Register', () => {
    async function stockedTab(onHand) {
      const [itemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `Counted ${next()}`, category: 'Approval Drinks', price: '10.00' });
      const [stockId] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `Bottle ${next()}`, unit: 'bottle', current_quantity: onHand });
      await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: itemId, stock_item_id: stockId, quantity: '1.000' });
      const opened = await post(operator, '/api/v1/pos/orders').send({ outlet_id: outletId, terminal_id: terminalId, table_label: `S${next()}` });
      return { orderId: opened.body.data.id, itemId, stockId };
    }

    it('needs no approval when stock covers the sale, even if a reason is sent', async () => {
      const tab = await stockedTab('10.000');
      const res = await post(operator, `/api/v1/pos/orders/${tab.orderId}/items`).send({ menu_item_id: tab.itemId, quantity: 1, stock_override_reason: 'Just in case' });
      expect(res.status).toBe(200);
    });

    it('selling past recorded stock needs a manager approval; without one nothing is added', async () => {
      const tab = await stockedTab('0.000');
      const body = { menu_item_id: tab.itemId, quantity: 1, stock_override_reason: 'Crate in the back' };
      const refused = await post(operator, `/api/v1/pos/orders/${tab.orderId}/items`).send(body);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN_MANAGER_APPROVAL_REQUIRED');
      expect(await t.trx('pos_order_items').where({ pos_order_id: tab.orderId }).first()).toBeUndefined();
      expect(await t.trx('audit_log').where({ entity_type: 'stock_items', entity_id: tab.stockId, action: 'stock_override_applied' }).first()).toBeUndefined();

      const approval = await approve(operator, 'pos.stock_override', tab.orderId);
      const res = await post(operator, `/api/v1/pos/orders/${tab.orderId}/items`, { approval }).send(body);
      expect(res.status).toBe(200);
      expect(await t.trx('audit_log').where({ entity_type: 'stock_items', entity_id: tab.stockId, action: 'stock_override_applied' }).first()).toBeDefined();
      expect((await t.trx('manager_approvals').where({ action: 'pos.stock_override', target_id: tab.orderId }).first()).used_at).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  describe('the supermarket', () => {
    let martId;
    let cashier;

    beforeAll(async () => {
      [martId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `AM${next()}`.slice(0, 30), name: 'Approval Mart', type: 'supermarket' });
      cashier = operator;
    });

    async function trackedProduct(onHand) {
      const [itemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: martId, name: `Mart item ${next()}`, category: 'Approval Mart Goods', price: '10.00' });
      const [stockId] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: martId, name: `Mart stock ${next()}`, unit: 'pack', current_quantity: onHand });
      await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: itemId, stock_item_id: stockId, quantity: '1.000' });
      return itemId;
    }
    const sale = (body, approval) => post(cashier, '/api/v1/supermarket/sales', { approval }).send({ outlet_id: martId, method: 'cash', ...body });

    it('a confirmed oversell also needs a manager approval; within stock, confirm needs none', async () => {
      const short = await trackedProduct('1.000');
      const refused = await sale({ items: [{ menu_item_id: short, quantity: 3 }], confirm_oversell: true });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN_MANAGER_APPROVAL_REQUIRED');
      const approval = await approve(cashier, 'supermarket.oversell');
      expect((await sale({ items: [{ menu_item_id: short, quantity: 3 }], confirm_oversell: true }, approval)).status).toBe(201);

      const plenty = await trackedProduct('50.000');
      expect((await sale({ items: [{ menu_item_id: plenty, quantity: 3 }], confirm_oversell: true })).status).toBe(201);
    });

    it('a cashier may start a void with a manager approval, but only of a sale at their own outlets', async () => {
      const item = await trackedProduct('50.000');
      const sold = await sale({ items: [{ menu_item_id: item, quantity: 1 }] });
      expect(sold.status).toBe(201);
      const saleId = sold.body.data.id;

      expect((await post(cashier, `/api/v1/supermarket/sales/${saleId}/void`).send({ reason: 'No approval' })).body.error.code).toBe('FORBIDDEN_MANAGER_APPROVAL_REQUIRED');

      // Tied to another outlet only: this mart's receipt is "not found".
      const [elsewhere] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `AE${next()}`.slice(0, 30), name: 'Other Mart', type: 'supermarket' });
      await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: cashier, outlet_id: elsewhere });
      const approvalOne = await approve(cashier, 'supermarket.void_sale', saleId);
      expect((await post(cashier, `/api/v1/supermarket/sales/${saleId}/void`, { approval: approvalOne }).send({ reason: 'Other outlet' })).status).toBe(404);
      await t.trx('user_outlet_assignments').where({ user_id: cashier }).delete();

      const voided = await post(cashier, `/api/v1/supermarket/sales/${saleId}/void`, { approval: approvalOne }).send({ reason: 'Customer returned it' });
      expect(voided.status).toBe(200);
      expect(voided.body.data.voided_at).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  describe('the action registry', () => {
    it('names only permissions that exist, and every action is claimed somewhere in the code', async () => {
      const keys = (await t.trx('permissions').select('permission_key')).map((row) => row.permission_key);
      const sources = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!full.endsWith(path.join('modules', 'approvals'))) walk(full);
          } else if (entry.name.endsWith('.js')) sources.push(fs.readFileSync(full, 'utf8'));
        }
      };
      walk(path.join(__dirname, '../../src'));
      const code = sources.join('\n');
      for (const [action, definition] of Object.entries(APPROVAL_ACTIONS)) {
        expect([action, keys.includes(definition.permission)]).toEqual([action, true]);
        expect([action, code.includes(`'${action}'`)]).toEqual([action, true]);
      }
    });
  });
});
