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
 * Also covers `itemsSoldWithoutCost` — a real, user-reported gap
 * closure: a menu item sold with no recipe never contributes to Cost of
 * Sales (see `expenses/reporting.js`'s own header), which silently
 * overstates Gross Profit unless flagged.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { sumMoney: sumMoneyForTest } = require('../../src/shared/money');
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');

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
    const [menuItemId] = await insertMenuItem(t.trx, {
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
    expect(statement.itemsSoldWithoutCost).toBe(1); // flagged, not silently zeroed — exactly the beforeAll item
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
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'COGS Item', category: 'Beverages', price: '10.00' });
    const [stockItemId] = await insertStockItem(t.trx, {
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
    expect(statement.itemsSoldWithoutCost).toBe(1);
  });

  describe('cost_price fallback (menu items sold with no stock movement)', () => {
    const propertyId = () => ctx.a.properties[0].id;
    let outletId;
    let terminalId;
    let counter = 0;

    beforeAll(async () => {
      const suffix = Date.now().toString(36);
      [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId(), code: `CPF-${suffix}`, name: 'CP Fallback Outlet', type: 'bar' });
      [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId(), outlet_id: outletId, device_ref: `CPF-TERM-${suffix}` });
    });

    async function newItem({ costPrice = null, price = '400.00' } = {}) {
      counter += 1;
      const [id] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId(), outlet_id: outletId, name: `CPF Item ${counter}`, category: 'Beverages', price, cost_price: costPrice });
      return id;
    }

    async function addRecipe(menuItemId, purchaseCost = '4.00') {
      counter += 1;
      const [stockItemId] = await insertStockItem(t.trx, {
        tenant_id: ctx.a.id, property_id: propertyId(), outlet_id: outletId, name: `CPF Stock ${counter}`, unit: 'ml', purchase_cost: purchaseCost, reorder_level: '0.000', current_quantity: '10000.000',
      });
      const res = await t.request
        .put(`/api/v1/pos/stock/menu-items/${menuItemId}/components`)
        .set('Authorization', `Bearer ${manager()}`)
        .send({ components: [{ stock_item_id: stockItemId, quantity: '1.000' }] });
      expect(res.status).toBe(200);
      return stockItemId;
    }

    async function sell(lines) {
      const order = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${manager()}`).send({ outlet_id: outletId, terminal_id: terminalId, table_label: `CPF${(counter += 1)}` });
      for (const [menuItemId, quantity] of lines) {
        const added = await t.request.post(`/api/v1/pos/orders/${order.body.data.id}/items`).set('Authorization', `Bearer ${manager()}`).send({ menu_item_id: menuItemId, quantity });
        expect(added.status).toBe(200);
      }
      const settled = await t.request.post(`/api/v1/pos/orders/${order.body.data.id}/settle`).set('Authorization', `Bearer ${manager()}`).set('Idempotency-Key', idemKey()).send({ settlements: [{ method: 'cash' }] });
      expect(settled.status).toBe(200);
      return { orderId: order.body.data.id, settlementId: settled.body.data.settlements[0].id };
    }

    async function statement() {
      const res = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`).set('Authorization', `Bearer ${manager()}`);
      expect(res.status).toBe(200);
      return res.body.data;
    }

    const delta = (after, before, key) => sumMoneyForTest([after[key], `-${before[key]}`]);

    it('an item with no recipe is costed at quantity x cost_price, shown as its own sub-line, and gross profit falls by exactly that', async () => {
      const item = await newItem({ costPrice: '600.00' });
      const before = await statement();
      await sell([[item, 2]]);
      const after = await statement();

      expect(delta(after, before, 'costOfSales')).toBe('1200.00');
      expect(delta(after, before, 'costOfSalesFromCostPrice')).toBe('1200.00');
      expect(delta(after, before, 'grossProfit')).toBe(sumMoneyForTest([delta(after.revenue, before.revenue, 'totalRevenue'), '-1200.00']));
      expect(after.itemsSoldWithoutCost).toBe(before.itemsSoldWithoutCost);
    });

    it('a recipe item is costed from the stock ledger only, even when it also carries a cost_price (never counted twice)', async () => {
      const item = await newItem({ costPrice: '999.00' });
      await addRecipe(item, '4.00');
      const before = await statement();
      await sell([[item, 3]]);
      const after = await statement();

      expect(delta(after, before, 'costOfSales')).toBe('12.00'); // 3 x 4.00 from the ledger, none of the 999.00
      expect(delta(after, before, 'costOfSalesFromCostPrice')).toBe('0.00');
    });

    it('a recipe removed after the sale is not double counted: the ledger already holds it, so the item is flagged instead', async () => {
      const item = await newItem({ costPrice: '50.00' });
      await addRecipe(item, '4.00');
      const before = await statement();
      await sell([[item, 1]]);
      await t.request.put(`/api/v1/pos/stock/menu-items/${item}/components`).set('Authorization', `Bearer ${manager()}`).send({ components: [] });
      const after = await statement();

      expect(delta(after, before, 'costOfSales')).toBe('4.00'); // the ledger movement only
      expect(delta(after, before, 'costOfSalesFromCostPrice')).toBe('0.00');
      expect(after.itemsSoldWithoutCost).toBe(before.itemsSoldWithoutCost + 1);
    });

    it('a recipe added after the sale does not hide it: no movement was written, so cost_price covers that sale', async () => {
      const item = await newItem({ costPrice: '30.00' });
      const before = await statement();
      await sell([[item, 2]]);
      await addRecipe(item, '4.00');
      const after = await statement();

      expect(delta(after, before, 'costOfSalesFromCostPrice')).toBe('60.00');
      expect(delta(after, before, 'costOfSales')).toBe('60.00');
    });

    it('in a mixed tab each line is judged on its own: recipe item from the ledger, plain item from cost_price', async () => {
      const recipeItem = await newItem({});
      await addRecipe(recipeItem, '4.00');
      const plainItem = await newItem({ costPrice: '100.00' });
      const before = await statement();
      await sell([[recipeItem, 1], [plainItem, 2]]);
      const after = await statement();

      expect(delta(after, before, 'costOfSales')).toBe('204.00'); // 4.00 ledger + 2 x 100.00
      expect(delta(after, before, 'costOfSalesFromCostPrice')).toBe('200.00');
    });

    it('an item with no recipe and no cost_price adds no cost and is flagged', async () => {
      const item = await newItem({});
      const before = await statement();
      await sell([[item, 1]]);
      const after = await statement();

      expect(delta(after, before, 'costOfSales')).toBe('0.00');
      expect(after.itemsSoldWithoutCost).toBe(before.itemsSoldWithoutCost + 1);
    });

    it('a voided settlement adds nothing', async () => {
      const item = await newItem({ costPrice: '77.00' });
      const before = await statement();
      const { orderId, settlementId } = await sell([[item, 1]]);
      const voided = await t.request
        .post(`/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`)
        .set('Authorization', `Bearer ${manager()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'test void' });
      expect(voided.status).toBe(200);
      const after = await statement();

      expect(delta(after, before, 'costOfSales')).toBe('0.00');
      expect(delta(after, before, 'costOfSalesFromCostPrice')).toBe('0.00');
    });

    it('CSV carries the cost-price estimate note', async () => {
      const csv = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv`).set('Authorization', `Bearer ${manager()}`);
      expect(csv.text).toContain('estimated from item cost price');
    });
  });

  it('a period with real revenue but zero expenses: net profit exactly equals gross profit', async () => {
    // ZERO_EXPENSE_DATE has neither a booking nor a POS sale nor an expense —
    // every figure must be genuinely 0.00, not merely "no error."
    const res = await t.request.get(`/api/v1/expenses/reports/profit?date_from=${ZERO_EXPENSE_DATE}&date_to=${ZERO_EXPENSE_DATE}`).set('Authorization', `Bearer ${manager()}`);
    const statement = res.body.data;
    expect(statement.revenue.totalRevenue).toBe('0.00');
    expect(statement.costOfSales).toBe('0.00');
    expect(statement.itemsSoldWithoutCost).toBe(0); // honestly zero, not a stale warning
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

  describe('unauditedDates (which days the room-revenue caveat is about)', () => {
    const DAYS = ['2031-05-01', '2031-05-02', '2031-05-03', '2031-05-04'];

    async function closeDay(date) {
      const [runId] = await t.trx('night_audit_runs').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        business_date: date,
        status: 'COMPLETED',
        worker_id: 'unaudited-dates-test',
        heartbeat_at: new Date(),
        started_at: new Date(),
        completed_at: new Date(),
      });
      await t.trx('daily_reports').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        night_audit_run_id: runId,
        business_date: date,
        room_revenue: '100.00',
        pos_revenue: '0.00',
        payments_collected: '0.00',
        occupancy_pct: '10.00',
        adr: '100.00',
        revpar: '10.00',
      });
    }

    const profit = (from, to, extra = '') =>
      t.request.get(`/api/v1/expenses/reports/profit?date_from=${from}&date_to=${to}${extra}`).set('Authorization', `Bearer ${manager()}`);

    it('lists exactly the days with no Night Audit snapshot; fully audited when none are missing', async () => {
      await closeDay(DAYS[0]);
      await closeDay(DAYS[1]);
      await closeDay(DAYS[3]);

      const gap = (await profit(DAYS[0], DAYS[3])).body.data.revenue;
      expect(gap.unauditedDates).toEqual([DAYS[2]]);
      expect(gap.roomRevenueFullyAudited).toBe(false);

      const clean = (await profit(DAYS[0], DAYS[1])).body.data.revenue;
      expect(clean.unauditedDates).toEqual([]);
      expect(clean.roomRevenueFullyAudited).toBe(true);
    });

    it('does not change any revenue figure, and the CSV names the unaudited day', async () => {
      const withGap = (await profit(DAYS[0], DAYS[3])).body.data;
      // Audited days read the snapshot (100.00 each x3); the unaudited day is the live figure (no bookings that night).
      expect(withGap.revenue.roomRevenue).toBe('300.00');

      const csv = await profit(DAYS[0], DAYS[3], '&format=csv');
      expect(csv.text).toContain(`not reconciled by Night Audit for 1 day(s): ${DAYS[2]}`);
      const cleanCsv = await profit(DAYS[0], DAYS[1], '&format=csv');
      expect(cleanCsv.text).not.toContain('not reconciled by Night Audit');
    });
  });

  describe('room revenue: audited (actual) vs open days (estimate), and the estimate-vs-posted variance', () => {
    // BUSINESS_DATE (2027-04-01) carries the one real booked night from
    // beforeAll and has no Night Audit snapshot, so it is an estimated day.
    const AUDITED = ['2027-03-30', '2027-03-31'];
    const profit = (from, to, extra = '') =>
      t.request.get(`/api/v1/expenses/reports/profit?date_from=${from}&date_to=${to}${extra}`).set('Authorization', `Bearer ${manager()}`);

    async function closeDay(date, revenue) {
      const [runId] = await t.trx('night_audit_runs').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        business_date: date,
        status: 'COMPLETED',
        worker_id: 'estimate-vs-actual-test',
        heartbeat_at: new Date(),
        started_at: new Date(),
        completed_at: new Date(),
      });
      await t.trx('daily_reports').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        night_audit_run_id: runId,
        business_date: date,
        room_revenue: revenue,
        pos_revenue: '0.00',
        payments_collected: '0.00',
        occupancy_pct: '10.00',
        adr: '100.00',
        revpar: '10.00',
      });
    }

    async function postedRoomCharge(tenant, { amount, date, currency = 'NGN', description = 'Room charge', voided = false }) {
      const folio = tenant.folios[0];
      const [id] = await t.trx('folio_line_items').insert({
        tenant_id: tenant.id,
        property_id: folio.property_id,
        folio_id: folio.id,
        type: 'room_charge',
        description,
        amount,
        currency,
        business_date: date,
        ...(voided ? { voided_at: new Date(), void_reason: 'test', voided_by_user_id: tenant.users[0].id } : {}),
      });
      return id;
    }

    beforeAll(async () => {
      await closeDay(AUDITED[0], '100.00');
      await closeDay(AUDITED[1], '100.00');
    });

    it('splits room revenue into audited + estimated, and the two always add up to room revenue', async () => {
      const { revenue } = (await profit(AUDITED[0], BUSINESS_DATE)).body.data;
      expect(revenue.roomRevenueAudited).toBe('200.00');
      expect(Number(revenue.roomRevenueEstimated)).toBeGreaterThan(0); // the real booked night on BUSINESS_DATE
      expect(sumMoneyForTest([revenue.roomRevenueAudited, revenue.roomRevenueEstimated])).toBe(revenue.roomRevenue);
    });

    it('a fully audited range has no estimate and no variance, and the CSV shows no split lines', async () => {
      const { revenue } = (await profit(AUDITED[0], AUDITED[1])).body.data;
      expect(revenue.roomRevenueAudited).toBe('200.00');
      expect(revenue.roomRevenueEstimated).toBe('0.00');
      expect(revenue.estimateVariance).toEqual({ days: [], total: '0.00' });
      const csv = (await profit(AUDITED[0], AUDITED[1], '&format=csv')).text;
      expect(csv).not.toContain('open days (estimate');
    });

    it('lists an estimated day whose booked rate differs from what was posted, and the variance clears when they agree', async () => {
      const before = (await profit(BUSINESS_DATE, BUSINESS_DATE)).body.data.revenue;
      const estimated = before.roomRevenueEstimated;
      expect(before.estimateVariance.days).toEqual([{ date: BUSINESS_DATE, estimated, posted: '0.00', difference: estimated }]);

      const line = await postedRoomCharge(ctx.a, { amount: estimated, date: BUSINESS_DATE });
      expect((await profit(BUSINESS_DATE, BUSINESS_DATE)).body.data.revenue.estimateVariance).toEqual({ days: [], total: '0.00' });

      // A different posted amount is a variance again, and the CSV names the day.
      await t.trx('folio_line_items').where({ id: line }).update({ amount: '1.00' });
      const off = (await profit(BUSINESS_DATE, BUSINESS_DATE)).body.data.revenue.estimateVariance;
      expect(off.days).toEqual([{ date: BUSINESS_DATE, estimated, posted: '1.00', difference: sumMoneyForTest([estimated, '-1.00']) }]);
      expect((await profit(BUSINESS_DATE, BUSINESS_DATE, '&format=csv')).text).toContain(`Note: ${BUSINESS_DATE} estimate ${estimated} differs from posted room charges 1.00`);
      await t.trx('folio_line_items').where({ id: line }).update({ amount: estimated });
    });

    it('voided, other-currency, Late room charge and other-tenant lines are never treated as posted', async () => {
      const day = BUSINESS_DATE;
      const base = (await profit(day, day)).body.data.revenue.estimateVariance;
      await postedRoomCharge(ctx.a, { amount: '50.00', date: day, voided: true });
      await postedRoomCharge(ctx.a, { amount: '50.00', date: day, currency: 'USD' });
      await postedRoomCharge(ctx.a, { amount: '50.00', date: day, description: 'Late room charge — 2027-03-20' });
      await postedRoomCharge(ctx.b, { amount: '50.00', date: day });
      expect((await profit(day, day)).body.data.revenue.estimateVariance).toEqual(base);
    });

    it('does not change any total: room revenue is the same with or without posted charges', async () => {
      const day = '2027-03-29'; // a day with no booking, no snapshot
      const a = (await profit(day, day)).body.data;
      await postedRoomCharge(ctx.a, { amount: '75.00', date: day });
      const b = (await profit(day, day)).body.data;
      expect(b.revenue.roomRevenue).toBe(a.revenue.roomRevenue);
      expect(b.revenue.totalRevenue).toBe(a.revenue.totalRevenue);
      expect(b.revenue.estimateVariance.days).toEqual([{ date: day, estimated: '0.00', posted: '75.00', difference: '-75.00' }]);
    });
  });

  describe('Other income (folio adjustments)', () => {
    const profit = (from, to, extra = '') =>
      t.request.get(`/api/v1/expenses/reports/profit?date_from=${from}&date_to=${to}${extra}`).set('Authorization', `Bearer ${manager()}`);

    async function line(tenant, { type = 'adjustment', amount, date, currency = 'NGN', related = null, voided = false, description = 'Other income test' }) {
      const folio = tenant.folios[0];
      const [id] = await t.trx('folio_line_items').insert({
        tenant_id: tenant.id,
        property_id: folio.property_id,
        folio_id: folio.id,
        type,
        description,
        amount,
        currency,
        business_date: date,
        related_line_item_id: related,
        ...(voided ? { voided_at: new Date(), void_reason: 'test', voided_by_user_id: tenant.users[0].id } : {}),
      });
      return id;
    }

    it('with no adjustments the statement is unchanged: other income is zero and total revenue is room + POS', async () => {
      const day = '2032-02-01';
      const { revenue } = (await profit(day, day)).body.data;
      expect(revenue.otherIncome).toEqual({ fees: '0.00', discounts: '0.00', total: '0.00' });
      expect(revenue.totalRevenue).toBe(sumMoneyForTest([revenue.roomRevenue, revenue.posRevenue]));
    });

    it('a fee adds and a discount subtracts, flowing through to gross and net profit', async () => {
      const day = '2032-02-02';
      await line(ctx.a, { amount: '500.00', date: day, description: 'Late checkout fee' });
      await line(ctx.a, { amount: '-120.00', date: day, description: 'Goodwill discount' });
      const statement = (await profit(day, day)).body.data;

      expect(statement.revenue.otherIncome).toEqual({ fees: '500.00', discounts: '-120.00', total: '380.00' });
      expect(statement.revenue.totalRevenue).toBe('380.00');
      expect(statement.grossProfit).toBe('380.00');
      expect(statement.netProfit).toBe('380.00');
    });

    it('voided adjustments, pos_charge, room_charge, tax, payments and POS-tip adjustments are never counted', async () => {
      const day = '2032-02-03';
      await line(ctx.a, { amount: '70.00', date: day, voided: true });
      await line(ctx.a, { type: 'room_charge', amount: '999.00', date: day });
      await line(ctx.a, { type: 'tax', amount: '75.00', date: day });
      await line(ctx.a, { type: 'payment', amount: '-999.00', date: day });
      const posCharge = await line(ctx.a, { type: 'pos_charge', amount: '400.00', date: day });
      await line(ctx.a, { amount: '30.00', date: day, related: posCharge, description: 'POS tip/service charge' });
      const statement = (await profit(day, day)).body.data;

      expect(statement.revenue.otherIncome.total).toBe('0.00');
      expect(statement.revenue.totalRevenue).toBe(sumMoneyForTest([statement.revenue.roomRevenue, statement.revenue.posRevenue]));
    });

    it('an adjustment correcting a room charge is counted (it is not a POS tip)', async () => {
      const day = '2032-02-04';
      const roomLine = await line(ctx.a, { type: 'room_charge', amount: '200.00', date: day });
      await line(ctx.a, { amount: '-50.00', date: day, related: roomLine, description: 'Rate correction' });
      expect((await profit(day, day)).body.data.revenue.otherIncome.discounts).toBe('-50.00');
    });

    it('adjustments in another currency are not summed, and are reported', async () => {
      const day = '2032-02-05';
      await line(ctx.a, { amount: '100.00', date: day, currency: 'USD' });
      await line(ctx.a, { amount: '10.00', date: day });
      const statement = (await profit(day, day)).body.data;

      expect(statement.revenue.otherIncome.total).toBe('10.00');
      expect(statement.adjustmentsInOtherCurrency).toBe(1);
      const csv = (await profit(day, day, '&format=csv')).text;
      expect(csv).toContain('1 folio adjustment(s) in another currency are not included in revenue');
    });

    it('only adjustments dated inside the range count, and another tenant\'s never do', async () => {
      await line(ctx.a, { amount: '11.00', date: '2032-02-10' });
      await line(ctx.a, { amount: '22.00', date: '2032-02-11' });
      await line(ctx.a, { amount: '33.00', date: '2032-02-12' });
      await line(ctx.b, { amount: '9000.00', date: '2032-02-11' });

      expect((await profit('2032-02-11', '2032-02-11')).body.data.revenue.otherIncome.total).toBe('22.00');
      expect((await profit('2032-02-10', '2032-02-12')).body.data.revenue.otherIncome.total).toBe('66.00');
    });

    it('the CSV shows the two other-income lines only when there are adjustments', async () => {
      const withAdj = (await profit('2032-02-02', '2032-02-02', '&format=csv')).text;
      expect(withAdj).toContain('Fees and other charges');
      expect(withAdj).toContain('Discounts and corrections (net)');
      const without = (await profit('2032-02-01', '2032-02-01', '&format=csv')).text;
      expect(without).not.toContain('Fees and other charges');
    });
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
    expect(profitCsv.text).toContain('no cost (no recipe deduction and no cost price)');
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
