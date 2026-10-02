'use strict';

/**
 * Per-outlet terminal account RECORDING: an admin records which bank account
 * each outlet's Moniepoint/Opay/GTBank terminal pays into; a terminal sale
 * snapshots that label on the settlement so reconciliation can be matched
 * against the account's own report. Changes no money flow.
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

const BUSINESS_DATE = '2027-07-01';
// The report block runs on its own business date, so the sales the earlier tests
// recorded on BUSINESS_DATE do not leak into its exact counts.
const REPORT_DATE = '2027-07-02';
const FEE_PERCENTAGE = '2.50';
const CHECK_TOTAL = '23.00'; // 20.00 + 1.50 VAT + 1.50 service


describe('POS outlet terminal accounts (recording only)', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let managerId;
  let operatorId;
  let outlet;
  let counter = 0;

  const tokenFor = (userId, tenant = ctx.a) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const as = (userId, tenant) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    put: (url) => t.request.put(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    delete: (url) => t.request.delete(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
  });
  const idemKey = () => `acct-${(counter += 1)}`;
  const accountUrl = (provider, outletId = outlet.outletId) => `/api/v1/pos/outlets/${outletId}/terminal-accounts/${provider}`;
  const setAccount = (provider, body, userId = managerId) => as(userId).put(accountUrl(provider)).send(body);

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  async function settleTerminal(settlement) {
    const opened = await as(operatorId).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `A${(counter += 1)}` });
    expect(opened.status).toBe(201);
    const orderId = opened.body.data.id;
    await as(operatorId).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.menuItemId, quantity: 1 });
    const res = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', idemKey()).send({ settlements: [{ service_charge: '1.50', ...settlement }] });
    expect(res.status).toBe(200);
    return t.trx('pos_order_settlements').where({ id: res.body.data.settlements[0].id }).first();
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-08-01' });
    managerId = ctx.a.users[0].id;
    operatorId = ctx.a.users[1].id;
    await setRole(managerId, 'manager');
    await setRole(operatorId, 'pos_operator');
    const suffix = Date.now().toString(36).slice(-6);
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `TA-${suffix}`, name: 'Account Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `TA-T-${suffix}` });
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Account Beer', category: 'Drinks', price: '20.00' });
    outlet = { outletId, terminalId, menuItemId };
  });

  describe('managing the setting', () => {
    it('is pos.manage only: an operator can neither read nor change it', async () => {
      expect((await as(operatorId).get(`/api/v1/pos/outlets/${outlet.outletId}/terminal-accounts`)).status).toBe(403);
      expect((await setAccount('gtbank', { account_number: '0123456789' }, operatorId)).status).toBe(403);
      expect((await as(operatorId).delete(accountUrl('gtbank'))).status).toBe(403);
    });

    it('records, lists with the last 4, replaces in place, and removes', async () => {
      const created = await setAccount('gtbank', { account_number: '0123456789', account_label: ' Bar GTB ' });
      expect(created.status).toBe(200);
      expect(created.body.data).toMatchObject({ provider: 'gtbank', account_number: '0123456789', account_number_last4: '6789', account_label: 'Bar GTB' });

      const replaced = await setAccount('gtbank', { account_number: '0222233334' });
      expect(replaced.body.data).toMatchObject({ account_number_last4: '3334', account_label: null });

      const listed = await as(managerId).get(`/api/v1/pos/outlets/${outlet.outletId}/terminal-accounts`);
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0].id).toBe(created.body.data.id);

      expect((await as(managerId).delete(accountUrl('gtbank'))).status).toBe(200);
      expect((await as(managerId).get(`/api/v1/pos/outlets/${outlet.outletId}/terminal-accounts`)).body.data).toEqual([]);
      expect((await as(managerId).delete(accountUrl('gtbank'))).status).toBe(404);
    });

    it('rejects unknown providers, bad numbers, long labels, and an Other account with no label, writing nothing', async () => {
      expect((await setAccount('other', { account_number: '0123456789' })).status).toBe(400); // Other is identified by its label
      expect((await setAccount('other', { account_number: '0123456789', account_label: '   ' })).status).toBe(400);
      expect((await setAccount('zenith', { account_number: '0123456789' })).status).toBe(400);
      expect((await setAccount('opay', { account_number: 'abc' })).status).toBe(400);
      expect((await setAccount('opay', { account_number: '12' })).status).toBe(400);
      expect((await setAccount('opay', {})).status).toBe(400);
      expect((await setAccount('opay', { account_number: '0123456789', account_label: 'x'.repeat(81) })).status).toBe(400);
      expect(await t.trx('pos_outlet_terminal_accounts').where({ outlet_id: outlet.outletId })).toEqual([]);
    });

    it("cannot reach another tenant's outlet (answered as a missing outlet)", async () => {
      const foreign = ctx.b.posOutlets[0].id;
      expect((await as(managerId).put(accountUrl('opay', foreign)).send({ account_number: '0123456789' })).status).toBe(400);
      expect((await as(managerId).get(`/api/v1/pos/outlets/${foreign}/terminal-accounts`)).status).toBe(400);
    });

    it('takes any bank as free text, and records an Other account identified by its label', async () => {
      const bank = await setAccount('gtbank', { account_number: '0123456789', account_label: 'Some Brand New Microfinance Bank — Bar' });
      expect(bank.status).toBe(200);
      expect(bank.body.data.account_label).toBe('Some Brand New Microfinance Bank — Bar');

      const other = await setAccount('other', { account_number: '7070707070', account_label: ' Zenith POS — Zenith Bank ' });
      expect(other.status).toBe(200);
      expect(other.body.data).toMatchObject({ provider: 'other', account_label: 'Zenith POS — Zenith Bank', account_number_last4: '7070' });
      await as(managerId).delete(accountUrl('gtbank'));
      await as(managerId).delete(accountUrl('other'));
    });

    it('is audited, with who changed what', async () => {
      await setAccount('opay', { account_number: '5550001111' });
      const row = await t.trx('audit_log').where({ entity_type: 'pos_outlet_terminal_accounts', action: 'create' }).orderBy('id', 'desc').first();
      expect(row).toBeTruthy();
      await as(managerId).delete(accountUrl('opay'));
    });
  });

  describe('capturing the account on a terminal sale', () => {
    beforeAll(async () => {
      await setAccount('moniepoint', { account_number: '1010101010', account_label: 'Bar Moniepoint' });
      await setAccount('opay', { account_number: '2020202020' });
    });

    it("snapshots the outlet's account for the chosen provider", async () => {
      const row = await settleTerminal({ method: 'terminal', terminal_provider: 'moniepoint', terminal_reference: 'R1' });
      expect(row).toMatchObject({ terminal_provider: 'moniepoint', terminal_account_label: 'Bar Moniepoint', terminal_account_last4: '1010', payment_id: null });
    });

    it('leaves the label null when no provider is named, "other" is chosen, or no account is recorded', async () => {
      for (const settlement of [{ method: 'terminal' }, { method: 'terminal', terminal_provider: 'other' }, { method: 'terminal', terminal_provider: 'gtbank' }]) {
        const row = await settleTerminal(settlement);
        expect(row.terminal_account_label).toBeNull();
        expect(row.terminal_account_last4).toBeNull();
      }
    });

    it("snapshots an Other account's label and last 4, and nothing once it is removed", async () => {
      await setAccount('other', { account_number: '7070707070', account_label: 'Zenith POS — Zenith Bank' });
      const row = await settleTerminal({ method: 'terminal', terminal_provider: 'other' });
      expect(row).toMatchObject({ terminal_provider: 'other', terminal_account_label: 'Zenith POS — Zenith Bank', terminal_account_last4: '7070' });
      await as(managerId).delete(accountUrl('other'));
      const after = await settleTerminal({ method: 'terminal', terminal_provider: 'other' });
      expect(after.terminal_account_label).toBeNull();
      expect(await t.trx('pos_order_settlements').where({ id: row.id }).first()).toMatchObject({ terminal_account_label: 'Zenith POS — Zenith Bank' });
    });

    it('does not trust a client-supplied account', async () => {
      const row = await settleTerminal({ method: 'terminal', terminal_provider: 'gtbank', terminal_account_label: 'FORGED', terminal_account_last4: '9999' });
      expect(row.terminal_account_label).toBeNull();
      expect(row.terminal_account_last4).toBeNull();
    });

    it('never captures an account on a cash sale', async () => {
      const row = await settleTerminal({ method: 'cash' });
      expect(row.terminal_account_label).toBeNull();
      expect(row.terminal_account_last4).toBeNull();
    });

    it('keeps history when the setting is later edited or removed', async () => {
      const before = await settleTerminal({ method: 'terminal', terminal_provider: 'opay' });
      expect(before.terminal_account_last4).toBe('2020');
      await setAccount('opay', { account_number: '3030303030', account_label: 'New Opay' });
      const after = await settleTerminal({ method: 'terminal', terminal_provider: 'opay' });
      expect(after).toMatchObject({ terminal_account_last4: '3030', terminal_account_label: 'New Opay' });
      await as(managerId).delete(accountUrl('opay'));
      const reread = await t.trx('pos_order_settlements').where({ id: before.id }).first();
      expect(reread).toMatchObject({ terminal_account_last4: '2020', terminal_account_label: null });
    });
  });

  describe('reporting', () => {
    let report;
    const DATE = '2027-08-02';

    beforeAll(async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: DATE });
      await setAccount('moniepoint', { account_number: '1010101010', account_label: 'Bar Moniepoint' });
      await settleTerminal({ method: 'terminal', terminal_provider: 'moniepoint' });
      await settleTerminal({ method: 'terminal', terminal_provider: 'moniepoint' });
      await settleTerminal({ method: 'terminal', terminal_provider: 'gtbank' }); // no account recorded
      await setAccount('other', { account_number: '7070707070', account_label: 'Zenith POS — Zenith Bank' });
      await settleTerminal({ method: 'terminal', terminal_provider: 'other' });
      // Same provider, a changed account: its own row, never merged with the first.
      await setAccount('moniepoint', { account_number: '4040404040', account_label: 'Bar Moniepoint 2' });
      await settleTerminal({ method: 'terminal', terminal_provider: 'moniepoint' });
      const got = await as(managerId).get(`/api/v1/reconciliation/payments?date_from=${DATE}&date_to=${DATE}`);
      expect(got.status).toBe(200);
      report = got.body.data;
    });

    it('groups by outlet, provider and recorded account, keeping unlabelled sales apart', () => {
      const rows = report.byTerminalProvider;
      expect(rows.every((row) => row.outlet === 'Account Bar')).toBe(true);
      const find = (provider, last4) => rows.find((row) => row.provider === provider && row.accountLast4 === last4);
      expect(find('moniepoint', '1010')).toMatchObject({ count: 2, grossTotal: '46.00', accountLabel: 'Bar Moniepoint' });
      expect(find('moniepoint', '4040')).toMatchObject({ count: 1, grossTotal: '23.00', accountLabel: 'Bar Moniepoint 2' });
      expect(find('gtbank', null)).toMatchObject({ count: 1, accountLabel: null });
      expect(find('other', '7070')).toMatchObject({ count: 1, accountLabel: 'Zenith POS — Zenith Bank' });
      expect(rows.reduce((n, row) => n + row.count, 0)).toBe(5);
    });

    it('carries the account on terminal lines only, and in the CSV', async () => {
      const terminal = report.lines.filter((line) => line.method === 'terminal');
      expect(terminal.map((line) => line.terminalAccountLast4).sort()).toEqual(['1010', '1010', '4040', '7070', null]);
      const csv = (await as(managerId).get(`/api/v1/reconciliation/payments?date_from=${DATE}&date_to=${DATE}&format=csv`)).text;
      expect(csv.split('\n')[0]).toContain('terminalAccountLast4');
      expect(csv).toContain('Bar Moniepoint 2');
    });

    it('adds the account to terminal payments in the Sales report, and to nothing else', async () => {
      const res = await as(managerId).get(`/api/v1/pos/reports/sales?date_from=${DATE}&date_to=${DATE}`);
      const payments = res.body.data.tabs.flatMap((tab) => tab.payments).filter((p) => p.tender === 'terminal');
      expect(payments.map((p) => p.terminalAccountLast4).sort()).toEqual(['1010', '1010', '4040', '7070', null]);
    });
  });
});
