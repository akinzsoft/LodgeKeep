'use strict';

/**
 * "Card (external terminal)": a card sale taken on the hotel's OWN physical
 * terminal (Moniepoint, Opay, a bank POS, ...). Lodgekeep only records that it
 * happened (method/tender `terminal`), optionally against a provider and the
 * terminal's own reference. No gateway, no `payments` row, nothing to verify.
 *
 * Proves, per the request: (1) the reconciliation report separates the new
 * method, by provider, from Paystack and from cash; (2) Paystack still works
 * unchanged beside it; (3) the method needs no payment configuration at all.
 *
 * Ambient tax: `tests/helpers/fixtures.js` seeds a 7.5% VAT on `ctx.a`'s
 * property, so a 20.00 item carries 1.50 tax and, with the Register's fixed
 * 7.5% service charge (1.50), a check totals 23.00.
 */

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
const { managerApproval } = require('../helpers/approvals');
const { signAccessToken } = require('../../src/auth/tokens');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const { insertMenuItem } = require('../helpers/catalogue');

const BUSINESS_DATE = '2027-07-01';
// The report block runs on its own business date, so the sales the earlier tests
// recorded on BUSINESS_DATE do not leak into its exact counts.
const REPORT_DATE = '2027-07-02';
const FEE_PERCENTAGE = '2.50';
const CHECK_TOTAL = '23.00'; // 20.00 + 1.50 VAT + 1.50 service

