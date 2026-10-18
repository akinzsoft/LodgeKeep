'use strict';

/**
 * "Clear stuck refund" over HTTP: its own permission, a manager PIN approval bound to that refund, a mandatory reason,
 * an audit row — and it is only allowed once reconciliation has checked Paystack and could not confirm.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { fetchRefund: jest.fn(), listRefundsForTransaction: jest.fn(), refundTransaction: jest.fn() };
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
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;

describe('POST /cashiering/payments/:id/clear-stuck-refund', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let manager;
  let cashier;
  let counter = 0;
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const token = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const post = (userId, id, body, approval) => {
    const req = t.request.post(`/api/v1/cashiering/payments/${id}/clear-stuck-refund`).set('Authorization', `Bearer ${token(userId)}`).set('Idempotency-Key', `clr-${next()}`);
    return (approval ? req.set('X-Manager-Approval', approval) : req).send(body);
  };

  async function user(role, pin) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'T', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    if (pin) await setApprovalPin(t.trx, { tenantId: ctx.a.id, userId: id });
    return id;
  }

  /** A refund intent PENDING at Paystack, reconciliation having checked `attempts` times without an answer. */
  async function stuckRefund({ attempts = 3, minutesOld = 120, lastResult = 'unreachable' } = {}) {
    const parent = ctx.a.payments[0];
    const [id] = await t.trx('payments').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      folio_id: ctx.a.folios[0].id,
      idempotency_key: `stuck-${next()}`,
      provider: 'paystack',
      provider_reference: `stuck-ref-${next()}`,
      provider_payment_id: `RID${next()}`,
      amount: '10.00',
      currency: 'NGN',
      status: 'PENDING',
      parent_payment_id: parent.id,
      created_at: new Date(Date.now() - minutesOld * 60_000),
    });
    await t.trx('refund_reconciliations').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      payment_id: id,
      attempts,
      first_checked_at: new Date(Date.now() - minutesOld * 30_000),
      last_checked_at: new Date(Date.now() - 600_000),
      last_result: lastResult,
    });
    return id;
  }

  const approvalFor = (id) => managerApproval(t.request, { token: token(manager), approverUserId: manager, action: 'cashiering.clear_stuck_refund', targetId: id });
  const intentRow = (id) => t.trx('payments').where({ id }).first();

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    manager = await user('manager', true);
    cashier = await user('cashier', false);
  });
  beforeEach(() => {
    paystack.fetchRefund.mockReset();
    paystack.fetchRefund.mockRejectedValue(new Error('Paystack is down'));
  });

  test('a manager with the permission, an approval bound to this refund and a reason clears it: FAILED, audited, approval spent', async () => {
    const id = await stuckRefund();
    const res = await post(manager, id, { reason: 'Paystack support confirmed it never went out' }, await approvalFor(id));
    expect(res.status).toBe(200);
    expect(res.body.data.cleared).toBe(true);
    expect((await intentRow(id)).status).toBe('FAILED');
    const audit = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: id, action: 'refund_stuck_cleared' }).first();
    expect(audit.reason).toBe('Paystack support confirmed it never went out');
    expect(String(audit.user_id)).toBe(String(manager));
    expect(await t.trx('manager_approvals').where({ approver_user_id: manager, action: 'cashiering.clear_stuck_refund', target_id: id }).whereNotNull('used_at')).toHaveLength(1);
  });

  test('without the permission (a cashier) it is refused and nothing changes', async () => {
    const id = await stuckRefund();
    const res = await post(cashier, id, { reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    expect((await intentRow(id)).status).toBe('PENDING');
  });

  test('without a manager approval it is refused', async () => {
    const id = await stuckRefund();
    const res = await post(manager, id, { reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_MANAGER_APPROVAL_REQUIRED');
    expect((await intentRow(id)).status).toBe('PENDING');
  });

  test('an approval for ANOTHER refund, or for another action, does not work', async () => {
    const id = await stuckRefund();
    const other = await stuckRefund();
    const wrongTarget = await post(manager, id, { reason: 'x' }, await approvalFor(other));
    expect(wrongTarget.status).toBe(422);
    const wrongAction = await post(manager, id, { reason: 'x' }, await managerApproval(t.request, { token: token(manager), approverUserId: manager, action: 'pos.refund_payment', targetId: id }));
    expect(wrongAction.status).toBe(422);
    expect((await intentRow(id)).status).toBe('PENDING');
  });

  test('a reason is mandatory', async () => {
    const id = await stuckRefund();
    const res = await post(manager, id, {}, await approvalFor(id));
    expect(res.status).toBe(400);
    expect((await intentRow(id)).status).toBe('PENDING');
  });

  test.each([
    ['too few checks', { attempts: 2 }],
    ['too recent', { minutesOld: 10 }],
    ['Paystack last said it is pending', { lastResult: 'pending' }],
  ])('not allowed before the sweep has failed to confirm it (%s) — and the approval is NOT spent', async (_name, options) => {
    const id = await stuckRefund(options);
    const approval = await approvalFor(id);
    const res = await post(manager, id, { reason: 'x' }, approval);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_REFUND_NOT_STUCK');
    expect((await intentRow(id)).status).toBe('PENDING');
    expect(await t.trx('manager_approvals').where({ target_id: id, action: 'cashiering.clear_stuck_refund' }).whereNotNull('used_at')).toHaveLength(0);
  });

  test('a refund that is not waiting on Paystack cannot be cleared', async () => {
    const id = await stuckRefund();
    await t.trx('payments').where({ id }).update({ status: 'CAPTURED' });
    const res = await post(manager, id, { reason: 'x' }, await approvalFor(id));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_REFUND_NOT_STUCK');
  });

  test('the folio\'s payments list shows the stuck refund\'s reconciliation and whether it can be cleared', async () => {
    const id = await stuckRefund();
    const res = await t.request.get(`/api/v1/cashiering/folios/${ctx.a.folios[0].id}`).set('Authorization', `Bearer ${token(manager)}`);
    expect(res.status).toBe(200);
    const payments = res.body.data.payments;
    const row = payments.find((p) => String(p.id) === String(id));
    expect(row.refundReconciliation).toMatchObject({ attempts: 3, lastResult: 'unreachable', canClear: true });
    expect(payments.find((p) => String(p.id) === String(ctx.a.payments[0].id)).refundReconciliation).toBeUndefined();
  });
});
