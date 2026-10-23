'use strict';

/**
 * Refunding a card sale that was already SETTLED on a Register tab: `GET /pos/card-sales` (the sale and where its
 * refund stands) and `POST /pos/card-sales/:paymentId/refund` (full refund only). A cashier (cashiering.void_line)
 * starts it; a manager's PIN approves it. The sale stays in the Sales report on its own day and the refund is a separate
 * negative line on the day it was processed.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { initializeTransaction: jest.fn(), verifyTransaction: jest.fn(), refundTransaction: jest.fn(), fetchRefund: jest.fn(), listRefundsForTransaction: jest.fn() };
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
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');

describe('refund a settled card sale', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let outlet;
  let otherOutletId;
  let manager;
  let cashier;
  let operator;
  let counter = 0;
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (tenant, userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant === ctx.a ? propertyId : tenant.properties[0].id) });
  const token = (userId) => tokenFor(ctx.a, userId);
  const as = (userId, tenant = ctx.a) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(tenant, userId)}`),
    post: (url, key = `csr-${next()}`) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(tenant, userId)}`).set('Idempotency-Key', key),
  });

  async function user(role, pin) {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${next()}@example.com`, first_name: role, last_name: 'T', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: id, role });
    if (pin) await setApprovalPin(t.trx, { tenantId: ctx.a.id, userId: id });
    return id;
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-08-01' });
    manager = await user('manager', true);
    cashier = await user('cashier', false);
    operator = await user('pos_operator', false);
    const suffix = Date.now().toString(36).slice(-6);
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `CS-${suffix}`, name: 'Card Sale Bar', type: 'bar' });
    const [secondOutlet] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `CT-${suffix}`, name: 'Other Bar', type: 'bar' });
    otherOutletId = secondOutlet;
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `CS-T-${suffix}` });
    const [beer] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Card Sale Beer', category: 'Drinks', price: '100.00' });
    const [stockItemId] = await insertStockItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `Card Keg ${suffix}`, unit: 'unit', purchase_cost: '30.00', current_quantity: '500.000', reorder_level: '1.000' });
    await t.trx('stock_movements').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, stock_item_id: stockItemId, type: 'received', quantity: '500.000', unit_cost: '30.00', total_cost: '15000.00', business_date: '2027-07-01', reference: 'seed' });
    await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: propertyId, menu_item_id: beer, stock_item_id: stockItemId, quantity: '1.000' });
    outlet = { outletId, terminalId, beer, stockItemId };
  });

  beforeEach(async () => {
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-08-01' });
    paystack.initializeTransaction.mockReset();
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/x', accessCode: 'a', reference }));
    paystack.refundTransaction.mockReset();
    paystack.refundTransaction.mockResolvedValue({ refundId: 'r1', status: 'processed' });
  });

  async function cardSale() {
    const opened = await as(operator).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `C${next()}`.slice(0, 20) });
    const orderId = opened.body.data.id;
    await as(operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 1 });
    const started = await as(operator).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
    const payment = started.body.data;
    await t.trx('payments').where({ id: payment.id }).update({ status: 'CAPTURED', captured_at: new Date(), provider_channel: 'card' });
    const settled = await as(operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'card', payment_id: payment.id }] });
    expect(settled.status).toBe(200);
    return { orderId, payment, settlementId: settled.body.data.settlements[0].id };
  }

  /** A cashier starts, a manager approves with their PIN. */
  async function refundAsCashier(paymentId, { body = { reason_code: 'customer_request' }, key, who = cashier, approve = true } = {}) {
    // Get the approval first: a supertest request opened before another one finishes loses its server.
    const approval = approve ? await managerApproval(t.request, { token: token(who), approverUserId: manager, action: 'pos.refund_payment', targetId: paymentId }) : null;
    const req = as(who).post(`/api/v1/pos/card-sales/${paymentId}/refund`, key);
    return (approval ? req.set('X-Manager-Approval', approval) : req).send(body);
  }

  const listFor = async (userId, query = 'date_from=2027-08-01&date_to=2027-08-01') => (await as(userId).get(`/api/v1/pos/card-sales?${query}`)).body.data;
  const find = (rows, paymentId) => rows.find((row) => String(row.paymentId) === String(paymentId));
  const salesReport = async (from, to) => (await as(manager).get(`/api/v1/pos/reports/sales?date_from=${from}&date_to=${to}&outlet_id=${outlet.outletId}`)).body.data;

  test('lists a settled card sale as refundable, with its amount and Paystack reference', async () => {
    const { payment, orderId } = await cardSale();
    const row = find(await listFor(cashier), payment.id);
    expect(row).toMatchObject({ orderId, state: 'refundable', refundStatus: null, disabledReason: null, currency: 'NGN' });
    expect(row.amount).toBe(payment.amount);
    expect(row.providerReference).toBe(payment.provider_reference);
  });

  test('full refund: cashier starts, manager approves; the settlement is voided, stock goes back and the sale shows as refunded', async () => {
    const { payment, settlementId } = await cardSale();
    const res = await refundAsCashier(payment.id, { body: { reason_code: 'wrong_charge', reason_note: 'charged for two' } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'CAPTURED', parent_payment_id: String(payment.id), amount: payment.amount });
    expect(paystack.refundTransaction).toHaveBeenCalledTimes(1);

    const original = await t.trx('payments').where({ id: payment.id }).first();
    expect(original.status).toBe('REFUNDED');
    expect((await t.trx('pos_order_settlements').where({ id: settlementId }).first()).voided_at).not.toBeNull();
    expect(await t.trx('stock_movements').where({ pos_order_settlement_id: settlementId, type: 'sale_reversal' })).toHaveLength(1);

    const row = find(await listFor(cashier), payment.id);
    expect(row).toMatchObject({ state: 'refunded', refundStatus: 'completed' });
    expect(row.disabledReason).toMatch(/already been refunded/);
    expect(row.refundedAt).toBeTruthy();
  });

  test('the reason picker label (and note) is what is stored; an unknown code or an empty "other" is refused with nothing sent', async () => {
    const { payment } = await cardSale();
    expect((await refundAsCashier(payment.id, { body: { reason_code: 'nonsense' } })).status).toBe(400);
    expect((await refundAsCashier(payment.id, { body: { reason_code: 'other', reason_note: '   ' } })).status).toBe(400);
    expect((await refundAsCashier(payment.id, { body: {} })).status).toBe(400);
    expect(paystack.refundTransaction).not.toHaveBeenCalled();

    const ok = await refundAsCashier(payment.id, { body: { reason_code: 'other', reason_note: 'guest left unwell' } });
    expect(ok.status).toBe(201);
    const row = await t.trx('refund_reconciliations').where({ payment_id: ok.body.data.id }).first();
    expect(row.reason).toBe('Other: guest left unwell');
  });

  test('the client cannot choose the amount: a body amount is ignored and exactly the captured amount is refunded', async () => {
    const { payment } = await cardSale();
    const res = await refundAsCashier(payment.id, { body: { reason_code: 'customer_request', amount: '1.00' } });
    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(payment.amount);
    // A full refund passes no amount to Paystack (it refunds the whole transaction); the 1.00 the client sent never reaches it.
    expect(paystack.refundTransaction.mock.calls[0][0].amount).not.toBe('1.00');
  });

  test('the audit row records who started the refund and which manager approved it', async () => {
    const { payment } = await cardSale();
    const res = await refundAsCashier(payment.id, { body: { reason_code: 'duplicate_payment' } });
    const audit = await t.trx('audit_log').where({ entity_type: 'payments', entity_id: res.body.data.id, action: 'refund_card_sale' }).first();
    expect(audit).toBeDefined();
    expect(audit.after_state).toMatchObject({
      started_by_user_id: String(cashier),
      approved_by_user_id: String(manager),
      refunded_payment_id: String(payment.id),
      reason_code: 'duplicate_payment',
    });
    expect(audit.after_state.approval_id).toBeTruthy();
    expect(audit.reason).toBe('Duplicate payment');
  });

  test('double press: the same Idempotency-Key sends one refund and replays the answer', async () => {
    const { payment } = await cardSale();
    const approval = await managerApproval(t.request, { token: token(cashier), approverUserId: manager, action: 'pos.refund_payment', targetId: payment.id });
    const send = () => as(cashier).post(`/api/v1/pos/card-sales/${payment.id}/refund`, 'csr-double-press').set('X-Manager-Approval', approval).send({ reason_code: 'customer_request' });
    const [first, second] = [await send(), await send()];
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(paystack.refundTransaction).toHaveBeenCalledTimes(1);
    expect(await t.trx('payments').where({ parent_payment_id: payment.id })).toHaveLength(1);
  });

  test('two presses at once with different keys: one refund only', async () => {
    const { payment } = await cardSale();
    const send = async () => refundAsCashier(payment.id);
    const results = [await send(), await send()];
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(paystack.refundTransaction).toHaveBeenCalledTimes(1);
  });

  test('already refunded: refused with a clear 409 and nothing sent to Paystack', async () => {
    const { payment } = await cardSale();
    expect((await refundAsCashier(payment.id)).status).toBe(201);
    paystack.refundTransaction.mockClear();
    const again = await refundAsCashier(payment.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT_CARD_SALE_ALREADY_REFUNDED');
    expect(paystack.refundTransaction).not.toHaveBeenCalled();
  });

  test('a refund Paystack has accepted but not finished shows as pending and blocks a second one', async () => {
    paystack.refundTransaction.mockResolvedValue({ refundId: 'r-pending', status: 'pending' });
    const { payment, settlementId } = await cardSale();
    expect((await refundAsCashier(payment.id)).status).toBe(201);

    const row = find(await listFor(cashier), payment.id);
    expect(row).toMatchObject({ state: 'refund_pending', refundStatus: 'pending' });
    expect(row.disabledReason).toMatch(/waiting on Paystack/);
    // The sale stands until Paystack confirms.
    expect((await t.trx('pos_order_settlements').where({ id: settlementId }).first()).voided_at).toBeNull();

    paystack.refundTransaction.mockClear();
    const again = await refundAsCashier(payment.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT_CARD_SALE_REFUND_PENDING');
    expect(paystack.refundTransaction).not.toHaveBeenCalled();
  });

  test('a partly refunded sale cannot be refunded here (full refunds only) and says why', async () => {
    const { payment } = await cardSale();
    const approval = await managerApproval(t.request, { token: token(manager), approverUserId: manager, action: 'pos.refund_payment', targetId: payment.id });
    const partial = await as(manager).post(`/api/v1/cashiering/payments/${payment.id}/refund`).set('X-Manager-Approval', approval).send({ amount: '10.00', reason: 'one item' });
    expect(partial.status).toBe(201);

    const row = find(await listFor(cashier), payment.id);
    expect(row.state).toBe('partially_refunded');
    expect(row.disabledReason).toMatch(/refunded in part/);
    const res = await refundAsCashier(payment.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_CARD_SALE_NOT_REFUNDABLE');
  });

  test('another tenant sees nothing and gets 404, never 403', async () => {
    const { payment } = await cardSale();
    const outsider = ctx.b.users[0].id;
    expect((await as(outsider, ctx.b).get('/api/v1/pos/card-sales?date_from=2027-08-01&date_to=2027-08-01')).body.data ?? []).toEqual([]);
    const res = await as(outsider, ctx.b).post(`/api/v1/pos/card-sales/${payment.id}/refund`).send({ reason_code: 'customer_request' });
    expect([404, 403]).toContain(res.status);
    expect(res.status).toBe(404);
    expect(paystack.refundTransaction).not.toHaveBeenCalled();
  });

  test('a unknown payment id and a payment that is not a settled POS card sale are 404', async () => {
    expect((await refundAsCashier('999999999')).status).toBe(404);
    const folioPayment = await t.trx('payments').where({ tenant_id: ctx.a.id }).whereNull('pos_order_id').first('id');
    if (folioPayment) expect((await refundAsCashier(folioPayment.id)).status).toBe(404);
  });

  test('without cashiering.void_line the list and the refund are 403 (a pos_operator cannot refund)', async () => {
    const { payment } = await cardSale();
    expect((await as(operator).get('/api/v1/pos/card-sales?date_from=2027-08-01&date_to=2027-08-01')).status).toBe(403);
    const res = await as(operator).post(`/api/v1/pos/card-sales/${payment.id}/refund`).send({ reason_code: 'customer_request' });
    expect(res.status).toBe(403);
    expect(paystack.refundTransaction).not.toHaveBeenCalled();
  });

  test('without a manager PIN approval the refund is refused and nothing is sent; an approval for another payment does not work', async () => {
    const { payment } = await cardSale();
    const none = await refundAsCashier(payment.id, { approve: false });
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('FORBIDDEN_MANAGER_APPROVAL_REQUIRED');

    const other = await cardSale();
    const wrong = await managerApproval(t.request, { token: token(cashier), approverUserId: manager, action: 'pos.refund_payment', targetId: other.payment.id });
    const res = await as(cashier).post(`/api/v1/pos/card-sales/${payment.id}/refund`).set('X-Manager-Approval', wrong).send({ reason_code: 'customer_request' });
    expect(res.status).toBe(422);
    expect(paystack.refundTransaction).not.toHaveBeenCalled();
    expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
  });

  test('a cashier assigned to another outlet cannot see or refund this outlet\'s sale', async () => {
    const { payment } = await cardSale();
    const restricted = await user('cashier', false);
    await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: restricted, outlet_id: otherOutletId });
    expect(find(await listFor(restricted), payment.id)).toBeUndefined();
    const res = await refundAsCashier(payment.id, { who: restricted });
    expect(res.status).toBe(404);
    expect(paystack.refundTransaction).not.toHaveBeenCalled();
  });

  describe('reports: the sale stays on its day, the refund is a separate negative line on the day it was processed', () => {
    test('Sales report: gross keeps the refunded sale, refunds are negative on the refund day, net nets to zero over both days', async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-09-01' });
      const { payment, orderId } = await cardSale(); // sold 2027-09-01
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-09-02' });
      expect((await refundAsCashier(payment.id)).status).toBe(201); // refunded 2027-09-02

      const saleDay = await salesReport('2027-09-01', '2027-09-01');
      const saleTab = saleDay.tabs.find((tab) => String(tab.orderId) === String(orderId));
      expect(saleTab).toMatchObject({ refunded: true, total: payment.amount });
      expect(saleTab.payments[0]).toMatchObject({ refunded: true });
      expect(saleDay.refunds).toBeUndefined(); // the closed day did not change when the refund happened

      const refundDay = await salesReport('2027-09-02', '2027-09-02');
      expect(refundDay.tabs.find((tab) => String(tab.orderId) === String(orderId))).toBeUndefined();
      expect(refundDay.refunds.count).toBe(1);
      expect(refundDay.refunds.lines[0]).toMatchObject({ amount: `-${payment.amount}`, refundDate: '2027-09-02', originalBusinessDate: '2027-09-01', paymentId: String(payment.id) });
      expect(refundDay.summary.total).toBe('0.00');
      expect(refundDay.summary.netTotal).toBe(`-${payment.amount}`);
      const outletRow = refundDay.byOutlet.find((row) => String(row.outletId) === String(outlet.outletId));
      expect(outletRow).toMatchObject({ refunded: `-${payment.amount}`, net: `-${payment.amount}` });

      const both = await salesReport('2027-09-01', '2027-09-02');
      expect(both.summary.netTotal).toBe('0.00');
      expect(both.summary.total).toBe(payment.amount);
      // A refunded sale is not counted twice: one tab, one check, one tender line.
      expect(both.summary.checks).toBe(1);
      // Items follow the money (a refunded sale is still sold, so rows add up to the summary), but it carries no profit.
      const beer = both.topItems.find((item) => item.name === 'Card Sale Beer');
      expect(beer).toMatchObject({ quantity: 1, sales: '100.00' });
      expect(both.topItems.reduce((sum, row) => sum + Math.round(Number(row.sales) * 100), 0)).toBe(Math.round(Number(both.summary.subtotal) * 100));
    });

    test('a cash sale voided by hand (no refund) stays out of the figures: only a sale refunded in full is kept', async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-11-01' });
      const opened = await as(operator).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `V${next()}`.slice(0, 20) });
      const orderId = opened.body.data.id;
      await as(operator).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.beer, quantity: 1 });
      const settled = await as(operator).post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements: [{ method: 'cash' }] });
      expect(settled.status).toBe(200);
      const settlementId = settled.body.data.settlements[0].id;
      const approval = await managerApproval(t.request, { token: token(operator), approverUserId: manager, action: 'pos.void_settlement', targetId: settlementId });
      const voided = await as(operator).post(`/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`).set('X-Manager-Approval', approval).send({ reason: 'rung up by mistake' });
      expect(voided.status).toBe(200);

      const report = await salesReport('2027-11-01', '2027-11-01');
      expect(report.tabs.find((tab) => String(tab.orderId) === String(orderId))).toBeUndefined();
      expect(report.summary.total).toBe('0.00');
      expect(report.refunds).toBeUndefined();
    });

    test('refund lines are newest first and in a fixed order even when two refunds share a second (or fall on different weekdays)', async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-12-01' });
      const first = await cardSale();
      const second = await cardSale();
      const third = await cardSale();
      const refundIds = [];
      for (const sale of [first, second, third]) refundIds.push((await refundAsCashier(sale.payment.id)).body.data.id);
      // Same second for the first two; the third a Monday earlier in the week-day alphabet sense (a different day name).
      await t.trx('payments').whereIn('id', [refundIds[0], refundIds[1]]).update({ captured_at: new Date('2027-12-01T10:00:00Z') });
      await t.trx('payments').where({ id: refundIds[2] }).update({ captured_at: new Date('2027-11-30T23:00:00Z') });
      await t.trx('refund_reconciliations').whereIn('payment_id', refundIds).update({ business_date: '2027-12-01' });

      const report = await salesReport('2027-12-01', '2027-12-01');
      const order = report.refunds.lines.map((line) => String(line.refundPaymentId));
      // Newest first; the two that tie come out highest id first, every time.
      expect(order).toEqual([String(refundIds[1]), String(refundIds[0]), String(refundIds[2])]);
    });

    test('Sales report CSV has a refunds section', async () => {
      const { payment } = await cardSale();
      expect((await refundAsCashier(payment.id)).status).toBe(201);
      const res = await as(manager).get(`/api/v1/pos/reports/sales?date_from=2027-08-01&date_to=2027-08-01&outlet_id=${outlet.outletId}&format=csv&section=refunds`);
      expect(res.status).toBe(200);
      expect(res.text.split('\n')[0]).toContain('refundDate');
      expect(res.text).toContain(`-${payment.amount}`);
    });

    test('payment reconciliation: the original is a positive line on its day and the refund a negative line on the refund day', async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-10-01' });
      const { payment } = await cardSale();
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-10-03' });
      expect((await refundAsCashier(payment.id)).status).toBe(201);
      const day = async (date) => (await as(manager).get(`/api/v1/reconciliation/payments?date_from=${date}&date_to=${date}`)).body.data.lines.filter((line) => line.source.label === 'Card Sale Bar');
      const saleLines = await day('2027-10-01');
      expect(saleLines.some((line) => line.grossAmount === payment.amount && !line.isRefund)).toBe(true);
      expect(saleLines.some((line) => line.isRefund)).toBe(false);
      const refundLines = await day('2027-10-03');
      expect(refundLines.some((line) => line.isRefund && line.grossAmount === `-${payment.amount}`)).toBe(true);
      expect(refundLines.some((line) => !line.isRefund && line.grossAmount === payment.amount)).toBe(false);
    });
  });
});
