'use strict';

/**
 * The expense ledger itself — record/void/list, idempotency, RBAC,
 * cross-tenant isolation. No update function exists (ARCHITECTURE.md §8 —
 * financial-record immutability): a correction is void (mandatory reason)
 * plus a fresh `recordExpense` call.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Expenses', () => {
  const t = useTestApp();
  let ctx;
  const BUSINESS_DATE = '2027-01-15';

  function tokenFor(tenant, userId) {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }

  async function setRole(tenant, userIndex, role) {
    const userId = tenant.users[userIndex].id;
    const pid = tenant.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: pid }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: pid, user_id: userId, role });
  }

  const manager = () => tokenFor(ctx.a, ctx.a.users[0].id);
  const cashier = () => tokenFor(ctx.a, ctx.a.users[1].id);
  let idemCounter = 0;
  const idemKey = () => `expenses-test-${(idemCounter += 1)}-${Date.now()}`;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'cashier');
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
  });

  function recordBody(overrides = {}) {
    return {
      expense_category_id: ctx.a.expenseCategories[0].id,
      description: 'Diesel for generator',
      payee: 'ABC Fuel Ltd',
      amount: '150.00',
      currency: 'NGN',
      payment_method: 'cash',
      ...overrides,
    };
  }

  const record = (body, token = manager()) =>
    t.request.post('/api/v1/expenses').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', idemKey()).send(recordBody(body));

  it('records an expense, defaulting business_date to the property\'s current business date', async () => {
    const res = await record();
    expect(res.status).toBe(201);
    expect(res.body.data.business_date).toBe(BUSINESS_DATE);
    expect(res.body.data.amount).toBe('150.00');
    expect(res.body.data.source).toBe('manual');
    expect(res.body.data.voided_at).toBeNull();
  });

  it('accepts an explicit, backdated business_date (never in the future)', async () => {
    const res = await record({ business_date: '2027-01-10' });
    expect(res.status).toBe(201);
    expect(res.body.data.business_date).toBe('2027-01-10');
  });

  it('rejects a business_date after the property\'s current business date', async () => {
    const res = await record({ business_date: '2027-02-01' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_BUSINESS_DATE');
  });

  it('rejects a negative, zero, or 3-decimal amount', async () => {
    for (const amount of ['-10.00', '0.00', '10.999', 'abc']) {
      const res = await record({ amount });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_AMOUNT');
    }
  });

  it('rejects an unrecognised payment method', async () => {
    const res = await record({ payment_method: 'crypto' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_PAYMENT_METHOD');
  });

  it('rejects a currency that does not match the property\'s base currency', async () => {
    const res = await record({ currency: 'USD' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_CURRENCY_MISMATCH');
  });

  it('rejects a missing description', async () => {
    const res = await record({ description: '' });
    expect(res.status).toBe(400);
  });

  it('replays the exact same response on a retried Idempotency-Key, never double-recording', async () => {
    const key = idemKey();
    const body = recordBody();
    const first = await t.request.post('/api/v1/expenses').set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', key).send(body);
    const second = await t.request.post('/api/v1/expenses').set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it('rejects the same Idempotency-Key reused with a different payload (409)', async () => {
    const key = idemKey();
    await t.request.post('/api/v1/expenses').set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', key).send(recordBody());
    const res = await t.request.post('/api/v1/expenses').set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', key).send(recordBody({ amount: '999.00' }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_IDEMPOTENCY_KEY_REUSE');
  });

  describe('voidExpense', () => {
    it('voids an expense with a mandatory reason', async () => {
      const created = await record();
      const missingReason = await t.request.post(`/api/v1/expenses/${created.body.data.id}/void`).set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', idemKey()).send({});
      expect(missingReason.status).toBe(400);

      const voided = await t.request
        .post(`/api/v1/expenses/${created.body.data.id}/void`)
        .set('Authorization', `Bearer ${manager()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Duplicate entry' });
      expect(voided.status).toBe(200);
      expect(voided.body.data.voided_at).toBeTruthy();
      expect(voided.body.data.void_reason).toBe('Duplicate entry');
    });

    it('rejects voiding an already-voided expense (409)', async () => {
      const created = await record();
      await t.request.post(`/api/v1/expenses/${created.body.data.id}/void`).set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', idemKey()).send({ reason: 'first void' });
      const second = await t.request.post(`/api/v1/expenses/${created.body.data.id}/void`).set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', idemKey()).send({ reason: 'second void' });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('CONFLICT_EXPENSE_ALREADY_VOIDED');
    });

    it('cross-tenant: voiding another tenant\'s expense id is rejected as not found (the same trx-based-mutation 400 shape `pos/service.js`\'s own `voidSettlement` already establishes for a cross-tenant void target, not a controller-level 404)', async () => {
      await setRole(ctx.b, 0, 'manager');
      await t.trx('properties').where({ id: ctx.b.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
      const otherToken = tokenFor(ctx.b, ctx.b.users[0].id);
      const otherRecord = await t.request
        .post('/api/v1/expenses')
        .set('Authorization', `Bearer ${otherToken}`)
        .set('Idempotency-Key', idemKey())
        .send({ expense_category_id: ctx.b.expenseCategories[0].id, description: 'Other tenant expense', amount: '10.00', currency: 'NGN', payment_method: 'cash' });
      expect(otherRecord.status).toBe(201);

      const attempt = await t.request
        .post(`/api/v1/expenses/${otherRecord.body.data.id}/void`)
        .set('Authorization', `Bearer ${manager()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'attempted cross-tenant void' });
      expect(attempt.status).toBe(400);
      expect(attempt.body.error.code).toBe('VALIDATION_EXPENSE_NOT_FOUND');
    });
  });

  describe('listExpenses', () => {
    it('excludes voided expenses by default, includes them with include_voided=true', async () => {
      const created = await record({ description: 'To be voided' });
      await t.request.post(`/api/v1/expenses/${created.body.data.id}/void`).set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', idemKey()).send({ reason: 'test' });

      const withoutVoided = await t.request.get('/api/v1/expenses').set('Authorization', `Bearer ${manager()}`);
      expect(withoutVoided.body.data.some((e) => e.id === created.body.data.id)).toBe(false);

      const withVoided = await t.request.get('/api/v1/expenses?include_voided=true').set('Authorization', `Bearer ${manager()}`);
      expect(withVoided.body.data.some((e) => e.id === created.body.data.id)).toBe(true);
    });

    it('filters by category, date range, and payment method', async () => {
      await record({ business_date: '2027-01-05', payment_method: 'card' });
      const byDate = await t.request.get('/api/v1/expenses?date_from=2027-01-05&date_to=2027-01-05').set('Authorization', `Bearer ${manager()}`);
      expect(byDate.body.data.every((e) => e.business_date === '2027-01-05')).toBe(true);

      const byMethod = await t.request.get('/api/v1/expenses?payment_method=card').set('Authorization', `Bearer ${manager()}`);
      expect(byMethod.body.data.every((e) => e.payment_method === 'card')).toBe(true);

      const byCategory = await t.request.get(`/api/v1/expenses?category_id=${ctx.a.expenseCategories[0].id}`).set('Authorization', `Bearer ${manager()}`);
      expect(byCategory.body.data.every((e) => String(e.expense_category_id) === String(ctx.a.expenseCategories[0].id))).toBe(true);
    });
  });

  describe('RBAC', () => {
    it('cashier (no expenses.view/manage) is refused reading and recording', async () => {
      const list = await t.request.get('/api/v1/expenses').set('Authorization', `Bearer ${cashier()}`);
      expect(list.status).toBe(403);

      const create = await t.request.post('/api/v1/expenses').set('Authorization', `Bearer ${cashier()}`).set('Idempotency-Key', idemKey()).send(recordBody());
      expect(create.status).toBe(403);
    });
  });
});
