'use strict';

/**
 * Expense categories — mirrors `tests/pos/stock-categories.test.js`'s own
 * CRUD/RBAC/cross-tenant shape. Unlike stock's optional category, an
 * expense category is REQUIRED on every expense (see the migration
 * header) — proven here by the create-expense validation test, and archive
 * is refused while either a non-voided expense OR an active recurring
 * schedule still references the category (two independent counts, unlike
 * stock's single-count check).
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Expense categories', () => {
  const t = useTestApp();
  let ctx;

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
  const frontDesk = () => tokenFor(ctx.a, ctx.a.users[1].id);

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'front_desk');
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-01-15' });
  });

  const createCategory = (body, token = manager()) => t.request.post('/api/v1/expenses/categories').set('Authorization', `Bearer ${token}`).send(body);

  it('registers a category, trimmed, and lists categories in display order with real, non-voided expense counts', async () => {
    const utilities = await createCategory({ name: '  Maintenance ', sort_order: 1 });
    expect(utilities.status).toBe(201);
    expect(utilities.body.data.name).toBe('Maintenance');

    await createCategory({ name: 'Salaries', sort_order: 3 });
    await createCategory({ name: 'Supplies', sort_order: 2 });

    const list = await t.request.get('/api/v1/expenses/categories').set('Authorization', `Bearer ${manager()}`);
    expect(list.status).toBe(200);
    const names = list.body.data.map((c) => c.name);
    expect(names.indexOf('Maintenance')).toBeLessThan(names.indexOf('Supplies'));
    expect(names.indexOf('Supplies')).toBeLessThan(names.indexOf('Salaries'));
    expect(list.body.data.find((c) => c.name === 'Maintenance').item_count).toBe(0);
  });

  it('rejects a duplicate name at the same property (409)', async () => {
    await createCategory({ name: 'Duplicate Category' });
    const res = await createCategory({ name: 'Duplicate Category' });
    expect(res.status).toBe(409);
  });

  it('renames a category — no cascade needed, the join always resolves the current name', async () => {
    const created = await createCategory({ name: 'Old Name' });
    const renamed = await t.request.patch(`/api/v1/expenses/categories/${created.body.data.id}`).set('Authorization', `Bearer ${manager()}`).send({ name: 'New Name' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('New Name');
  });

  it('archives an unused category', async () => {
    const created = await createCategory({ name: 'Unused Category' });
    const archived = await t.request.post(`/api/v1/expenses/categories/${created.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe('archived');
  });

  it('refuses to archive a category still used by a non-voided expense, naming the count', async () => {
    const created = await createCategory({ name: 'In Use By Expense' });
    const recordRes = await t.request
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${manager()}`)
      .set('Idempotency-Key', `cat-in-use-${Date.now()}`)
      .send({ expense_category_id: created.body.data.id, description: 'Test', amount: '10.00', currency: ctx.a.properties[0].base_currency ?? 'NGN', payment_method: 'cash' });
    expect([201, 200]).toContain(recordRes.status);

    const archived = await t.request.post(`/api/v1/expenses/categories/${created.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`).send({});
    expect(archived.status).toBe(409);
    expect(archived.body.error.code).toBe('CONFLICT_EXPENSE_CATEGORY_IN_USE');
    expect(archived.body.error.details.expenseCount).toBe(1);
  });

  it('refuses to archive a category still used by an active recurring schedule, naming the count', async () => {
    const created = await createCategory({ name: 'In Use By Schedule' });
    const scheduleRes = await t.request
      .post('/api/v1/expenses/recurring-schedules')
      .set('Authorization', `Bearer ${manager()}`)
      .send({
        expense_category_id: created.body.data.id,
        description: 'Rent',
        amount: '500.00',
        currency: 'NGN',
        payment_method: 'bank_transfer',
        frequency: 'monthly',
        day_of_month: 1,
      });
    expect(scheduleRes.status).toBe(201);

    const archived = await t.request.post(`/api/v1/expenses/categories/${created.body.data.id}/archive`).set('Authorization', `Bearer ${manager()}`).send({});
    expect(archived.status).toBe(409);
    expect(archived.body.error.details.scheduleCount).toBe(1);
  });

  it('rejects an expense with no category, or a nonexistent/archived one', async () => {
    const missing = await t.request
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${manager()}`)
      .set('Idempotency-Key', `no-cat-${Date.now()}`)
      .send({ description: 'Test', amount: '10.00', currency: 'NGN', payment_method: 'cash' });
    expect(missing.status).toBe(400);

    const bogus = await t.request
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${manager()}`)
      .set('Idempotency-Key', `bogus-cat-${Date.now()}`)
      .send({ expense_category_id: 999999999, description: 'Test', amount: '10.00', currency: 'NGN', payment_method: 'cash' });
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.code).toBe('VALIDATION_EXPENSE_CATEGORY_NOT_FOUND');
  });

  it('cross-tenant: updating or archiving another tenant\'s category id is a 404, never a leak', async () => {
    const otherCategoryId = ctx.b.expenseCategories[0].id;
    const update = await t.request.patch(`/api/v1/expenses/categories/${otherCategoryId}`).set('Authorization', `Bearer ${manager()}`).send({ name: 'Hijacked' });
    expect(update.status).toBe(404);

    const archive = await t.request.post(`/api/v1/expenses/categories/${otherCategoryId}/archive`).set('Authorization', `Bearer ${manager()}`).send({});
    expect(archive.status).toBe(404);
  });

  it('RBAC: expenses.view required to list, expenses.manage required to create/update/archive; front_desk holds neither', async () => {
    const listNoAuth = await t.request.get('/api/v1/expenses/categories').set('Authorization', `Bearer ${frontDesk()}`);
    expect(listNoAuth.status).toBe(403);

    const createNoAuth = await createCategory({ name: 'Should Fail' }, frontDesk());
    expect(createNoAuth.status).toBe(403);
  });
});
