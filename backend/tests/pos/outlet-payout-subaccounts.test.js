'use strict';

/**
 * Per-outlet Paystack subaccounts for online payments. Resolution inside
 * `startPaystackCheckout`: the payment's order's outlet account, else the
 * property's, else the checkout is refused (never the platform account).
 * Folio and portal payments carry no pos_order_id and always take the
 * property's account. Paystack is mocked at the adapter boundary.
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
const { signAccessToken } = require('../../src/auth/tokens');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const { insertMenuItem } = require('../helpers/catalogue');
const { scopedDb } = require('../../src/db');
const { workerContext } = require('../../src/modules/tenancy/context');
const cashieringService = require('../../src/modules/cashiering/service');

const GatewayRequestError = paystackAdapterModule.GatewayRequestError;
const REPORT_DATE = '2027-09-02';

describe('per-outlet payout subaccounts (online card payments)', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let adminId;
  let managerId;
  let operatorId;
  let counter = 0;
  let propertyCode;

  const tokenFor = (userId, tenant = ctx.a) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const as = (userId, tenant) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    put: (url) => t.request.put(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    delete: (url) => t.request.delete(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
  });
  const idemKey = () => `payout-${(counter += 1)}`;
  const payoutUrl = (outletId) => `/api/v1/pos/outlets/${outletId}/payout-account`;
  const dbCtx = () => scopedDb().for(workerContext({ tenantId: ctx.a.id, propertyId }));

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  async function newOutlet(label, type = 'bar') {
    counter += 1;
    const suffix = `${Date.now().toString(36).slice(-5)}${counter}`;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `PO-${suffix}`, name: label, type });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `PO-T-${suffix}` });
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `Beer ${suffix}`, category: 'Drinks', price: '20.00' });
    return { outletId, terminalId, menuItemId };
  }

  /** Gives an outlet its own account through the real endpoint. */
  async function giveOutletAccount(outletId, code, { last4 = '4321', name = 'Outlet Account Ltd' } = {}) {
    paystack.createSubaccount.mockResolvedValueOnce({ subaccountCode: code, accountName: name, bankName: 'Zenith Bank' });
    const res = await as(adminId).put(payoutUrl(outletId)).send({ bank_code: '057', bank_name: 'Zenith Bank', account_number: `00000${last4}` });
    expect(res.status).toBe(200);
    return res;
  }

  async function openTab(outlet) {
    const opened = await as(operatorId).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `T${(counter += 1)}` });
    expect(opened.status).toBe(201);
    await as(operatorId).post(`/api/v1/pos/orders/${opened.body.data.id}/items`).send({ menu_item_id: outlet.menuItemId, quantity: 1 }).expect(200);
    return opened.body.data.id;
  }

  const startRegisterCheckout = (orderId, tender = 'card') =>
    as(operatorId).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).set('Idempotency-Key', idemKey()).send({ tender });

  const lastInitSubaccount = () => paystack.initializeTransaction.mock.calls.at(-1)[0].subaccount;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    propertyCode = `ACCT_fixture_${ctx.a.slug}`;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: REPORT_DATE });
    managerId = ctx.a.users[0].id;
    operatorId = ctx.a.users[1].id;
    [adminId] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `payout-admin-${Date.now().toString(36)}@example.com`, first_name: 'Ada', last_name: 'Min', password_hash: ctx.a.users[0].passwordHash ?? 'x', status: 'active' });
    await setRole(adminId, 'admin');
    await setRole(managerId, 'manager');
    await setRole(operatorId, 'pos_operator');
  });

  beforeEach(() => {
    jest.resetAllMocks();
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay', accessCode: `ac-${counter}`, reference }));
    // The REAL seeded integration id: the new table has a foreign key to it, and in a full run earlier suites leave id 1 unused.
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: ctx.platformPaymentIntegrations.ngn, currency: 'NGN' }, adapter: paystack }));
  });

  describe('routing', () => {
    it('an outlet with no account of its own settles to the PROPERTY account, stamped source=property', async () => {
      const outlet = await newOutlet('Plain Bar');
      const res = await startRegisterCheckout(await openTab(outlet));
      expect(res.status).toBe(201);
      expect(lastInitSubaccount()).toBe(propertyCode);
      const payment = await t.trx('payments').where({ id: res.body.data.id }).first();
      expect(payment).toMatchObject({ subaccount_code: propertyCode, subaccount_source: 'property' });
    });

    it('an outlet WITH its own account settles to it, stamped source=outlet, and a sibling outlet is unaffected', async () => {
      const own = await newOutlet('Own Bar');
      const sibling = await newOutlet('Sibling Bar');
      await giveOutletAccount(own.outletId, 'ACCT_own_bar');

      const ownRes = await startRegisterCheckout(await openTab(own), 'nqr');
      expect(lastInitSubaccount()).toBe('ACCT_own_bar');
      expect(await t.trx('payments').where({ id: ownRes.body.data.id }).first()).toMatchObject({ subaccount_code: 'ACCT_own_bar', subaccount_source: 'outlet', platform_fee_percentage: '0.00' });

      await startRegisterCheckout(await openTab(sibling));
      expect(lastInitSubaccount()).toBe(propertyCode);
    });

    it('a FOLIO payment (no pos_order_id) takes the property account even when outlets have their own — and returns the account, not a 500', async () => {
      const outlet = await newOutlet('Folio Bystander Bar');
      await giveOutletAccount(outlet.outletId, 'ACCT_bystander');
      const [folioId] = await t.trx('folios').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: ctx.a.reservations[0].id, folio_number: `PF${Date.now().toString(36).slice(-7)}`, status: 'open', balance: '0.00', currency: 'NGN', billed_to: 'Guest' });

      const res = await as(managerId).post(`/api/v1/cashiering/folios/${folioId}/payments/paystack`).set('Idempotency-Key', idemKey()).send({ amount: '60.00', currency: 'NGN', guest_email: 'g@example.com' });
      expect(res.status).toBe(201);
      expect(lastInitSubaccount()).toBe(propertyCode);
      expect(await t.trx('payments').where({ id: res.body.data.id }).first()).toMatchObject({ pos_order_id: null, subaccount_code: propertyCode, subaccount_source: 'property' });
    });

    it('a portal-shaped payment (folio intent then checkout, as portal/service.js does) takes the property account', async () => {
      const outlet = await newOutlet('Portal Bystander Bar');
      await giveOutletAccount(outlet.outletId, 'ACCT_portal_bystander');
      const [folioId] = await t.trx('folios').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: ctx.a.reservations[0].id, folio_number: `PP${Date.now().toString(36).slice(-7)}`, status: 'open', balance: '0.00', currency: 'NGN', billed_to: 'Guest' });
      const payment = await dbCtx().transaction((trx) => cashieringService.initiatePaystackPaymentIntent({ trx, folioId, amount: '10.00', currency: 'NGN', idempotencyKey: idemKey() }));
      const started = await cashieringService.startPaystackCheckout({ context: workerContext({ tenantId: ctx.a.id, propertyId }), paymentId: payment.id, guestEmail: 'g@example.com' });
      expect(started.payment).toMatchObject({ subaccount_code: propertyCode, subaccount_source: 'property' });
      expect(lastInitSubaccount()).toBe(propertyCode);
    });

    it('a QR guest-order payment at an outlet with its own account settles to it', async () => {
      const outlet = await newOutlet('QR Bar');
      await giveOutletAccount(outlet.outletId, 'ACCT_qr_bar');
      const orderId = await openTab(outlet);
      const payment = await dbCtx().transaction((trx) => cashieringService.initiatePosOrderPaystackPaymentIntent({ trx, posOrderId: orderId, amount: '20.00', currency: 'NGN', idempotencyKey: idemKey() }));
      const started = await cashieringService.startPaystackCheckout({ context: workerContext({ tenantId: ctx.a.id, propertyId }), paymentId: payment.id, guestEmail: 'g@example.com' });
      expect(started.payment).toMatchObject({ subaccount_code: 'ACCT_qr_bar', subaccount_source: 'outlet' });
    });

    it('with NEITHER an outlet nor a property account the checkout is refused cleanly — nothing sent to Paystack, payment left INITIATED, never a 500', async () => {
      const outlet = await newOutlet('Nowhere Bar');
      await t.trx('property_payment_subaccounts').where({ property_id: propertyId }).update({ is_active: false });
      try {
        const res = await startRegisterCheckout(await openTab(outlet));
        expect(res.status).toBe(202);
        expect(res.body.meta.checkoutError).toMatch(/payout bank account/i);
        expect(res.body.data.status).toBe('INITIATED');
        expect(paystack.initializeTransaction).not.toHaveBeenCalled();

        // The same property blocks a folio payment too.
        const [folioId] = await t.trx('folios').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: ctx.a.reservations[0].id, folio_number: `PN${Date.now().toString(36).slice(-7)}`, status: 'open', balance: '0.00', currency: 'NGN', billed_to: 'Guest' });
        const folioRes = await as(managerId).post(`/api/v1/cashiering/folios/${folioId}/payments/paystack`).set('Idempotency-Key', idemKey()).send({ amount: '5.00', currency: 'NGN', guest_email: 'g@example.com' });
        expect(folioRes.status).toBe(202);
        expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      } finally {
        await t.trx('property_payment_subaccounts').where({ property_id: propertyId }).update({ is_active: true });
      }
    });

    it('an outlet account still works when the property has none', async () => {
      const outlet = await newOutlet('Only Outlet Account Bar');
      await giveOutletAccount(outlet.outletId, 'ACCT_only_outlet');
      await t.trx('property_payment_subaccounts').where({ property_id: propertyId }).update({ is_active: false });
      try {
        const res = await startRegisterCheckout(await openTab(outlet));
        expect(res.status).toBe(201);
        expect(lastInitSubaccount()).toBe('ACCT_only_outlet');
      } finally {
        await t.trx('property_payment_subaccounts').where({ property_id: propertyId }).update({ is_active: true });
      }
    });

    it('a payment already routed keeps its snapshot when the outlet account is later replaced or removed, and a reopened checkout is not re-routed', async () => {
      const outlet = await newOutlet('Changing Bar');
      await giveOutletAccount(outlet.outletId, 'ACCT_old_changing');
      const orderId = await openTab(outlet);
      const first = await startRegisterCheckout(orderId);
      expect(first.body.data.subaccount_code).toBe('ACCT_old_changing');

      await giveOutletAccount(outlet.outletId, 'ACCT_new_changing', { last4: '9999' });
      const retry = await startRegisterCheckout(orderId); // reopens the same PENDING transaction
      expect(retry.body.data.id).toBe(first.body.data.id);
      expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
      expect((await t.trx('payments').where({ id: first.body.data.id }).first()).subaccount_code).toBe('ACCT_old_changing');

      // A NEW check uses the new account.
      await startRegisterCheckout(await openTab(outlet));
      expect(lastInitSubaccount()).toBe('ACCT_new_changing');

      // Removing the outlet account sends the next payment back to the property.
      expect((await as(adminId).delete(payoutUrl(outlet.outletId))).status).toBe(200);
      await startRegisterCheckout(await openTab(outlet));
      expect(lastInitSubaccount()).toBe(propertyCode);
      expect((await t.trx('payments').where({ id: first.body.data.id }).first()).subaccount_code).toBe('ACCT_old_changing');
    });
  });

  describe('managing the account', () => {
    it('is admin-only to change; reading needs setup.view (managers can read, operators cannot)', async () => {
      const outlet = await newOutlet('Perm Bar');
      for (const userId of [operatorId, managerId]) {
        expect((await as(userId).put(payoutUrl(outlet.outletId)).send({ bank_code: '057', bank_name: 'Zenith', account_number: '0123456789' })).status).toBe(403);
        expect((await as(userId).post(`${payoutUrl(outlet.outletId)}/resolve-bank-account`).send({ bank_code: '057', account_number: '0123456789' })).status).toBe(403);
        expect((await as(userId).delete(payoutUrl(outlet.outletId))).status).toBe(403);
      }
      expect((await as(managerId).get(payoutUrl(outlet.outletId))).status).toBe(200);
      expect((await as(operatorId).get(payoutUrl(outlet.outletId))).status).toBe(403);
    });

    it('names the Paystack subaccount "<Property> — <Outlet>", stores only the last 4, and shows where payments settle', async () => {
      const outlet = await newOutlet('Rooftop Lounge');
      const before = (await as(adminId).get(payoutUrl(outlet.outletId))).body.data;
      expect(before.account).toBeNull();
      expect(before.settles_to).toMatchObject({ source: 'property', bank_name: 'Zenith Bank', account_number_last4: '1784' });

      const res = await giveOutletAccount(outlet.outletId, 'ACCT_rooftop', { last4: '4321', name: 'Rooftop Ltd' });
      const property = await t.trx('properties').where({ id: propertyId }).first('name');
      expect(paystack.createSubaccount).not.toHaveBeenCalledWith(expect.objectContaining({ accountNumber: expect.stringContaining(' ') }));
      expect(res.body.data.account).toMatchObject({ bank_name: 'Zenith Bank', account_number_last4: '4321', account_name: 'Rooftop Ltd' });
      expect(JSON.stringify(res.body.data)).not.toContain('000004321');
      expect(res.body.data.settles_to).toMatchObject({ source: 'outlet', account_number_last4: '4321' });
      const row = await t.trx('pos_outlet_payment_subaccounts').where({ subaccount_code: 'ACCT_rooftop' }).first();
      expect(row.account_number_last4).toBe('4321');
      expect(Object.values(row)).not.toContain('000004321');
      expect(property.name).toBeTruthy();
    });

    it('passes "<Property> — <Outlet>" as the business name', async () => {
      const outlet = await newOutlet('Naming Bar');
      await giveOutletAccount(outlet.outletId, 'ACCT_naming');
      const property = await t.trx('properties').where({ id: propertyId }).first('name');
      expect(paystack.createSubaccount).toHaveBeenCalledWith(expect.objectContaining({ businessName: `${property.name} — Naming Bar`, percentageCharge: '0.00' }));
    });

    it('keeps history: replacing deactivates the old row, only one stays active, and the database refuses a second active row', async () => {
      const outlet = await newOutlet('History Bar');
      await giveOutletAccount(outlet.outletId, 'ACCT_hist_1');
      await giveOutletAccount(outlet.outletId, 'ACCT_hist_2');
      const rows = await t.trx('pos_outlet_payment_subaccounts').where({ outlet_id: outlet.outletId }).orderBy('id');
      expect(rows.map((r) => [r.subaccount_code, !!r.is_active])).toEqual([['ACCT_hist_1', false], ['ACCT_hist_2', true]]);
      await expect(
        t.trx('pos_outlet_payment_subaccounts').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outlet.outletId, platform_payment_integration_id: ctx.platformPaymentIntegrations.ngn, subaccount_code: 'ACCT_hist_3', bank_code: '057', bank_name: 'Z', account_number_last4: '1111', account_name: 'X' })
      ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    });

    it('reports a duplicate bank account as "already used" and stores nothing — it never reuses another subaccount', async () => {
      const outlet = await newOutlet('Duplicate Bar');
      paystack.createSubaccount.mockRejectedValueOnce(new GatewayRequestError('paystack', 'Subaccount with this account number already exists', { httpStatus: 400, body: { status: false, message: 'Subaccount with this account number already exists' } }));
      const res = await as(adminId).put(payoutUrl(outlet.outletId)).send({ bank_code: '057', bank_name: 'Zenith Bank', account_number: '0123456789' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_PAYOUT_ACCOUNT_ALREADY_USED');
      expect(res.body.error.message).toMatch(/already used by another payout account/i);
      expect(await t.trx('pos_outlet_payment_subaccounts').where({ outlet_id: outlet.outletId }).count({ n: '*' }).first().then((r) => Number(r.n))).toBe(0);
    });

    it('a Paystack rejection of the details is a clear 422; an outage is a 502 — neither stores anything', async () => {
      const outlet = await newOutlet('Rejected Bar');
      paystack.createSubaccount.mockRejectedValueOnce(new GatewayRequestError('paystack', 'Account details are invalid', { httpStatus: 400, body: { message: 'Account details are invalid' } }));
      const rejected = await as(adminId).put(payoutUrl(outlet.outletId)).send({ bank_code: '057', bank_name: 'Zenith Bank', account_number: '0123456789' });
      expect(rejected.status).toBe(422);
      expect(rejected.body.error.code).toBe('PAYOUT_ACCOUNT_REJECTED');
      paystack.createSubaccount.mockRejectedValueOnce(new GatewayRequestError('paystack', 'the request timed out', { timedOut: true }));
      const outage = await as(adminId).put(payoutUrl(outlet.outletId)).send({ bank_code: '057', bank_name: 'Zenith Bank', account_number: '0123456789' });
      expect(outage.status).toBe(502);
      expect(await t.trx('pos_outlet_payment_subaccounts').where({ outlet_id: outlet.outletId }).count({ n: '*' }).first().then((r) => Number(r.n))).toBe(0);
    });

    it('validates the body, refuses a store outlet, and treats another tenant\'s outlet as not found', async () => {
      const outlet = await newOutlet('Valid Bar');
      expect((await as(adminId).put(payoutUrl(outlet.outletId)).send({ bank_code: '057' })).status).toBe(400);
      expect((await as(adminId).put(payoutUrl(outlet.outletId)).send({ bank_code: '057', bank_name: 'Z', account_number: 'abc' })).status).toBe(400);
      const store = await newOutlet('Main Store', 'store');
      const storeRes = await as(adminId).put(payoutUrl(store.outletId)).send({ bank_code: '057', bank_name: 'Z', account_number: '0123456789' });
      expect(storeRes.status).toBe(422);
      expect(storeRes.body.error.code).toBe('BUSINESS_RULE_STORE_OUTLET_NOT_SELLABLE');
      expect((await as(adminId).get(payoutUrl(ctx.b.posOutlets[0].id))).status).toBe(400);
      expect(paystack.createSubaccount).not.toHaveBeenCalled();
    });

    it('resolves the account name through Paystack without storing anything', async () => {
      const outlet = await newOutlet('Resolve Bar');
      paystack.resolveBankAccount.mockResolvedValueOnce({ accountName: 'RESOLVED NAME' });
      const res = await as(adminId).post(`${payoutUrl(outlet.outletId)}/resolve-bank-account`).send({ bank_code: '057', account_number: '0123456789' });
      expect(res.status).toBe(200);
      expect(res.body.data.accountName).toBe('RESOLVED NAME');
      expect(await t.trx('pos_outlet_payment_subaccounts').where({ outlet_id: outlet.outletId }).count({ n: '*' }).first().then((r) => Number(r.n))).toBe(0);
    });

    it('records create, replace and deactivate in the audit log', async () => {
      const outlet = await newOutlet('Audit Bar');
      await giveOutletAccount(outlet.outletId, 'ACCT_audit_1');
      await giveOutletAccount(outlet.outletId, 'ACCT_audit_2');
      await as(adminId).delete(payoutUrl(outlet.outletId));
      const rows = await t.trx('audit_log').where({ entity_type: 'pos_outlet_payment_subaccounts' }).whereIn('action', ['create', 'replace', 'deactivate']);
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['create', 'replace', 'deactivate']));
    });
  });

  describe('reconciliation', () => {
    let report;
    let csv;
    let barA;
    let barB;

    async function capture(paymentId) {
      await t.trx('payments').where({ id: paymentId }).update({ status: 'CAPTURED', captured_at: new Date() });
    }
    async function paidTab(outlet) {
      const orderId = await openTab(outlet);
      const started = await startRegisterCheckout(orderId);
      await capture(started.body.data.id);
      const res = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', idemKey()).send({ settlements: [{ method: 'card', service_charge: '1.50', payment_id: started.body.data.id }] });
      expect(res.status).toBe(200);
      return started.body.data.id;
    }

    beforeAll(async () => {
      barA = await newOutlet('Recon Bar A');
      barB = await newOutlet('Recon Bar B');
      const barC = await newOutlet('Recon Bar C (property account)');
      await giveOutletAccount(barA.outletId, 'ACCT_recon_a', { last4: '1111', name: 'Bar A Ltd' });
      await giveOutletAccount(barB.outletId, 'ACCT_recon_b', { last4: '2222', name: 'Bar B Ltd' });
      await paidTab(barA);
      await paidTab(barA);
      await paidTab(barB);
      const legacyPaymentId = await paidTab(barC);
      // A payment made before this feature: a code but no source recorded.
      await t.trx('payments').where({ id: legacyPaymentId }).update({ subaccount_source: null });
      // Replace Bar A's account AFTER the sales — the report must still name the old one.
      await giveOutletAccount(barA.outletId, 'ACCT_recon_a_new', { last4: '3333' });
      const got = await as(managerId).get(`/api/v1/reconciliation/payments?date_from=${REPORT_DATE}&date_to=${REPORT_DATE}`);
      expect(got.status).toBe(200);
      report = got.body.data;
      csv = (await as(managerId).get(`/api/v1/reconciliation/payments?date_from=${REPORT_DATE}&date_to=${REPORT_DATE}&format=csv`)).text;
    });

    it('groups Paystack money by the account it settled to, from the snapshot, naming the outlet', () => {
      const byCode = Object.fromEntries(report.bySettlementAccount.map((row) => [row.subaccountCode, row]));
      expect(byCode.ACCT_recon_a).toMatchObject({ source: 'outlet', outlet: 'Recon Bar A', accountLast4: '1111', accountName: 'Bar A Ltd', count: 2, grossTotal: '46.00' });
      expect(byCode.ACCT_recon_b).toMatchObject({ source: 'outlet', outlet: 'Recon Bar B', accountLast4: '2222', count: 1, grossTotal: '23.00' });
      // Bar A's account was replaced after the sales; its payments still resolve to the old one.
      expect(byCode.ACCT_recon_a_new).toBeUndefined();
    });

    it('reads a legacy payment (code, no source) as the property account', () => {
      const legacy = report.bySettlementAccount.find((row) => row.subaccountCode === propertyCode);
      expect(legacy).toMatchObject({ source: 'property', outlet: null, accountLast4: '1784', bankName: 'Zenith Bank', count: 1 });
    });

    it('puts the account on each line and in the CSV', () => {
      const line = report.lines.find((l) => l.settlementAccount?.subaccountCode === 'ACCT_recon_b');
      expect(line.settlementAccount).toMatchObject({ source: 'outlet', outletName: 'Recon Bar B' });
      expect(csv.split('\n')[0]).toContain('settlementSource,settlementOutlet,settlementBank,settlementAccountLast4');
      expect(csv).toContain('outlet,Recon Bar A');
    });
  });
});
