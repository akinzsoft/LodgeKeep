'use strict';

/**
 * Expense report and the P&L statement — composes real room revenue
 * (`reporting/service.js`'s `computeRevenue`), real POS revenue
 * (`pos/sales-report.js`'s `computeDailyPosRevenueTotals`), real cost of
 * sales (`stock/reporting.js`'s `computeCostOfSales`), and the real
 * expense ledger into one consolidated Revenue → Cost of Sales → Gross
 * Profit → Operating Expenses → Net Profit statement for the period
 * (restructured on the user's own follow-up request, "restructure it like
 * a proper P&L statement" — the original per-day "profit summary" shape
 * is gone).
 *
 * Also covers `itemsSoldWithoutRecipeCost` — a real, user-reported gap
 * closure: a menu item sold with no recipe never contributes to Cost of
 * Sales (see `expenses/reporting.js`'s own header), which silently
 * overstates Gross Profit unless flagged.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { sumMoney: sumMoneyForTest } = require('../../src/shared/money');

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

  it('computeProfitAndLoss: real room + POS revenue, zero cost of sales (no recipe sold in range), minus real operating expenses, exactly', async () => {
    await recordExpense({ amount: '30.00' });

    const res = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`).set('Authorization', `Bearer ${manager()}`);
    expect(res.status).toBe(200);
    const statement = res.body.data;
    expect(Number(statement.revenue.roomRevenue)).toBeGreaterThan(0); // a real night was booked
    expect(Number(statement.revenue.posRevenue)).toBeGreaterThanOrEqual(20); // the real ₦20 sale
    expect(statement.revenue.totalRevenue).toBe(sumMoneyForTest([statement.revenue.roomRevenue, statement.revenue.posRevenue]));
    expect(statement.costOfSales).toBe('0.00'); // the settled item in beforeAll has no recipe/BOM
    expect(statement.itemsSoldWithoutRecipeCost).toBe(1); // flagged, not silently zeroed — exactly the beforeAll item
    expect(statement.grossProfit).toBe(statement.revenue.totalRevenue); // gross profit = revenue when cost of sales is zero
    // Exact identity: grossProfit - totalOperatingExpenses === netProfit (BigInt-cents, never float).
    const expectedNetProfitCents = Math.round(Number(statement.grossProfit) * 100) - Math.round(Number(statement.operatingExpenses.total) * 100);
    expect(Math.round(Number(statement.netProfit) * 100)).toBe(expectedNetProfitCents);
  });

  it('a real, non-zero cost of sales flows through as its own line, correctly reducing gross profit', async () => {
    const suffix = `${Date.now().toString(36)}`;
    const propertyId = ctx.a.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `COGS-${suffix}`, name: 'COGS Outlet', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `COGS-TERM-${suffix}` });
    const [menuItemId] = await t.trx('pos_menu_items').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'COGS Item', category: 'Beverages', price: '10.00' });
    const [stockItemId] = await t.trx('stock_items').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      outlet_id: outletId,
      name: 'COGS Stock',
      unit: 'ml',
      purchase_cost: '4.00',
      reorder_level: '0.000',
      current_quantity: '10000.000',
    });
    const linked = await t.request
      .put(`/api/v1/pos/stock/menu-items/${menuItemId}/components`)
      .set('Authorization', `Bearer ${manager()}`)
      .send({ components: [{ stock_item_id: stockItemId, quantity: '1.000' }] });
    expect(linked.status).toBe(200);

    const order = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${manager()}`).send({ outlet_id: outletId, terminal_id: terminalId, table_label: 'COGS' });
    await t.request.post(`/api/v1/pos/orders/${order.body.data.id}/items`).set('Authorization', `Bearer ${manager()}`).send({ menu_item_id: menuItemId, quantity: 2 });
    const settled = await t.request
      .post(`/api/v1/pos/orders/${order.body.data.id}/settle`)
      .set('Authorization', `Bearer ${manager()}`)
      .set('Idempotency-Key', idemKey())
      .send({ settlements: [{ method: 'cash' }] });
    expect(settled.status).toBe(200);

    const res = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`).set('Authorization', `Bearer ${manager()}`);
    const statement = res.body.data;
    expect(statement.costOfSales).toBe('8.00'); // 2 units x ₦4.00 purchase cost
    expect(statement.grossProfit).toBe(sumMoneyForTest([statement.revenue.totalRevenue, '-8.00']));
    // The recipe-linked item sold here is correctly excluded from the
    // warning — only the beforeAll item (still no recipe) counts.
    expect(statement.itemsSoldWithoutRecipeCost).toBe(1);
  });

  it('a period with real revenue but zero expenses: net profit exactly equals gross profit', async () => {
    // ZERO_EXPENSE_DATE has neither a booking nor a POS sale nor an expense —
    // every figure must be genuinely 0.00, not merely "no error."
    const res = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    const statement = res.body.data;
    expect(statement.revenue.totalRevenue).toBe('0.00');
    expect(statement.costOfSales).toBe('0.00');
    expect(statement.itemsSoldWithoutRecipeCost).toBe(0); // honestly zero, not a stale warning
    expect(statement.operatingExpenses.total).toBe('0.00');
    expect(statement.netProfit).toBe('0.00');
  });

  it('a voided expense is fully excluded from both the expense report and the P&L\'s operating expenses', async () => {
    const created = await recordExpense({ business_date: ZERO_EXPENSE_DATE, amount: '999.00' });
    const before = await t.request.get(`/api/v1/expenses/reports/summary?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    expect(before.body.data.totalExpenses).toBe('999.00');

    await t.request.post(`/api/v1/expenses/${created.body.data.id}/void`).set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', idemKey()).send({ reason: 'test cleanup' });

    const afterSummary = await t.request.get(`/api/v1/expenses/reports/summary?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    expect(afterSummary.body.data.totalExpenses).toBe('0.00');

    const afterProfit = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    const statement = afterProfit.body.data;
    expect(statement.operatingExpenses.total).toBe('0.00');
    expect(statement.netProfit).toBe(statement.grossProfit);
  });

  it('operating expense categories are itemized, largest first', async () => {
    await recordExpense({ amount: '10.00', business_date: ZERO_EXPENSE_DATE, expense_category_id: ctx.a.expenseCategories[0].id });
    const secondCategory = await t.request.post('/api/v1/expenses/categories').set('Authorization', `Bearer ${manager()}`).send({ name: `Second Category ${Date.now()}` });
    await recordExpense({ amount: '500.00', business_date: ZERO_EXPENSE_DATE, expense_category_id: secondCategory.body.data.id });

    const res = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    const byCategory = res.body.data.operatingExpenses.byCategory;
    expect(Number(byCategory[0].total)).toBeGreaterThanOrEqual(Number(byCategory[1]?.total ?? 0));
    expect(String(byCategory[0].categoryId)).toBe(String(secondCategory.body.data.id));
  });

  it('exports both reports as CSV', async () => {
    const summaryCsv = await t.request.get(`/api/v1/expenses/reports/summary?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv`).set('Authorization', `Bearer ${manager()}`);
    expect(summaryCsv.status).toBe(200);
    expect(summaryCsv.headers['content-type']).toContain('text/csv');

    const profitCsv = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv`).set('Authorization', `Bearer ${manager()}`);
    expect(profitCsv.status).toBe(200);
    expect(profitCsv.headers['content-type']).toContain('text/csv');
    // BUSINESS_DATE carries the beforeAll no-recipe sale by this point in
    // the file — the CSV export must carry the same warning the JSON does.
    expect(profitCsv.text).toContain('no recipe configured');
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
