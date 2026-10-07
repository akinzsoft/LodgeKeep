'use strict';

/**
 * The P&L regrouped by department (revenue centre): Rooms, each outlet, the mini-mart, Other income and
 * Other / unmapped. It only REGROUPS the statement's existing numbers, so the tests that matter are that the
 * department totals equal the statement's totals to the kobo, the statement's own figures are exactly what they
 * were, and a department's figures are its own (revenue by the outlet that sold, cost by the outlet that consumed).
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { sumMoney } = require('../../src/shared/money');
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');
const { computeDailyPosRevenueTotals } = require('../../src/modules/pos/sales-report');
const { computeCostOfSales, computeCostPriceFallback } = require('../../src/modules/stock/reporting');
const { computeBusinessSummary } = require('../../src/modules/reporting/business-summary');
const { contextFromSession } = require('../../src/modules/tenancy');
const { scopedDb } = require('../../src/db');
const { buildDepartments } = require('../../src/modules/expenses/reporting');

const BD = '2027-05-01';

describe('Department P&L', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let counter = 0;
  const outlets = {};
  const idem = () => `dept-pnl-${(counter += 1)}-${Date.now()}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const scope = () => ({ tenant_id: ctx.a.id, property_id: propertyId });
  let managerToken;
  let martToken;

  async function setRole(userIndex, role) {
    const userId = ctx.a.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ ...scope(), user_id: userId, role });
  }
  async function outlet(type, name) {
    const [id] = await t.trx('pos_outlets').insert({ ...scope(), code: `D${Date.now().toString(36)}${(counter += 1)}`.slice(0, 30), name, type });
    let terminalId = null;
    if (type !== 'store' && type !== 'supermarket') [terminalId] = await t.trx('pos_terminals').insert({ ...scope(), outlet_id: id, device_ref: `DT${Date.now()}${counter}`.slice(0, 30) });
    return { id, terminalId };
  }
  async function item(o, { name, price, costPrice = null, recipeCost = null }) {
    const [menuItemId] = await insertMenuItem(t.trx, { ...scope(), outlet_id: o.id, name, category: 'Dept Cat', price, cost_price: costPrice });
    if (recipeCost) {
      const [stockItemId] = await insertStockItem(t.trx, { ...scope(), outlet_id: o.id, name: `${name} stock`, unit: 'unit', purchase_cost: recipeCost, reorder_level: '0.000', current_quantity: '1000.000' });
      await t.request.put(`/api/v1/pos/stock/menu-items/${menuItemId}/components`).set('Authorization', `Bearer ${managerToken}`).send({ components: [{ stock_item_id: stockItemId, quantity: '1.000' }] }).expect(200);
    }
    return menuItemId;
  }
  async function sell(o, lines, settlement = { method: 'cash' }) {
    const order = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${managerToken}`).send({ outlet_id: o.id, terminal_id: o.terminalId, table_label: `D${(counter += 1)}` }).expect(201);
    for (const [menuItemId, quantity] of lines) await t.request.post(`/api/v1/pos/orders/${order.body.data.id}/items`).set('Authorization', `Bearer ${managerToken}`).send({ menu_item_id: menuItemId, quantity }).then((r) => { if (r.status !== 200) throw new Error(JSON.stringify(r.body.error)); });
    const settled = await t.request.post(`/api/v1/pos/orders/${order.body.data.id}/settle`).set('Authorization', `Bearer ${managerToken}`).set('Idempotency-Key', idem()).send({ settlements: [settlement] });
    expect(settled.status).toBe(200);
    return { orderId: order.body.data.id, settlementId: settled.body.data.settlements[0].id };
  }
  const profit = (query = '') => t.request.get(`/api/v1/expenses/reports/profit?date_from=${BD}&date_to=${BD}${query}`).set('Authorization', `Bearer ${managerToken}`);
  const dept = (statement, name) => statement.departments.rows.find((row) => row.name === name);

  let unmappedOrderId;
  let roomChargeSettlementId;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await setRole(0, 'manager');
    managerToken = tokenFor(ctx.a.users[0].id);
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BD });

    // Rooms: one night of real room revenue.
    await t.request.post('/api/v1/reservations').set('Authorization', `Bearer ${managerToken}`).set('Idempotency-Key', idem()).send({
      guest_id: String(ctx.a.guests[0].id), room_type_id: String(ctx.a.roomTypes[0].id), rate_code_id: String(ctx.a.rateCodes[0].id), arrival_date: BD, departure_date: '2027-05-02',
    }).expect(201);

    outlets.bar = await outlet('bar', 'Dept Bar');
    outlets.restaurant = await outlet('restaurant', 'Dept Restaurant');
    outlets.pub = await outlet('bar', 'Dept Pub');
    outlets.quiet = await outlet('bar', 'Dept Quiet');
    outlets.store = await outlet('store', 'Dept Store');
    outlets.hold = await outlet('bar', 'Dept Holding');
    const mart = await outlet('supermarket', 'Dept Mart');
    outlets.mart = mart;

    // Bar: a recipe-costed drink. 2 sold for cash + 1 charged to a room: revenue 300.00, cost 90.00.
    const draught = await item(outlets.bar, { name: 'Draught', price: '100.00', recipeCost: '30.00' });
    await sell(outlets.bar, [[draught, 2]]);
    const [roomTypeId] = await t.trx('room_types').insert({ ...scope(), code: 'DP-RT', name: 'DP RT', default_occupancy: 2, base_rate: '100.00' });
    const [roomId] = await t.trx('rooms').insert({ ...scope(), room_type_id: roomTypeId, room_number: 'DP-1', status: 'active', front_desk_status: 'occupied' });
    const [rateCodeId] = await t.trx('rate_codes').insert({ ...scope(), code: 'DP-RATE', base_rate: '100.00', currency: 'NGN', valid_from: '2026-01-01' });
    const [reservationId] = await t.trx('reservations').insert({ ...scope(), guest_id: ctx.a.guests[0].id, room_type_id: roomTypeId, rate_code_id: rateCodeId, arrival_date: BD, departure_date: '2027-05-04', adults: 1, children: 0, status: 'checked_in', confirmation_number: `DPR${Date.now()}`.slice(0, 26), checked_in_at: new Date() });
    await t.trx('reservation_rooms').insert({ ...scope(), reservation_id: reservationId, room_id: roomId, effective_from: new Date(Date.now() - 60_000), effective_to: null });
    await t.trx('folios').insert({ ...scope(), reservation_id: reservationId, folio_number: `DPF${Date.now()}`.slice(0, 26), status: 'open', balance: '0.00', currency: 'NGN' });
    const lager = await item(outlets.bar, { name: 'Lager', price: '100.00', recipeCost: '30.00' });
    ({ settlementId: roomChargeSettlementId } = await sell(outlets.bar, [[lager, 1]], { method: 'room_charge', room_charge: { reservation_id: reservationId, auth_method: 'pin', auth_reference: 'PIN' } }));

    // Restaurant: a plain item costed by cost_price (2 x 50.00, cost 2 x 20.00) and one with no cost anywhere.
    const grill = await item(outlets.restaurant, { name: 'Grill', price: '50.00', costPrice: '20.00' });
    const special = await item(outlets.restaurant, { name: 'Special', price: '10.00' });
    await sell(outlets.restaurant, [[grill, 2], [special, 1]]);

    // Pub: cost higher than revenue (a bad stock cost): revenue 10.00, cost 50.00.
    const pint = await item(outlets.pub, { name: 'Pint', price: '10.00', recipeCost: '50.00' });
    await sell(outlets.pub, [[pint, 1]]);

    // A sale whose outlet can no longer be mapped (its order and movements now name a store).
    const holdItem = await item(outlets.hold, { name: 'Held', price: '40.00', recipeCost: '10.00' });
    ({ orderId: unmappedOrderId } = await sell(outlets.hold, [[holdItem, 1]]));
    await t.trx('pos_orders').where({ id: unmappedOrderId }).update({ outlet_id: outlets.store.id });
    await t.trx('stock_movements').where({ type: 'sold', outlet_id: outlets.hold.id }).update({ outlet_id: outlets.store.id });

    // Mini-mart through the real supermarket till: 2 x 25.00, cost_price 5.00.
    const martItem = await item(mart, { name: 'Mart Item', price: '25.00', costPrice: '5.00' });
    const [operator] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `dept-mart-${Date.now()}@example.com`, first_name: 'M', last_name: 'M', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ ...scope(), user_id: operator, role: 'pos_operator' });
    martToken = tokenFor(operator);
    await t.request.post('/api/v1/supermarket/sales').set('Authorization', `Bearer ${martToken}`).set('Idempotency-Key', idem()).send({ outlet_id: mart.id, method: 'cash', items: [{ menu_item_id: martItem, quantity: 2 }] }).expect(201);

    await t.request.post('/api/v1/expenses').set('Authorization', `Bearer ${managerToken}`).set('Idempotency-Key', idem()).send({
      expense_category_id: ctx.a.expenseCategories[0].id, description: 'Dept expense', amount: '25.00', currency: 'NGN', payment_method: 'cash', business_date: BD,
    }).expect(201);
  });

  it('department figures are the outlet\'s own: revenue by the selling outlet, cost by the consuming outlet', async () => {
    const s = (await profit()).body.data;
    expect(dept(s, 'Dept Bar')).toMatchObject({ kind: 'outlet', revenue: '300.00', costOfSales: '90.00', grossProfit: '210.00', costIncomplete: false, costExceedsRevenue: false, marginPct: 70 });
    expect(dept(s, 'Dept Restaurant')).toMatchObject({ kind: 'outlet', revenue: '110.00', costOfSales: '40.00', costOfSalesFromCostPrice: '40.00', grossProfit: '70.00' });
    expect(dept(s, 'Dept Mart')).toMatchObject({ kind: 'supermarket', revenue: '50.00', costOfSales: '10.00', grossProfit: '40.00' });
  });

  it('a tab charged to a room counts as the OUTLET\'s revenue, and Rooms is room-nights only with no cost of sales', async () => {
    const s = (await profit()).body.data;
    expect(dept(s, 'Dept Bar').revenue).toBe('300.00'); // 2 cash + 1 charged to a room, at 100.00
    const rooms = dept(s, 'Rooms');
    expect(rooms).toMatchObject({ kind: 'rooms', costOfSales: '0.00', revenue: s.revenue.roomRevenue, grossProfit: s.revenue.roomRevenue });
    expect(rooms.name).toBe('Rooms');
  });

  it('lists Rooms first, then outlets by name, then the mini-mart, then Other / unmapped', async () => {
    const names = (await profit()).body.data.departments.rows.map((row) => row.name);
    expect(names).toEqual(['Rooms', 'Dept Bar', 'Dept Pub', 'Dept Restaurant', 'Dept Mart', 'Other / unmapped']);
  });

  it('shows revenue that cannot be mapped to a point-of-sale outlet on its own line instead of forcing it into a department', async () => {
    const s = (await profit()).body.data;
    expect(dept(s, 'Other / unmapped')).toMatchObject({ kind: 'unmapped', revenue: '40.00', costOfSales: '10.00', grossProfit: '30.00' });
    expect(dept(s, 'Dept Holding')).toBeUndefined();
    expect(dept(s, 'Dept Store')).toBeUndefined();
  });

  it('lists active outlets with no activity in one note instead of empty rows', async () => {
    const s = (await profit()).body.data;
    expect(s.departments.quietOutlets).toContain('Dept Quiet');
    expect(s.departments.quietOutlets).not.toContain('Dept Bar');
    expect(s.departments.quietOutlets).not.toContain('Dept Store');
  });

  it('flags per department: items sold without cost (that department only) and cost above revenue', async () => {
    const s = (await profit()).body.data;
    expect(dept(s, 'Dept Restaurant')).toMatchObject({ itemsSoldWithoutCost: 1, costIncomplete: true });
    expect(dept(s, 'Dept Bar')).toMatchObject({ itemsSoldWithoutCost: 0, costIncomplete: false });
    expect(dept(s, 'Dept Pub')).toMatchObject({ revenue: '10.00', costOfSales: '50.00', grossProfit: '-40.00', costExceedsRevenue: true });
    expect(dept(s, 'Dept Mart').costExceedsRevenue).toBe(false);
  });

  it('THE guarantee: the department totals equal the statement\'s total revenue, cost of sales and gross profit, to the kobo', async () => {
    const s = (await profit()).body.data;
    expect(s.departments.reconciles).toBe(true);
    expect(s.departments.totals).toEqual({ revenue: s.revenue.totalRevenue, costOfSales: s.costOfSales, grossProfit: s.grossProfit });
    expect(sumMoney(s.departments.rows.map((row) => row.revenue))).toBe(s.revenue.totalRevenue);
    expect(sumMoney(s.departments.rows.map((row) => row.costOfSales))).toBe(s.costOfSales);
    expect(sumMoney(s.departments.rows.map((row) => row.grossProfit))).toBe(s.grossProfit);
    // Net profit still follows from the unchanged gross profit.
    expect(s.netProfit).toBe(sumMoney([s.grossProfit, `-${s.operatingExpenses.total}`]));
  });

  it('the statement\'s own figures are exactly what they were, derived from the same building blocks', async () => {
    const s = (await profit()).body.data;
    const context = contextFromSession({ tenantId: ctx.a.id, propertyId, userId: ctx.a.users[0].id });
    const db = scopedDb().for(context);
    const posRevenue = sumMoney([...(await computeDailyPosRevenueTotals({ db, dateFrom: BD, dateTo: BD })).values()]);
    const ledger = await computeCostOfSales({ context, dateFrom: BD, dateTo: BD });
    const fallback = await computeCostPriceFallback({ context, dateFrom: BD, dateTo: BD });
    expect(s.revenue.posRevenue).toBe(posRevenue);
    expect(s.revenue.totalRevenue).toBe(sumMoney([s.revenue.roomRevenue, posRevenue, s.revenue.otherIncome.total]));
    expect(s.costOfSales).toBe(sumMoney([ledger.totalCost, fallback.totalCost]));
    expect(s.costOfSalesFromCostPrice).toBe(fallback.totalCost);
    expect(s.itemsSoldWithoutCost).toBe(fallback.itemsWithoutCost);
    expect(s.grossProfit).toBe(sumMoney([s.revenue.totalRevenue, `-${s.costOfSales}`]));
    // And the per-outlet cost the departments use sums to the same ledger/fallback totals.
    expect(sumMoney(ledger.byOutlet.map((row) => row.cost))).toBe(ledger.totalCost);
    expect(sumMoney(fallback.byOutlet.map((row) => row.cost))).toBe(fallback.totalCost);
  });

  it('keeps the existing caveats: the unaudited-room estimate fields are still on the statement', async () => {
    const s = (await profit()).body.data;
    expect(s.revenue.roomRevenueFullyAudited).toBe(false);
    expect(s.revenue.unauditedDates).toEqual([BD]);
    expect(s.revenue.roomRevenueEstimated).toBe(s.revenue.roomRevenue);
  });

  it('bridges to the Business Summary: an outlet\'s earned revenue = its collected sales before tax + the tabs charged to rooms', async () => {
    const s = (await profit()).body.data;
    const context = contextFromSession({ tenantId: ctx.a.id, propertyId, userId: ctx.a.users[0].id });
    const summary = await computeBusinessSummary({ context, dateFrom: BD, dateTo: BD });
    const bar = summary.currencies[0].rows.find((row) => row.label === 'Dept Bar');
    const charged = await t.trx('pos_order_settlements').where({ id: roomChargeSettlementId }).first('subtotal');
    expect(sumMoney([bar.breakdown.net, charged.subtotal])).toBe(dept(s, 'Dept Bar').revenue);
    // Rooms differ by design (billed here, paid there) and are labelled as such.
    expect(summary.basis).toBe('gross_collected');
  });

  it('adds the departments to the CSV without changing the existing lines', async () => {
    const res = await profit('&format=csv');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Net profit/);
    expect(res.text).toMatch(/Gross profit by department/);
    expect(res.text).toMatch(/Dept Bar: revenue,300.00/);
    expect(res.text).toMatch(/Dept Pub: gross profit,-40.00/);
    expect(res.text).toMatch(/Dept Pub cost of sales is higher than its revenue/);
  });

  it('a range with no sales still reconciles and shows Rooms only', async () => {
    const res = await t.request.get('/api/v1/expenses/reports/profit?date_from=2027-03-01&date_to=2027-03-02').set('Authorization', `Bearer ${managerToken}`);
    const s = res.body.data;
    expect(s.departments.reconciles).toBe(true);
    expect(s.departments.rows.map((row) => row.name)).toEqual(['Rooms']);
  });

  it('shows folio fees and discounts on their own Other income line, so the totals still reconcile', async () => {
    const folioId = (await t.trx('folios').where({ tenant_id: ctx.a.id }).first('id')).id;
    const [lineId] = await t.trx('folio_line_items').insert({ ...scope(), folio_id: folioId, type: 'adjustment', description: 'Late fee', amount: '12.00', currency: 'NGN', business_date: BD });
    try {
      const s = (await profit()).body.data;
      expect(s.revenue.otherIncome.total).toBe('12.00');
      expect(dept(s, 'Other income (fees and discounts)')).toMatchObject({ kind: 'other_income', revenue: '12.00', costOfSales: '0.00', grossProfit: '12.00' });
      expect(s.departments.reconciles).toBe(true);
      expect(s.departments.totals.revenue).toBe(s.revenue.totalRevenue);
    } finally {
      await t.trx('folio_line_items').where({ id: lineId }).delete();
    }
  });

  it('reports reconciles: false (rather than hiding it) if the department lines ever disagree with the statement totals', () => {
    const outlets = [{ id: '1', name: 'Bar', type: 'bar', status: 'active' }];
    const args = { outlets, roomRevenue: '10.00', outletRevenue: new Map([['1', '20.00']]), ledger: { byOutlet: [{ outletId: '1', cost: '5.00' }] }, fallback: { byOutlet: [] }, otherIncomeTotal: '0.00' };
    expect(buildDepartments({ ...args, totals: { revenue: '30.00', costOfSales: '5.00', grossProfit: '25.00' } }).reconciles).toBe(true);
    expect(buildDepartments({ ...args, totals: { revenue: '31.00', costOfSales: '5.00', grossProfit: '26.00' } }).reconciles).toBe(false);
    expect(buildDepartments({ ...args, totals: { revenue: '30.00', costOfSales: '6.00', grossProfit: '24.00' } }).reconciles).toBe(false);
  });
});
