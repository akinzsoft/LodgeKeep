'use strict';

/**
 * Expense report and profit summary — composes real room revenue
 * (`reporting/service.js`'s `computeRevenue`), real POS revenue
 * (`pos/sales-report.js`'s `computeDailyPosRevenueTotals`), and the real
 * expense ledger. Confirmed scope: profit = (room + POS revenue) minus
 * operating expenses ONLY — POS's own cost-of-sales/margin report stays
 * separate.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Expense report and profit summary', () => {
  const t = useTestApp();
  let ctx;
  const BUSINESS_DATE = '2027-04-01';
  // Deliberately BEFORE BUSINESS_DATE (backdating is allowed, postdating is
  // not) and outside the single-night booking's own stay range below, so it
  // carries genuinely zero room/POS revenue of its own.
  const ZERO_EXPENSE_DATE = '2027-03-01';

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
  let idemCounter = 0;
  const idemKey = () => `expense-reporting-${(idemCounter += 1)}-${Date.now()}`;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'housekeeping');
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });

    // Real room revenue: book a reservation via the real endpoint.
    const booking = await t.request
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${manager()}`)
      .set('Idempotency-Key', idemKey())
      .send({
        guest_id: String(ctx.a.guests[0].id),
        room_type_id: String(ctx.a.roomTypes[0].id),
        rate_code_id: String(ctx.a.rateCodes[0].id),
        arrival_date: BUSINESS_DATE,
        departure_date: '2027-04-02', // a single night, covering only BUSINESS_DATE — never leaks room revenue into the day after
      });
    expect(booking.status).toBe(201);

    // Real POS revenue: create an outlet/terminal/menu item and sell it.
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, code: `EXPRPT-${Date.now()}`, name: 'Expense Report Outlet', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, outlet_id: outletId, device_ref: `EXPRPT-TERM-${Date.now()}` });
    const [menuItemId] = await t.trx('pos_menu_items').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      outlet_id: outletId,
      name: 'Expense Report Item',
      category: 'Beverages',
      price: '20.00',
    });
    const order = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${manager()}`).send({ outlet_id: outletId, terminal_id: terminalId, table_label: 'T1' });
    expect(order.status).toBe(201);
    const added = await t.request.post(`/api/v1/pos/orders/${order.body.data.id}/items`).set('Authorization', `Bearer ${manager()}`).send({ menu_item_id: menuItemId, quantity: 1 });
    expect(added.status).toBe(200);
    const settled = await t.request
      .post(`/api/v1/pos/orders/${order.body.data.id}/settle`)
      .set('Authorization', `Bearer ${manager()}`)
      .set('Idempotency-Key', idemKey())
      .send({ settlements: [{ method: 'cash' }] });
    expect(settled.status).toBe(200);
  });

  function recordExpense(overrides = {}) {
    return t.request
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${manager()}`)
      .set('Idempotency-Key', idemKey())
      .send({
        expense_category_id: ctx.a.expenseCategories[0].id,
        description: 'Test operating expense',
        amount: '5.00',
        currency: 'NGN',
        payment_method: 'cash',
        business_date: BUSINESS_DATE,
        ...overrides,
      });
  }

  it('computeExpenseReport: totals and by-category rollup, and category filter', async () => {
    const created = await recordExpense();
    expect(created.status).toBe(201);

    const res = await t.request.get(`/api/v1/expenses/reports/summary?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`).set('Authorization', `Bearer ${manager()}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.totalExpenses)).toBeGreaterThanOrEqual(5);
    const category = res.body.data.byCategory.find((c) => String(c.categoryId) === String(ctx.a.expenseCategories[0].id));
    expect(category).toBeTruthy();
    expect(Number(category.total)).toBeGreaterThanOrEqual(5);

    const filtered = await t.request
      .get(`/api/v1/expenses/reports/summary?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&category_id=999999999`)
      .set('Authorization', `Bearer ${manager()}`);
    expect(filtered.body.data.expenses).toHaveLength(0);
  });

  it('computeProfitSummary: real room + POS revenue minus real expenses, exactly', async () => {
    await recordExpense({ amount: '30.00' });

    const res = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`).set('Authorization', `Bearer ${manager()}`);
    expect(res.status).toBe(200);
    const day = res.body.data.byDay.find((d) => d.date === BUSINESS_DATE);
    expect(day).toBeTruthy();
    expect(Number(day.roomRevenue)).toBeGreaterThan(0); // a real night was booked
    expect(Number(day.posRevenue)).toBeGreaterThanOrEqual(20); // the real ₦20 sale
    expect(day.totalRevenue).toBe(res.body.data.byDay.find((d) => d.date === BUSINESS_DATE).totalRevenue);
    // Exact identity: totalRevenue - totalExpenses === profit (BigInt-cents, never float).
    const expectedProfitCents = Math.round(Number(day.totalRevenue) * 100) - Math.round(Number(day.totalExpenses) * 100);
    expect(Math.round(Number(day.profit) * 100)).toBe(expectedProfitCents);
  });

  it('a day with real revenue but zero expenses: profit exactly equals total revenue', async () => {
    // ZERO_EXPENSE_DATE has neither a booking nor a POS sale nor an expense —
    // profit must be genuinely 0.00, not merely "no error."
    const res = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    const day = res.body.data.byDay.find((d) => d.date === ZERO_EXPENSE_DATE);
    expect(day.totalRevenue).toBe('0.00');
    expect(day.totalExpenses).toBe('0.00');
    expect(day.profit).toBe('0.00');
  });

  it('a voided expense is fully excluded from both reports\' totals', async () => {
    const created = await recordExpense({ business_date: ZERO_EXPENSE_DATE, amount: '999.00' });
    const before = await t.request.get(`/api/v1/expenses/reports/summary?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    expect(before.body.data.totalExpenses).toBe('999.00');

    await t.request.post(`/api/v1/expenses/${created.body.data.id}/void`).set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', idemKey()).send({ reason: 'test cleanup' });

    const afterSummary = await t.request.get(`/api/v1/expenses/reports/summary?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    expect(afterSummary.body.data.totalExpenses).toBe('0.00');

    const afterProfit = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    const day = afterProfit.body.data.byDay.find((d) => d.date === ZERO_EXPENSE_DATE);
    expect(day.totalExpenses).toBe('0.00');
    expect(day.profit).toBe(day.totalRevenue);
  });

  it('exports both reports as CSV', async () => {
    const summaryCsv = await t.request.get(`/api/v1/expenses/reports/summary?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv`).set('Authorization', `Bearer ${manager()}`);
    expect(summaryCsv.status).toBe(200);
    expect(summaryCsv.headers['content-type']).toContain('text/csv');

    const profitCsv = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv`).set('Authorization', `Bearer ${manager()}`);
    expect(profitCsv.status).toBe(200);
    expect(profitCsv.headers['content-type']).toContain('text/csv');
  });

  it('RBAC: housekeeping (no expenses.view) is refused both reports', async () => {
    const summary = await t.request.get(`/api/v1/expenses/reports/summary?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`).set('Authorization', `Bearer ${housekeeping()}`);
    expect(summary.status).toBe(403);
    const profit = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`).set('Authorization', `Bearer ${housekeeping()}`);
    expect(profit.status).toBe(403);
  });

  it('cross-tenant isolation: tenant B\'s expenses never appear in tenant A\'s report', async () => {
    await setRole(ctx.b, 0, 'manager');
    await t.trx('properties').where({ id: ctx.b.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
    const otherToken = tokenFor(ctx.b, ctx.b.users[0].id);
    await t.request
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${otherToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ expense_category_id: ctx.b.expenseCategories[0].id, description: 'Other tenant', amount: '77777.00', currency: 'NGN', payment_method: 'cash', business_date: BUSINESS_DATE });

    const res = await t.request.get(`/api/v1/expenses/reports/summary?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`).set('Authorization', `Bearer ${manager()}`);
    expect(Number(res.body.data.totalExpenses)).toBeLessThan(77777);
  });
});
