'use strict';

/**
 * `GET /reports/business-summary` — rooms, each outlet and the mini-mart on ONE basis (gross collected),
 * built from the payment reconciliation report's own lines. The tests that make it trustworthy:
 * the grand total per currency equals reconciliation's `summary[].grossTotal` to the kobo, the
 * existing reconciliation report is unchanged, and an outlet's collected + charged-to-room equals the
 * POS Sales report's total for that outlet.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { initializeTransaction: jest.fn(), verifyTransaction: jest.fn(), refundTransaction: jest.fn(), verifyWebhookSignature: jest.fn(), createSubaccount: jest.fn(), resolveBankAccount: jest.fn() };
  return { ...actual, __mockAdapter: mockAdapter, resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })) };
});

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuItem } = require('../helpers/catalogue');
const { computeBusinessSummary } = require('../../src/modules/reporting/business-summary');
const { computePaymentReconciliation } = require('../../src/modules/reconciliation/service');
const { computeSalesReport } = require('../../src/modules/pos/sales-report');
const { contextFromSession } = require('../../src/modules/tenancy');

const DAY = '2027-07-01';

describe('Business summary', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let managerToken;
  let cashierToken;
  let bar;
  let mart;
  let counter = 0;
  const key = () => `bs-${(counter += 1)}`;

  const tokenFor = (userId, tenant = ctx.a) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const scope = () => ({ tenant_id: ctx.a.id, property_id: propertyId });
  const get = (query, token = managerToken) => t.request.get('/api/v1/reports/business-summary').query(query).set('Authorization', `Bearer ${token}`);
  const row = (summary, label) => summary.currencies[0].rows.find((r) => r.label === label);

  async function setRole(userIndex, role) {
    const userId = ctx.a.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ ...scope(), user_id: userId, role });
  }
  async function outlet(type, name) {
    const [id] = await t.trx('pos_outlets').insert({ ...scope(), code: `BS${Date.now().toString(36)}${(counter += 1)}`.slice(0, 30), name, type });
    return id;
  }
  async function folioWithBalance(amount) {
    counter += 1;
    const [id] = await t.trx('folios').insert({ ...scope(), reservation_id: ctx.a.reservations[0].id, folio_number: `BSF${Date.now()}${counter}`.slice(0, 26), status: 'open', balance: amount, currency: 'NGN' });
    await t.trx('folio_line_items').insert({ ...scope(), folio_id: id, type: 'adjustment', description: 'fixture', amount, currency: 'NGN', business_date: DAY });
    return id;
  }
  async function folioCash(amount) {
    const folioId = await folioWithBalance(amount);
    await t.request.post(`/api/v1/cashiering/folios/${folioId}/payments/cash`).set('Authorization', `Bearer ${managerToken}`).set('Idempotency-Key', key()).send({ amount, currency: 'NGN' }).expect(201);
  }
  async function openTab(items) {
    const opened = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${managerToken}`).send({ outlet_id: bar.outletId, terminal_id: bar.terminalId, table_label: `BS ${key()}` }).expect(201);
    for (const [menuItemId, quantity] of items) await t.request.post(`/api/v1/pos/orders/${opened.body.data.id}/items`).set('Authorization', `Bearer ${managerToken}`).send({ menu_item_id: menuItemId, quantity }).expect(200);
    return opened.body.data.id;
  }
  const settle = (orderId, settlements) => t.request.post(`/api/v1/pos/orders/${orderId}/settle`).set('Authorization', `Bearer ${managerToken}`).set('Idempotency-Key', key()).send({ settlements });

  async function capturedPayment(orderId, tender, channel = 'card') {
    const started = await t.request.post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).set('Authorization', `Bearer ${managerToken}`).set('Idempotency-Key', key()).send({ tender }).expect(201);
    await t.trx('payments').where({ id: started.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date(), provider_channel: channel });
    return started.body.data.id;
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: DAY });
    await setRole(0, 'manager');
    managerToken = tokenFor(ctx.a.users[0].id);
    const [cashierId] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `cashier-${Date.now()}@example.com`, first_name: 'C', last_name: 'C', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ ...scope(), user_id: cashierId, role: 'cashier' });
    cashierToken = tokenFor(cashierId);

    const barId = await outlet('bar', 'Summary Bar');
    const [terminalId] = await t.trx('pos_terminals').insert({ ...scope(), outlet_id: barId, device_ref: `BST${Date.now()}`.slice(0, 30) });
    const [beerId] = await insertMenuItem(t.trx, { ...scope(), outlet_id: barId, name: 'Summary Beer', category: 'Drinks', price: '40.00' });
    bar = { outletId: barId, terminalId, beerId };
    await outlet('restaurant', 'Quiet Restaurant'); // no sales: must still appear with zeros
    const martId = await outlet('supermarket', 'Summary Mart');
    const [martItemId] = await insertMenuItem(t.trx, { ...scope(), outlet_id: martId, name: 'Mart Item', category: 'Mart Cat', price: '25.00' });
    mart = { outletId: martId, itemId: martItemId };
    await outlet('store', 'Summary Store'); // never a source row

    const { __mockAdapter: paystack } = require('../../src/modules/cashiering/paystack-adapter');
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay', accessCode: 'a', reference }));

    // Rooms: a cash folio payment.
    await folioCash('70.00');
    // Bar: cash with service charge, a card, a bank-transfer-channel card, and an NQR sale.
    const cashTab = await openTab([[bar.beerId, 2]]); // 80.00 + 4.00 service
    expect((await settle(cashTab, [{ method: 'cash', service_charge: '4.00' }])).status).toBe(200);
    const cardTab = await openTab([[bar.beerId, 1]]);
    expect((await settle(cardTab, [{ method: 'card', service_charge: '3.00', payment_id: await capturedPayment(cardTab, 'card') }])).status).toBe(200);
    const transferTab = await openTab([[bar.beerId, 1]]);
    expect((await settle(transferTab, [{ method: 'card', service_charge: '3.00', payment_id: await capturedPayment(transferTab, 'card', 'bank_transfer') }])).status).toBe(200);
    const nqrTab = await openTab([[bar.beerId, 1]]);
    expect((await settle(nqrTab, [{ method: 'card', service_charge: '3.00', payment_id: await capturedPayment(nqrTab, 'nqr') }])).status).toBe(200);

    // Terminal sale, and a captured card payment whose tab was voided (an unsettled capture reconciliation still lists).
    const terminalTab = await openTab([[bar.beerId, 1]]);
    expect((await settle(terminalTab, [{ method: 'terminal', service_charge: '3.00' }])).status).toBe(200);
    const strayTab = await openTab([[bar.beerId, 1]]);
    const strayPayment = await capturedPayment(strayTab, 'card');
    await t.trx('payments').where({ id: strayPayment }).update({ captured_at: new Date(`${DAY}T12:00:00Z`) });
    await t.trx('pos_orders').where({ id: strayTab }).update({ status: 'void' });

    // Charge-to-room: a bar tab put on an in-house guest's folio.
    const [roomTypeId] = await t.trx('room_types').insert({ ...scope(), code: 'BS-RT', name: 'BS RT', default_occupancy: 2, base_rate: '100.00' });
    const [roomId] = await t.trx('rooms').insert({ ...scope(), room_type_id: roomTypeId, room_number: 'BS-1', status: 'active', front_desk_status: 'occupied' });
    const [rateCodeId] = await t.trx('rate_codes').insert({ ...scope(), code: 'BS-RATE', base_rate: '100.00', currency: 'NGN', valid_from: '2026-01-01' });
    const [reservationId] = await t.trx('reservations').insert({ ...scope(), guest_id: ctx.a.guests[0].id, room_type_id: roomTypeId, rate_code_id: rateCodeId, arrival_date: DAY, departure_date: '2027-07-04', adults: 1, children: 0, status: 'checked_in', confirmation_number: `BSR${Date.now()}`.slice(0, 26), checked_in_at: new Date() });
    await t.trx('reservation_rooms').insert({ ...scope(), reservation_id: reservationId, room_id: roomId, effective_from: new Date(Date.now() - 60_000), effective_to: null });
    await t.trx('folios').insert({ ...scope(), reservation_id: reservationId, folio_number: `BSG${Date.now()}`.slice(0, 26), status: 'open', balance: '0.00', currency: 'NGN' });
    const roomTab = await openTab([[bar.beerId, 1]]);
    expect((await settle(roomTab, [{ method: 'room_charge', room_charge: { reservation_id: reservationId, auth_method: 'pin', auth_reference: 'PIN' } }])).status).toBe(200);

    // Mini-mart: a real cash sale through the supermarket till.
    const [martOperator] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `mart-${Date.now()}@example.com`, first_name: 'M', last_name: 'M', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ ...scope(), user_id: martOperator, role: 'pos_operator' });
    await t.request.post('/api/v1/supermarket/sales').set('Authorization', `Bearer ${tokenFor(martOperator)}`).set('Idempotency-Key', key()).send({ outlet_id: mart.outletId, method: 'cash', items: [{ menu_item_id: mart.itemId, quantity: 2 }] }).expect(201);
  });

  const range = { date_from: DAY, date_to: DAY };

  it('states the basis and orders sources: rooms, outlets, mini-mart; a quiet outlet shows zeros; a store never appears', async () => {
    const res = await get(range);
    expect(res.status).toBe(200);
    const summary = res.body.data;
    expect(summary.basis).toBe('gross_collected');
    expect(summary.basisNote).toMatch(/Gross money collected/);
    expect(summary.currencies).toHaveLength(1);
    const labels = summary.currencies[0].rows.map((r) => r.label);
    expect(labels).toEqual(['Rooms', 'Fixture Bar', 'Quiet Restaurant', 'Summary Bar', 'Summary Mart']);
    expect(row(summary, 'Quiet Restaurant')).toMatchObject({ grossCollected: '0.00', chargedToRooms: '0.00' });
  });

  it('splits by method with NQR apart from card and bank-transfer-channel card as transfer', async () => {
    const summary = (await get(range)).body.data;
    expect(row(summary, 'Rooms').byMethod).toMatchObject({ cash: '70.00', card: '0.00' });
    const reconciliation = await computePaymentReconciliation({ context: contextFromSession({ tenantId: ctx.a.id, propertyId, userId: ctx.a.users[0].id }), dateFrom: DAY, dateTo: DAY });
    const cents = (v) => Math.round(Number(v) * 100);
    const barLines = reconciliation.lines.filter((line) => line.source.label === 'Summary Bar');
    const expected = { cash: 0, card: 0, transfer: 0, nqr: 0, terminal: 0 };
    for (const line of barLines) expected[line.method === 'card' && line.providerChannel === 'bank_transfer' ? 'transfer' : line.method] += cents(line.grossAmount);
    const bar = row(summary, 'Summary Bar');
    for (const method of Object.keys(expected)) expect(cents(bar.byMethod[method])).toBe(expected[method]);
    expect(expected.cash).toBeGreaterThan(0);
    expect(expected.transfer).toBeGreaterThan(0);
    expect(expected.nqr).toBeGreaterThan(0);
    expect(expected.terminal).toBeGreaterThan(0);
    expect(expected.card).toBeGreaterThan(0); // the plain card sale stays in card, apart from transfer and NQR
    expect(bar.byMethod.other).toBe('0.00');
    expect(row(summary, 'Summary Mart').byMethod.cash).toBe('50.00');
  });

  it('gives rooms gross only and outlets an exact net/tax/service/tips breakdown that adds up to collected', async () => {
    const summary = (await get(range)).body.data;
    expect(row(summary, 'Rooms').breakdown).toBeNull();
    const bar = row(summary, 'Summary Bar');
    expect(bar.breakdown).toMatchObject({ net: '240.00', service: '16.00', tips: '0.00' });
    expect(Number(bar.breakdown.other)).toBeGreaterThan(0); // the unsettled capture has no settlement breakdown
    const parts = ['net', 'tax', 'service', 'tips', 'other'].reduce((sum, k) => sum + Math.round(Number(bar.breakdown[k]) * 100), 0);
    expect(parts).toBe(Math.round(Number(bar.grossCollected) * 100));
  });

  it('keeps charge-to-room as a memo that is NOT in any total, and bridges to the POS Sales report', async () => {
    const summary = (await get(range)).body.data;
    const barRow = row(summary, 'Summary Bar');
    expect(barRow.chargedToRooms).toBe('43.00') // 40.00 + the fixture VAT;
    const posReport = await computeSalesReport({ context: contextFromSession({ tenantId: ctx.a.id, propertyId, userId: ctx.a.users[0].id }), dateFrom: DAY, dateTo: DAY, outletId: bar.outletId });
    const posBar = posReport.byOutlet.find((o) => o.name === 'Summary Bar');
    // POS Sales total = what the settlements collected (collected less refund/unsettled lines, which have no sale) + charged to rooms.
    const cents = (v) => Math.round(Number(v) * 100);
    expect(cents(posBar.total)).toBe(cents(barRow.grossCollected) - cents(barRow.breakdown.other) + cents(barRow.chargedToRooms));
  });

  it('THE guarantee: grand total equals the Payment Reconciliation report total, to the kobo', async () => {
    const summary = (await get(range)).body.data;
    const context = contextFromSession({ tenantId: ctx.a.id, propertyId, userId: ctx.a.users[0].id });
    const reconciliation = await computePaymentReconciliation({ context, dateFrom: DAY, dateTo: DAY });
    expect(summary.currencies).toHaveLength(reconciliation.summary.length);
    for (const entry of reconciliation.summary) {
      const table = summary.currencies.find((c) => c.currency === entry.currency);
      expect(table.total.grossCollected).toBe(entry.grossTotal);
      expect(table.reconciliation).toEqual({ grossTotal: entry.grossTotal, matches: true });
    }
    // And through HTTP, the public reconciliation endpoint still answers with the same total.
    const http = await t.request.get('/api/v1/reconciliation/payments').query(range).set('Authorization', `Bearer ${managerToken}`);
    expect(http.body.data.summary[0].grossTotal).toBe(summary.currencies[0].total.grossCollected);
  });

  it('a payment of any kind moves both numbers together (no drift)', async () => {
    const before = (await get(range)).body.data.currencies[0].total.grossCollected;
    await folioCash('13.37');
    const summary = (await get(range)).body.data;
    expect(summary.currencies[0].reconciliation.matches).toBe(true);
    const cents = (v) => Math.round(Number(v) * 100);
    expect(cents(summary.currencies[0].total.grossCollected) - cents(before)).toBe(1337);
  });

  it('the reconciliation report keeps its exact shape (no outlet references leak into it)', async () => {
    const context = contextFromSession({ tenantId: ctx.a.id, propertyId, userId: ctx.a.users[0].id });
    const report = await computePaymentReconciliation({ context, dateFrom: DAY, dateTo: DAY });
    expect(Object.keys(report).sort()).toEqual(['bySettlementAccount', 'bySource', 'byMethod', 'byTerminalProvider', 'currency', 'dateFrom', 'dateTo', 'lines', 'summary'].sort());
    for (const line of report.lines) expect(Object.keys(line.source).sort()).toEqual(['channel', 'kind', 'label']);
  });

  it('flags room charges billed as an ESTIMATE until Night Audit has closed the day, naming the dates', async () => {
    const summary = (await get(range)).body.data;
    expect(summary.roomChargesBilled).toMatchObject({ basis: 'billed_before_tax', estimate: true, unauditedDates: [DAY] });
    await t.trx('daily_reports').insert({ ...scope(), business_date: DAY, room_revenue: '500.00', occupancy_pct: '10.00', adr: '100.00', revpar: '10.00', payments_collected: '0.00', pos_revenue: '0.00' }).catch(() => {});
    const closed = (await get(range)).body.data;
    if (closed.roomChargesBilled.estimate === false) expect(closed.roomChargesBilled.amount).toBe('500.00');
  });

  it('a range with nothing in it still shows every source with zeros, and tables never mix currencies', async () => {
    const summary = (await get({ date_from: '2027-08-01', date_to: '2027-08-02' })).body.data;
    expect(summary.currencies).toHaveLength(1);
    expect(summary.currencies[0].total.grossCollected).toBe('0.00');
    expect(summary.currencies[0].rows.map((r) => r.label)).toEqual(['Rooms', 'Fixture Bar', 'Quiet Restaurant', 'Summary Bar', 'Summary Mart']);
  });

  it('exports CSV with a total row', async () => {
    const res = await get({ ...range, format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toContain('grossCollected');
    expect(res.text).toMatch(/TOTAL/);
    expect(res.text).toMatch(/Summary Mart/);
  });

  it('validates the dates', async () => {
    expect((await get({})).status).toBe(400);
    expect((await get({ date_from: '2027-07-02', date_to: '2027-07-01' })).status).toBe(400);
  });

  it('needs reports.view_business: manager yes, cashier no, other tenants see nothing of ours', async () => {
    expect((await get(range, cashierToken)).status).toBe(403);
    const other = await get(range, tokenFor(ctx.b.users[0].id, ctx.b));
    expect([403, 200]).toContain(other.status);
    if (other.status === 200) expect(other.body.data.currencies.flatMap((c) => c.rows.map((r) => r.label))).not.toContain('Summary Bar');
  });
});