describe('POS Register — Card (external terminal)', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let managerId;
  let operatorId;
  let outlet;
  let counter = 0;

  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
  });
  const idemKey = () => `ext-card-${(counter += 1)}`;
  // A settlement void needs a manager's PIN approval (src/modules/approvals); the manager approves their own.
  async function managerVoid(orderId, settlementId) {
    const approval = await managerApproval(t.request, { token: tokenFor(managerId), approverUserId: managerId, action: 'pos.void_settlement', targetId: settlementId });
    return as(managerId).post(`/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`).set('X-Manager-Approval', approval).set('Idempotency-Key', idemKey()).send({ reason: 'keyed in error' });
  }

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  async function openTab(userId = operatorId) {
    const opened = await as(userId).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `X${(counter += 1)}` });
    expect(opened.status).toBe(201);
    const added = await as(userId).post(`/api/v1/pos/orders/${opened.body.data.id}/items`).send({ menu_item_id: outlet.menuItemId, quantity: 1 });
    expect(added.status).toBe(200);
    return opened.body.data.id;
  }

  const settleWith = (orderId, settlement, userId = operatorId) =>
    as(userId).post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', idemKey()).send({ settlements: [{ service_charge: '1.50', ...settlement }] });

  async function capturedPaystackPayment(orderId) {
    const started = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).set('Idempotency-Key', idemKey()).send({ tender: 'card' });
    expect(started.status).toBe(201);
    await t.trx('payments').where({ id: started.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date(), provider_channel: 'card' });
    return started.body.data.id;
  }

  beforeEach(() => {
    paystack.initializeTransaction.mockReset();
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay/x', accessCode: 'x-access', reference }));
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
  });

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BUSINESS_DATE });
    await t.trx('property_payment_subaccounts').where({ tenant_id: ctx.a.id, property_id: propertyId }).update({ percentage_charge: FEE_PERCENTAGE });
    managerId = ctx.a.users[0].id;
    operatorId = ctx.a.users[1].id;
    await setRole(managerId, 'manager');
    await setRole(operatorId, 'pos_operator');

    const suffix = Date.now().toString(36).slice(-6);
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `XT-${suffix}`, name: 'Terminal Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `XT-T-${suffix}` });
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Terminal Beer', category: 'Drinks', price: '20.00' });
    outlet = { outletId, terminalId, menuItemId };
  });

  describe('recording the sale', () => {
    it('settles immediately as tender "terminal" with the provider and reference, and no payment row', async () => {
      const orderId = await openTab();
      const res = await settleWith(orderId, { method: 'terminal', terminal_provider: 'moniepoint', terminal_reference: '123456789012' });

      expect(res.status).toBe(200);
      const settlement = res.body.data.settlements[0];
      expect(settlement).toMatchObject({ method: 'terminal', tender: 'terminal', terminal_provider: 'moniepoint', terminal_reference: '123456789012', payment_id: null });
      expect(res.body.data.order.status).toBe('settled');
      expect(await t.trx('payments').where({ pos_order_id: orderId }).first()).toBeUndefined();
    });

    it('needs neither a provider nor a reference, and normalises the provider', async () => {
      const bare = await settleWith(await openTab(), { method: 'terminal' });
      expect(bare.status).toBe(200);
      expect(bare.body.data.settlements[0]).toMatchObject({ tender: 'terminal', terminal_provider: null, terminal_reference: null });

      const named = await settleWith(await openTab(), { method: 'terminal', terminal_provider: ' Opay ', terminal_reference: '   ' });
      expect(named.status).toBe(200);
      expect(named.body.data.settlements[0]).toMatchObject({ terminal_provider: 'opay', terminal_reference: null });
    });

    it('refuses an unknown provider or an over-long reference and leaves the tab open', async () => {
      const orderId = await openTab();
      const badProvider = await settleWith(orderId, { method: 'terminal', terminal_provider: 'paypal' });
      expect(badProvider.status).toBe(400);
      expect(badProvider.body.error.code).toBe('VALIDATION_INVALID_TERMINAL_PROVIDER');
      const longRef = await settleWith(orderId, { method: 'terminal', terminal_provider: 'gtbank', terminal_reference: 'x'.repeat(61) });
      expect(longRef.status).toBe(400);
      expect(longRef.body.error.code).toBe('VALIDATION_INVALID_TERMINAL_REFERENCE');

      expect((await t.trx('pos_orders').where({ id: orderId }).first()).status).toBe('open');
      expect(await t.trx('pos_order_settlements').where({ pos_order_id: orderId }).first()).toBeUndefined();
    });

    it('is never counted in the drawer: a terminal sale does not raise the shift expected cash', async () => {
      const shift = await as(operatorId).post('/api/v1/pos/shifts').send({ terminal_id: outlet.terminalId, opening_float: '10.00' });
      expect(shift.status).toBe(201);
      expect((await settleWith(await openTab(), { method: 'cash' })).status).toBe(200);
      expect((await settleWith(await openTab(), { method: 'terminal', terminal_provider: 'moniepoint' })).status).toBe(200);

      const close = await as(operatorId).post(`/api/v1/pos/shifts/${shift.body.data.id}/close`).set('Idempotency-Key', idemKey()).send({ counted_cash: '33.00' });
      expect(close.status).toBe(200);
      // float 10.00 + the one CASH sale 23.00; the terminal sale's 23.00 is not in the till.
      expect(close.body.data.expected_cash).toBe('33.00');
      expect(close.body.data.variance).toBe('0.00');
    });

    it('refuses non-text provider or reference values instead of storing them', async () => {
      const orderId = await openTab();
      for (const body of [{ terminal_provider: 5 }, { terminal_provider: ['opay'] }, { terminal_reference: { a: 1 } }, { terminal_reference: 12345 }]) {
        const res = await settleWith(orderId, { method: 'terminal', ...body });
        expect(res.status).toBe(400);
      }
      expect((await t.trx('pos_orders').where({ id: orderId }).first()).status).toBe('open');
    });

    it('settles a split bill that mixes cash and terminal, each group by its own method', async () => {
      const orderId = await openTab();
      const second = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.menuItemId, quantity: 1 });
      expect(second.status).toBe(200);
      const items = second.body.data.items;
      expect((await as(operatorId).post(`/api/v1/pos/orders/${orderId}/items/${items[0].id}/split-group`).send({ split_group: 1 })).status).toBe(200);
      expect((await as(operatorId).post(`/api/v1/pos/orders/${orderId}/items/${items[1].id}/split-group`).send({ split_group: 2 })).status).toBe(200);

      const res = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', idemKey()).send({
        settlements: [
          { split_group: 1, method: 'cash', service_charge: '1.50' },
          { split_group: 2, method: 'terminal', terminal_provider: 'opay', service_charge: '1.50' },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.settlements.map((row) => row.tender).sort()).toEqual(['cash', 'terminal']);
    });

    it('can be voided by a manager like any other settlement (no gateway involved)', async () => {
      const orderId = await openTab();
      const res = await settleWith(orderId, { method: 'terminal', terminal_provider: 'opay' });
      const settlementId = res.body.data.settlements[0].id;
      const voided = await managerVoid(orderId, settlementId);
      expect(voided.status).toBe(200);
      expect(voided.body.data.voided_at).not.toBeNull();
    });
  });

  describe('needs no payment configuration (a brand-new tenant on day one)', () => {
    it('works for the lowest Register role when the property has no payout subaccount, while Paystack is refused', async () => {
      await t.trx('property_payment_subaccounts').where({ tenant_id: ctx.a.id, property_id: propertyId }).delete();
      try {
        const orderId = await openTab();
        // Paystack needs the property's payout account...
        const card = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).set('Idempotency-Key', idemKey()).send({ tender: 'card' });
        // The existing "payment kept, checkout failed" answer, never a Paystack checkout link.
        expect(card.status).toBe(202);
        expect(card.body.meta.checkoutError).toMatch(/not configured a payout bank account/);
        expect(card.body.meta.authorizationUrl ?? null).toBeNull();
        expect(card.body.data.status).toBe('INITIATED');
        // ...the external terminal needs nothing: no subaccount, no gateway, no entitlement.
        const res = await settleWith(orderId, { method: 'terminal', terminal_provider: 'gtbank' });
        expect(res.status).toBe(200);
        expect(res.body.data.settlements[0].tender).toBe('terminal');
        expect(await t.trx('plan_entitlements').where({ feature_key: 'external_card_terminal' }).first()).toBeUndefined();
      } finally {
        // Restore for the later describe blocks (the harness only rolls back per file).
        await t.trx('property_payment_subaccounts').insert({
          tenant_id: ctx.a.id,
          property_id: propertyId,
          platform_payment_integration_id: (await t.trx('platform_payment_integrations').first('id')).id,
          subaccount_code: `ACCT_restored_${ctx.a.slug}`,
          bank_code: '057',
          bank_name: 'Zenith Bank',
          account_number_last4: '1784',
          account_name: 'Fixture Hotel Ltd',
          percentage_charge: FEE_PERCENTAGE,
        });
      }
    });
  });

  describe('Paystack still works, unchanged, beside it', () => {
    it('still refuses a card settlement with no captured Paystack payment, and settles one that has', async () => {
      const orderId = await openTab();
      const refused = await settleWith(orderId, { method: 'card' });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect((await t.trx('pos_orders').where({ id: orderId }).first()).status).toBe('open');

      const paymentId = await capturedPaystackPayment(orderId);
      const ok = await settleWith(orderId, { method: 'card', payment_id: paymentId });
      expect(ok.status).toBe(200);
      expect(ok.body.data.settlements[0]).toMatchObject({ method: 'card', tender: 'card', terminal_provider: null, terminal_reference: null });
      expect(String(ok.body.data.settlements[0].payment_id)).toBe(String(paymentId));
    });

    it('a terminal sale never claims or disturbs a Paystack payment on another tab', async () => {
      const paystackTab = await openTab();
      const paymentId = await capturedPaystackPayment(paystackTab);
      expect((await settleWith(await openTab(), { method: 'terminal', terminal_provider: 'moniepoint' })).status).toBe(200);
      expect((await t.trx('payments').where({ id: paymentId }).first()).status).toBe('CAPTURED');
      expect((await settleWith(paystackTab, { method: 'card', payment_id: paymentId })).status).toBe(200);
    });
  });

  describe('reconciliation report', () => {
    let report;
    let csv;
    let voidedSettlementId;

    beforeAll(async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: REPORT_DATE });
      // One of each: cash, Paystack card, and terminal sales across providers.
      await settleWith(await openTab(), { method: 'cash' });
      const paystackTab = await openTab();
      await settleWith(paystackTab, { method: 'card', payment_id: await capturedPaystackPayment(paystackTab) });
      await settleWith(await openTab(), { method: 'terminal', terminal_provider: 'moniepoint', terminal_reference: 'MP-0001' });
      await settleWith(await openTab(), { method: 'terminal', terminal_provider: 'moniepoint', terminal_reference: 'MP-0002' });
      await settleWith(await openTab(), { method: 'terminal', terminal_provider: 'opay' });
      await settleWith(await openTab(), { method: 'terminal' });
      const toVoid = await openTab();
      const res = await settleWith(toVoid, { method: 'terminal', terminal_provider: 'gtbank' });
      voidedSettlementId = res.body.data.settlements[0].id;
      await managerVoid(toVoid, voidedSettlementId);

      const got = await as(managerId).get(`/api/v1/reconciliation/payments?date_from=${REPORT_DATE}&date_to=${REPORT_DATE}`);
      expect(got.status).toBe(200);
      report = got.body.data;
      csv = (await as(managerId).get(`/api/v1/reconciliation/payments?date_from=${REPORT_DATE}&date_to=${REPORT_DATE}&format=csv`)).text;
    });

    const posLines = (method) => report.lines.filter((line) => line.source.kind === 'pos' && line.method === method);

    it('shows external-terminal sales as their own method, apart from Paystack card and cash', () => {
      const methods = Object.fromEntries(report.byMethod.map((row) => [row.method, row]));
      expect(methods.terminal).toBeDefined();
      expect(methods.terminal.count).toBe(4); // moniepoint x2, opay, no provider (the gtbank one is voided)
      expect(methods.terminal.grossTotal).toBe('92.00');
      expect(methods.card).toBeDefined();
      expect(methods.cash).toBeDefined();
    });

    it('groups terminal sales by provider, with a bucket for sales that gave none, and omits voided ones', () => {
      const byProvider = Object.fromEntries(report.byTerminalProvider.map((row) => [row.provider ?? 'none', row]));
      expect(byProvider.moniepoint).toMatchObject({ count: 2, grossTotal: '46.00', currency: 'NGN' });
      expect(byProvider.opay).toMatchObject({ count: 1, grossTotal: '23.00' });
      expect(byProvider.none).toMatchObject({ count: 1, grossTotal: '23.00' });
      expect(byProvider.gtbank).toBeUndefined();
      // Paystack and cash never appear in the provider grouping.
      expect(report.byTerminalProvider.reduce((n, row) => n + row.count, 0)).toBe(4);
    });

    it('carries no gateway fee on a terminal line, and the reference the hotel ticks against its provider report', () => {
      const lines = posLines('terminal');
      expect(lines).toHaveLength(4);
      for (const line of lines) {
        expect(line.feeAmount).toBe('0.00');
        expect(line.netAmount).toBe(line.grossAmount);
        expect(line.providerReference).toBeNull();
        expect(line.providerChannel).toBeNull();
      }
      expect(lines.map((line) => line.terminalReference).filter(Boolean).sort()).toEqual(['MP-0001', 'MP-0002']);
    });

    it('leaves Paystack card and cash lines exactly as before (fee snapshot intact, no terminal fields set)', () => {
      const [card] = posLines('card');
      expect(card.grossAmount).toBe(CHECK_TOTAL);
      expect(card.feeAmount).toBe('0.58'); // 2.50% of 23.00
      expect(card.netAmount).toBe('22.42');
      expect(card.providerReference).toMatch(/\S/);
      expect(card.terminalProvider).toBeNull();
      expect(card.terminalReference).toBeNull();
      const [cash] = posLines('cash');
      expect(cash).toMatchObject({ feeAmount: '0.00', providerReference: null, terminalProvider: null });
    });

    it("lists terminal sales as their own tender in the POS Sales report, with the provider on each tab's payment", async () => {
      const res = await as(managerId).get(`/api/v1/pos/reports/sales?date_from=${REPORT_DATE}&date_to=${REPORT_DATE}`);
      expect(res.status).toBe(200);
      const byTender = Object.fromEntries(res.body.data.byTender.map((row) => [row.tender, row]));
      expect(byTender.terminal).toMatchObject({ checks: 4, total: '92.00' });
      expect(byTender.cash.checks).toBe(1);
      expect(byTender.card.checks).toBe(1);
      const payments = res.body.data.tabs.flatMap((tab) => tab.payments);
      expect(payments.filter((p) => p.tender === 'terminal').map((p) => p.terminalProvider ?? 'none').sort()).toEqual(['moniepoint', 'moniepoint', 'none', 'opay']);
      // Non-terminal payment entries keep exactly their old shape.
      expect(payments.filter((p) => p.tender !== 'terminal').every((p) => !('terminalProvider' in p))).toBe(true);
    });

    it('exports the provider and reference in the CSV', () => {
      const [header] = csv.split('\n');
      expect(header).toContain('terminalProvider');
      expect(header).toContain('terminalReference');
      expect(csv).toContain('MP-0001');
    });

    it("writes the provider into the Sales report CSV's payment text", async () => {
      const res = await as(managerId).get(`/api/v1/pos/reports/sales?date_from=${REPORT_DATE}&date_to=${REPORT_DATE}&format=csv&section=tabs`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('terminal via moniepoint');
    });
  });
});
