'use strict';

/**
 * Recurring expense schedules — CRUD, frequency/day validation, pause/
 * resume. The actual auto-posting sweep is covered end to end against
 * real MySQL in `tests/jobs/expense-schedules-sweep.test.js`; this file
 * only exercises the HTTP-level configuration surface.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Recurring expense schedules', () => {
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
  const housekeeping = () => tokenFor(ctx.a, ctx.a.users[1].id);

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'housekeeping');
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
  });

  function scheduleBody(overrides = {}) {
    return {
      expense_category_id: ctx.a.expenseCategories[0].id,
      description: 'Monthly rent',
      payee: 'Landlord Ltd',
      amount: '500000.00',
      currency: 'NGN',
      payment_method: 'bank_transfer',
      frequency: 'monthly',
      day_of_month: 1,
      ...overrides,
    };
  }

  const create = (body, token = manager()) => t.request.post('/api/v1/expenses/recurring-schedules').set('Authorization', `Bearer ${token}`).send(scheduleBody(body));

  it('creates a monthly schedule, computing an inclusive initial next_due_date', async () => {
    const res = await create({ day_of_month: 15 }); // BUSINESS_DATE is the 15th
    expect(res.status).toBe(201);
    expect(res.body.data.next_due_date).toBe(BUSINESS_DATE);
    expect(res.body.data.status).toBe('active');
  });

  it('creates a weekly schedule with day_of_week', async () => {
    const res = await create({ frequency: 'weekly', day_of_month: undefined, day_of_week: 1 }); // BUSINESS_DATE (2027-01-15) is a Friday
    expect(res.status).toBe(201);
    expect(res.body.data.frequency).toBe('weekly');
    expect(res.body.data.day_of_week).toBe(1);
  });

  it('rejects weekly with day_of_month set instead of day_of_week', async () => {
    const res = await create({ frequency: 'weekly', day_of_month: 15 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_RECURRENCE_CONFIG');
  });

  it('rejects monthly/quarterly/annually with a missing or out-of-range day_of_month', async () => {
    const missing = await create({ day_of_month: undefined });
    expect(missing.status).toBe(400);
    const outOfRange = await create({ day_of_month: 32 });
    expect(outOfRange.status).toBe(400);
  });

  it('rejects monthly with day_of_week set instead of day_of_month', async () => {
    const res = await create({ day_of_week: 2 });
    expect(res.status).toBe(400);
  });

  it('rejects an unrecognised frequency', async () => {
    const res = await create({ frequency: 'daily' });
    expect(res.status).toBe(400);
  });

  it('rejects a currency mismatched against the property\'s base currency', async () => {
    const res = await create({ currency: 'USD' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_CURRENCY_MISMATCH');
  });

  it('updates allowlisted fields with no side effect on next_due_date', async () => {
    const created = await create({ day_of_month: 20 });
    const updated = await t.request
      .patch(`/api/v1/expenses/recurring-schedules/${created.body.data.id}`)
      .set('Authorization', `Bearer ${manager()}`)
      .send({ amount: '600000.00', payee: 'New Landlord' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.amount).toBe('600000.00');
    expect(updated.body.data.next_due_date).toBe(created.body.data.next_due_date);
  });

  it('changing the frequency recomputes next_due_date from today, inclusively', async () => {
    const created = await create({ day_of_month: 20 }); // next_due_date = 2027-01-20
    const updated = await t.request
      .patch(`/api/v1/expenses/recurring-schedules/${created.body.data.id}`)
      .set('Authorization', `Bearer ${manager()}`)
      .send({ day_of_month: 15 }); // matches today (BUSINESS_DATE) exactly
    expect(updated.status).toBe(200);
    expect(updated.body.data.next_due_date).toBe(BUSINESS_DATE);
  });

  it('pauses and resumes a schedule; resuming a stale next_due_date recomputes it forward, never bulk-catching-up', async () => {
    const created = await create({ day_of_month: 16 }); // due tomorrow
    const paused = await t.request.post(`/api/v1/expenses/recurring-schedules/${created.body.data.id}/pause`).set('Authorization', `Bearer ${manager()}`).send({});
    expect(paused.status).toBe(200);
    expect(paused.body.data.status).toBe('paused');

    // Advance the business date well past the original next_due_date while paused.
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-03-01' });

    const resumed = await t.request.post(`/api/v1/expenses/recurring-schedules/${created.body.data.id}/resume`).set('Authorization', `Bearer ${manager()}`).send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.status).toBe('active');
    // Recomputed forward from today (2027-03-01), not left at the stale 2027-01-16.
    expect(resumed.body.data.next_due_date).toBe('2027-03-16');

    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
  });

  it('cross-tenant: fetching or updating another tenant\'s schedule id is a 404', async () => {
    await setRole(ctx.b, 0, 'manager');
    const otherToken = tokenFor(ctx.b, ctx.b.users[0].id);
    await t.trx('properties').where({ id: ctx.b.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
    const otherSchedule = await t.request
      .post('/api/v1/expenses/recurring-schedules')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ expense_category_id: ctx.b.expenseCategories[0].id, description: 'Other', amount: '1.00', currency: 'NGN', payment_method: 'cash', frequency: 'monthly', day_of_month: 1 });
    expect(otherSchedule.status).toBe(201);

    const get = await t.request.get(`/api/v1/expenses/recurring-schedules/${otherSchedule.body.data.id}`).set('Authorization', `Bearer ${manager()}`);
    expect(get.status).toBe(404);

    const update = await t.request.patch(`/api/v1/expenses/recurring-schedules/${otherSchedule.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ amount: '2.00' });
    expect(update.status).toBe(404);
  });

  it('RBAC: housekeeping (no expenses.view/manage) is refused reading and creating', async () => {
    const list = await t.request.get('/api/v1/expenses/recurring-schedules').set('Authorization', `Bearer ${housekeeping()}`);
    expect(list.status).toBe(403);
    const createRes = await create({}, housekeeping());
    expect(createRes.status).toBe(403);
  });
});
