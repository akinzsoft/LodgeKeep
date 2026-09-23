'use strict';

/**
 * `GET /pos/reports/sales` — totals per tender, top sellers, settled tabs,
 * CSV export, and captured card payments no settlement uses.
 *
 * Ambient tax: `tests/helpers/fixtures.js` seeds a 7.5% VAT on `ctx.a`'s
 * property, so a ₦20.00 item settles as 20.00 + 1.50 tax + 1.50 service.
 */

// Gap closure: `paystack-adapter.js` is now a factory resolved per-currency
// via `resolveAdapterForCurrency` (a real DB read of
// `platform_payment_integrations` in production, seeded for NGN by
// `tests/helpers/fixtures.js` regardless of real credentials). Mocking
// THAT function to always return one fixed, fully-mocked adapter object —
// rather than mocking the old flat exports directly — keeps every
// `paystack.xxx.mockImplementation(...)` call below working unchanged,
// while genuinely exercising `properties[0]`'s own real, fixture-seeded
// `property_payment_subaccounts` row (mirrors
// `tests/cashiering/cashiering.test.js`'s own identical fix).
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
const { signAccessToken } = require('../../src/auth/tokens');
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;

const BUSINESS_DATE = '2027-03-01';

describe('POS sales report', () => {
  const t = useTestApp();
  let ctx;
  let managerToken;
  let operatorToken;
  let counter = 0;

  function tokenFor(tenant, userId) {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }

  async function setRole(tenant, userIndex, role) {
    const userId = tenant.users[userIndex].id;
    const propertyId = tenant.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  function idemKey() {
    counter += 1;
    return `sales-report-${counter}`;
  }

  let outlet;
  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'pos_operator');
    managerToken = tokenFor(ctx.a, ctx.a.users[0].id);
    operatorToken = tokenFor(ctx.a, ctx.a.users[1].id);
    await t.trx('users').where({ id: ctx.a.users[0].id }).update({ first_name: 'Ada', last_name: 'Bello' });

    const propertyId = ctx.a.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'SALES-BAR', name: 'Sales Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: 'SALES-T1' });
    const [beerId] = await t.trx('pos_menu_items').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Beer', category: 'Drinks', price: '20.00' });
    const [wineId] = await t.trx('pos_menu_items').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Wine, red', category: 'Drinks', price: '40.00' });
    outlet = { outletId, terminalId, beerId, wineId };
  });

  async function openTab(tableLabel, items) {
    const opened = await t.request
      .post('/api/v1/pos/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: tableLabel })
      .expect(201);
    for (const [menuItemId, quantity] of items) {
      await t.request
        .post(`/api/v1/pos/orders/${opened.body.data.id}/items`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ menu_item_id: menuItemId, quantity })
        .expect(200);
    }
    return opened.body.data.id;
  }

  function settle(orderId, settlements) {
    return t.request
      .post(`/api/v1/pos/orders/${orderId}/settle`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ settlements });
  }

  async function capturedCardPayment(orderId, tender) {
    const started = await t.request
      .post(`/api/v1/pos/orders/${orderId}/paystack-checkout`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ tender })
      .expect(201);
    await t.trx('payments').where({ id: started.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date() });
    return started.body.data.id;
  }

  function getReport(query, token = managerToken) {
    return t.request.get('/api/v1/pos/reports/sales').query(query).set('Authorization', `Bearer ${token}`);
  }

  let report;
  let voidedCheckOrderId;
  let strayPaymentId;

  beforeAll(async () => {
    paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/s', accessCode: 'sales-access', reference: 'r' });

    // 1. Cash: 2 beers = 40.00 + 3.00 tax + 3.00 service = 46.00
    const cashTab = await openTab('Table 1', [[outlet.beerId, 2]]);
    expect((await settle(cashTab, [{ method: 'cash', service_charge: '3.00' }])).status).toBe(200);

    // 2. NQR: 1 wine = 40.00 + 3.00 + 3.00 = 46.00
    const nqrTab = await openTab('Table 2', [[outlet.wineId, 1]]);
    const nqrPayment = await capturedCardPayment(nqrTab, 'nqr');
    await t.trx('payments').where({ id: nqrPayment }).update({ provider_channel: 'qr' });
    expect((await settle(nqrTab, [{ method: 'card', service_charge: '3.00', payment_id: nqrPayment }])).status).toBe(200);

    // 3. Split tab: group 1 (beer) card, group 2 (wine) cash — then the cash check is voided.
    voidedCheckOrderId = await openTab('Table 3', [[outlet.beerId, 1], [outlet.wineId, 1]]);
    const items = await t.trx('pos_order_items').where({ pos_order_id: voidedCheckOrderId }).orderBy('id');
    await t.trx('pos_order_items').where({ id: items[0].id }).update({ split_group: 1 });
    await t.trx('pos_order_items').where({ id: items[1].id }).update({ split_group: 2 });
    const cardPayment = await t.request
      .post(`/api/v1/pos/orders/${voidedCheckOrderId}/paystack-checkout`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ tender: 'card', split_group: 1 })
      .expect(201);
    await t.trx('payments').where({ id: cardPayment.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date() });
    const splitSettled = await settle(voidedCheckOrderId, [
      { split_group: 1, method: 'card', service_charge: '1.50', payment_id: cardPayment.body.data.id },
      { split_group: 2, method: 'cash', service_charge: '3.00' },
    ]);
    expect(splitSettled.status).toBe(200);
    const cashCheck = splitSettled.body.data.settlements.find((s) => s.method === 'cash');
    await t.request
      .post(`/api/v1/pos/orders/${voidedCheckOrderId}/settlements/${cashCheck.id}/void`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'Rang up on the wrong tab' })
      .expect(200);

    // 4. A settlement outside the date range.
    const oldTab = await openTab('Old tab', [[outlet.beerId, 5]]);
    const oldSettled = await settle(oldTab, [{ method: 'cash', service_charge: '7.50' }]);
    await t.trx('pos_order_settlements').where({ id: oldSettled.body.data.settlements[0].id }).update({ business_date: '2027-02-01' });

    // 5. A captured card payment on a tab that was then voided (no settlement uses it).
    const strayTab = await openTab('Table, stray', [[outlet.beerId, 1]]);
    strayPaymentId = await capturedCardPayment(strayTab, 'card');
    await t.trx('pos_orders').where({ id: strayTab }).update({ status: 'void' });

    const res = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE });
    expect(res.status).toBe(200);
    report = res.body.data;
  });

  it('totals each tender exactly, leaving out voided checks and other dates', () => {
    const byTender = Object.fromEntries(report.byTender.map((row) => [row.tender, row]));
    expect(byTender.cash).toEqual({ tender: 'cash', checks: 1, total: '46.00' });
    expect(byTender.nqr).toEqual({ tender: 'nqr', checks: 1, total: '46.00' });
    expect(byTender.card).toEqual({ tender: 'card', checks: 1, total: '23.00' });
    expect(byTender.room_charge).toEqual({ tender: 'room_charge', checks: 0, total: '0.00' });
    expect(report.summary).toMatchObject({ tabs: 3, checks: 3, subtotal: '100.00', tax: '7.50', serviceCharge: '7.50', total: '115.00' });
    expect(report.currency).toBe('NGN');
  });

  it('ranks top sellers by quantity, counting only items on checks that still stand', () => {
    // These fixture items have no recipe or cost price, so their cost and profit are unknown (null) —
    // `tests/pos/sales-profit.test.js` covers the profit figures themselves.
    expect(report.topItems).toEqual([
      { menuItemId: String(outlet.beerId), name: 'Beer', quantity: 3, sales: '60.00', cost: null, profit: null, marginPct: null },
      { menuItemId: String(outlet.wineId), name: 'Wine, red', quantity: 1, sales: '40.00', cost: null, profit: null, marginPct: null },
    ]);
  });

  it('shows the Paystack channel each card check was actually paid through', () => {
    const nqr = report.tabs.find((tab) => tab.tableLabel === 'Table 2');
    expect(nqr.payments).toEqual([{ tender: 'nqr', channel: 'qr', roomNumber: null, guestName: null, total: '46.00' }]);
  });

  it('names the room and guest a charge-to-room tab was billed to', async () => {
    const propertyId = ctx.a.properties[0].id;
    const [roomTypeId] = await t.trx('room_types').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'SR-RT', name: 'Sales RT', default_occupancy: 2, base_rate: '150.00' });
    const [roomId] = await t.trx('rooms').insert({ tenant_id: ctx.a.id, property_id: propertyId, room_type_id: roomTypeId, room_number: 'S-205', status: 'active', front_desk_status: 'occupied' });
    const [rateCodeId] = await t.trx('rate_codes').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'SR-RATE', base_rate: '150.00', currency: 'NGN', valid_from: '2026-01-01' });
    const [reservationId] = await t.trx('reservations').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      guest_id: ctx.a.guests[0].id,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: BUSINESS_DATE,
      departure_date: '2027-03-05',
      adults: 1,
      children: 0,
      status: 'checked_in',
      confirmation_number: `SRROOM${Date.now()}`.slice(0, 26),
      checked_in_at: new Date(),
    });
    await t.trx('reservation_rooms').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: reservationId, room_id: roomId, effective_from: new Date(Date.now() - 60_000), effective_to: null });
    await t.trx('folios').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: reservationId, folio_number: `SRF${Date.now()}`.slice(0, 26), status: 'open', balance: '0.00', currency: 'NGN' });

    const roomTab = await openTab('Table 9', [[outlet.beerId, 1]]);
    const settled = await settle(roomTab, [{ method: 'room_charge', service_charge: '1.50', room_charge: { reservation_id: reservationId, auth_method: 'pin', auth_reference: 'PIN entered' } }]);
    expect(settled.status).toBe(200);
    // Its own business date, so the shared report the other tests read stays unchanged.
    await t.trx('pos_order_settlements').where({ id: settled.body.data.settlements[0].id }).update({ business_date: '2027-03-02' });

    const res = await getReport({ date_from: '2027-03-02', date_to: '2027-03-02' });
    const guest = await t.trx('guests').where({ id: ctx.a.guests[0].id }).first();
    const tab = res.body.data.tabs.find((row) => row.tableLabel === 'Table 9');
    expect(tab.payments).toEqual([
      expect.objectContaining({ tender: 'room_charge', roomNumber: 'S-205', guestName: `${guest.first_name} ${guest.last_name}` }),
    ]);

    const csv = await getReport({ date_from: '2027-03-02', date_to: '2027-03-02', format: 'csv', section: 'tabs' });
    expect(csv.text).toContain(`room_charge Room S-205 (${guest.first_name} ${guest.last_name})`);
  });

  it('lists each settled tab with its tenders, item count, cashier, and total', () => {
    const split = report.tabs.find((tab) => tab.orderId === String(voidedCheckOrderId));
    expect(split).toMatchObject({ tableLabel: 'Table 3', tenders: ['card'], itemCount: 1, cashier: 'Ada Bello', total: '23.00', businessDate: BUSINESS_DATE });
    expect(report.tabs.map((tab) => tab.tableLabel).sort()).toEqual(['Table 1', 'Table 2', 'Table 3']);
  });

  it('lists a captured card payment that no settlement uses, regardless of date', () => {
    expect(report.unsettledCardPayments).toEqual([
      expect.objectContaining({ paymentId: String(strayPaymentId), tableLabel: 'Table, stray', orderStatus: 'void', tender: 'card', amount: '23.00' }),
    ]);
  });

  it('filters by outlet', async () => {
    const res = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE, outlet_id: '999999' });
    expect(res.status).toBe(200);
    expect(res.body.data.tabs).toEqual([]);
    expect(res.body.data.summary.total).toBe('0.00');
    expect(res.body.data.unsettledCardPayments).toEqual([]);
  });

  it('exports each section as CSV, quoting values that contain commas', async () => {
    const items = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE, format: 'csv', section: 'items' });
    expect(items.status).toBe(200);
    expect(items.headers['content-type']).toMatch(/text\/csv/);
    expect(items.headers['content-disposition']).toContain('pos-sales-items-2027-03-01-to-2027-03-01.csv');
    expect(items.text).toBe('name,quantity,sales,cost,profit\nBeer,3,60.00,,\n"Wine, red",1,40.00,,');

    const tabs = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE, format: 'csv' });
    expect(tabs.text.split('\n')[0]).toBe('orderId,businessDate,settledAt,tableLabel,source,tenders,itemCount,cashier,total,profit');
    expect(tabs.text.split('\n')).toHaveLength(4);
  });

  it('neutralises spreadsheet formulas in exported text, leaving negative numbers alone', () => {
    const { toCsv } = require('../../src/modules/reporting/service');
    expect(toCsv([{ name: '=HYPERLINK("x")', amount: '-10.00' }], ['name', 'amount'])).toBe('name,amount\n"\'=HYPERLINK(""x"")",-10.00');
  });

  it('lists a captured guest QR-order card payment that no settlement uses', async () => {
    const guestTab = await openTab('Room 4 QR', [[outlet.beerId, 1]]);
    const [paymentId] = await t.trx('payments').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      pos_order_id: guestTab,
      settlement_target: 'pos_order',
      idempotency_key: idemKey(),
      provider: 'paystack',
      provider_reference: `qr-stray-${Date.now()}`,
      amount: '21.50',
      currency: 'NGN',
      status: 'CAPTURED',
      captured_at: new Date(),
    });
    await t.trx('pos_orders').where({ id: guestTab }).update({ status: 'void' });

    const res = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE });
    expect(res.body.data.unsettledCardPayments.map((p) => p.paymentId)).toContain(String(paymentId));
  });

  it('rejects a missing or backwards date range and an unknown CSV section', async () => {
    expect((await getReport({ date_from: BUSINESS_DATE })).status).toBe(400);
    expect((await getReport({ date_from: '2027-03-02', date_to: BUSINESS_DATE })).status).toBe(400);
    expect((await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE, format: 'csv', section: 'secrets' })).status).toBe(400);
  });

  it('is manager-tier: a pos_operator is refused', async () => {
    const res = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE }, operatorToken);
    expect(res.status).toBe(403);
  });

  it("never shows another tenant's sales", async () => {
    await setRole(ctx.b, 0, 'manager');
    await t.trx('properties').where({ id: ctx.b.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
    const res = await getReport({ date_from: BUSINESS_DATE, date_to: BUSINESS_DATE }, tokenFor(ctx.b, ctx.b.users[0].id));
    expect(res.status).toBe(200);
    expect(res.body.data.tabs).toEqual([]);
    expect(res.body.data.unsettledCardPayments).toEqual([]);
  });
});
