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
    patch: (url) => t.request.patch(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    delete: (url) => t.request.delete(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
  });
  const idemKey = () => `acct-${(counter += 1)}`;
  const listUrl = (outletId = outlet.outletId) => `/api/v1/pos/outlets/${outletId}/terminal-accounts`;
  const optionsUrl = (outletId = outlet.outletId) => `/api/v1/pos/outlets/${outletId}/terminal-account-options`;
  let adminId;
  // Adds an account (admin by default) and returns its id; tests clean up through removeAccount.
  async function addAccount(body, userId = adminId) {
    const res = await as(userId).post(listUrl()).send(body);
    expect(res.status).toBe(201);
    return res.body.data.id;
  }
  const removeAccount = (id) => as(adminId).delete(`${listUrl()}/${id}`);

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
    [adminId] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `admin-${Date.now().toString(36)}@example.com`, first_name: 'Ada', last_name: 'Min', password_hash: ctx.a.users[0].passwordHash ?? 'x', status: 'active' });
    await setRole(adminId, 'admin');
    await setRole(managerId, 'manager');
    await setRole(operatorId, 'pos_operator');
    const suffix = Date.now().toString(36).slice(-6);
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `TA-${suffix}`, name: 'Account Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `TA-T-${suffix}` });
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Account Beer', category: 'Drinks', price: '20.00' });
    outlet = { outletId, terminalId, menuItemId };
  });

  describe('managing the list', () => {
    it('is setup.manage only: operators and outlet managers can neither read nor change it', async () => {
      for (const userId of [operatorId, managerId]) {
        expect((await as(userId).get(listUrl())).status).toBe(403);
        expect((await as(userId).post(listUrl()).send({ account_number: '0123456789', account_label: 'X' })).status).toBe(403);
        expect((await as(userId).patch(`${listUrl()}/1`).send({ account_number: '0123456789', account_label: 'X' })).status).toBe(403);
        expect((await as(userId).delete(`${listUrl()}/1`)).status).toBe(403);
      }
    });

    it('records several accounts per outlet, including two for one provider and one with no provider', async () => {
      const a = await addAccount({ provider: 'gtbank', account_number: '0123 456 789', account_label: ' Bar GTB ' });
      const b = await addAccount({ provider: 'gtbank', account_number: '0222233334', account_label: 'Bar GTB 2' });
      const c = await addAccount({ account_number: '5550001111', bank_name: 'Some New Microfinance Bank' });
      const listed = (await as(adminId).get(listUrl())).body.data;
      expect(listed.map((r) => r.id)).toEqual([a, b, c]);
      expect(listed[0]).toMatchObject({ provider: 'gtbank', account_number: '0123456789', account_number_last4: '6789', account_label: 'Bar GTB' });
      expect(listed[2]).toMatchObject({ provider: null, bank_name: 'Some New Microfinance Bank' });
      for (const id of [a, b, c]) await removeAccount(id);
    });

    it('edits in place by id, and removes; a missing id is 404', async () => {
      const id = await addAccount({ provider: 'opay', account_number: '0123456789' });
      const edited = await as(adminId).patch(`${listUrl()}/${id}`).send({ provider: 'opay', account_number: '0333344445', bank_name: 'Zenith Bank' });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ id, account_number_last4: '4445', bank_name: 'Zenith Bank' });
      expect((await removeAccount(id)).status).toBe(200);
      expect((await removeAccount(id)).status).toBe(404);
      expect((await as(adminId).patch(`${listUrl()}/${id}`).send({ account_number: '0333344445', bank_name: 'X' })).status).toBe(404);
    });

    it('refuses the same account number twice for one outlet (spacing ignored), but allows it at another outlet', async () => {
      const id = await addAccount({ provider: 'opay', account_number: '0123456789' });
      const dup = await as(adminId).post(listUrl()).send({ provider: 'gtbank', account_number: '0123 4567 89' });
      expect(dup.status).toBe(409);
      const other = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `TB-${Date.now().toString(36).slice(-6)}`, name: 'Second Bar', type: 'bar' });
      expect((await as(adminId).post(listUrl(other[0])).send({ provider: 'opay', account_number: '0123456789' })).status).toBe(201);
      await removeAccount(id);
    });

    it('rejects unknown providers, bad numbers, long text, and an account with no name at all, writing nothing', async () => {
      const bad = [
        { account_number: '0123456789' }, // nothing names it
        { provider: 'other', account_number: '0123456789', account_label: '   ' },
        { provider: 'zenith', account_number: '0123456789', account_label: 'x' },
        { provider: 'opay', account_number: 'abc' },
        { provider: 'opay', account_number: '12' },
        { provider: 'opay' },
        { provider: 'opay', account_number: '0123456789', account_label: 'x'.repeat(81) },
        { provider: 'opay', account_number: '0123456789', bank_name: 'x'.repeat(81) },
      ];
      for (const body of bad) expect((await as(adminId).post(listUrl()).send(body)).status).toBe(400);
      expect(await t.trx('pos_outlet_terminal_accounts').where({ outlet_id: outlet.outletId })).toEqual([]);
    });

    it("cannot reach another tenant's outlet or account", async () => {
      const foreign = ctx.b.posOutlets[0].id;
      expect((await as(adminId).post(listUrl(foreign)).send({ provider: 'opay', account_number: '0123456789' })).status).toBe(400);
      expect((await as(adminId).get(listUrl(foreign))).status).toBe(400);
      const foreignAccount = ctx.b.posOutletTerminalAccounts[0].id;
      expect((await as(adminId).delete(`${listUrl(foreign)}/${foreignAccount}`)).status).toBe(404);
      expect((await as(adminId).delete(`${listUrl()}/${foreignAccount}`)).status).toBe(404);
    });

    it('is audited, with who changed what', async () => {
      const id = await addAccount({ provider: 'opay', account_number: '5550001111' });
      const row = await t.trx('audit_log').where({ entity_type: 'pos_outlet_terminal_accounts', action: 'create', entity_id: id }).first();
      expect(row).toBeTruthy();
      await removeAccount(id);
    });
  });

  describe('what the Register may see', () => {
    it('shows an operator id, name and last 4 only — never the full number — and nothing is writable', async () => {
      const id = await addAccount({ provider: 'gtbank', account_number: '0123456789', account_label: 'Bar GTB', bank_name: 'GTBank' });
      const res = await as(operatorId).get(optionsUrl());
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id, name: 'GTBank · Bar GTB', provider: 'gtbank', last4: '6789' }]);
      expect(JSON.stringify(res.body)).not.toContain('0123456789');
      await removeAccount(id);
    });

    it("limits an assigned operator to their own outlets (another outlet's list is a 404)", async () => {
      const [otherOutlet] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `TC-${Date.now().toString(36).slice(-6)}`, name: 'Elsewhere', type: 'bar' });
      await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: operatorId, outlet_id: otherOutlet });
      expect((await as(operatorId).get(optionsUrl())).status).toBe(404);
      expect((await as(operatorId).get(optionsUrl(otherOutlet))).status).toBe(200);
      await t.trx('user_outlet_assignments').where({ user_id: operatorId }).delete();
    });
  });

  describe('capturing the account on a terminal sale', () => {
    let gtb;
    let opay;
    let namedOnly;
    beforeAll(async () => {
      gtb = await addAccount({ provider: 'gtbank', account_number: '1010101010', account_label: 'Bar GTB', bank_name: 'GTBank' });
      opay = await addAccount({ provider: 'opay', account_number: '2020202020' });
      namedOnly = await addAccount({ provider: 'other', account_number: '7070707070', account_label: 'ZENITH BANK' });
    });

    afterAll(async () => {
      for (const id of [gtb, namedOnly]) await removeAccount(id);
    });

    it("snapshots the chosen account's name and last 4, and reports its provider", async () => {
      const row = await settleTerminal({ method: 'terminal', terminal_account_id: gtb, terminal_reference: 'R1' });
      expect(row).toMatchObject({ terminal_provider: 'gtbank', terminal_account_label: 'GTBank · Bar GTB', terminal_account_last4: '1010', payment_id: null });
    });

    it('surfaces a provider=other account named only by its label (the production shape) as a normal account', async () => {
      const row = await settleTerminal({ method: 'terminal', terminal_account_id: namedOnly });
      expect(row).toMatchObject({ terminal_provider: 'other', terminal_account_label: 'ZENITH BANK', terminal_account_last4: '7070' });
      const options = (await as(operatorId).get(optionsUrl())).body.data;
      expect(options.find((o) => o.id === namedOnly)).toMatchObject({ name: 'ZENITH BANK', last4: '7070' });
    });

    it('leaves both null when no account is picked, and a cash sale never captures one', async () => {
      for (const settlement of [{ method: 'terminal' }, { method: 'cash', terminal_account_id: gtb }]) {
        const row = await settleTerminal(settlement);
        expect(row.terminal_account_label).toBeNull();
        expect(row.terminal_account_last4).toBeNull();
      }
    });

    it("refuses an account that is not this outlet's (another outlet's or another tenant's), leaving the tab open", async () => {
      const foreign = ctx.b.posOutletTerminalAccounts[0].id;
      const [sibling] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `TD-${Date.now().toString(36).slice(-6)}`, name: 'Sibling Bar', type: 'bar' });
      const siblingAccount = (await as(adminId).post(listUrl(sibling)).send({ provider: 'opay', account_number: '8080808080' })).body.data.id;
      const opened = await as(operatorId).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: 'Z1' });
      const orderId = opened.body.data.id;
      await as(operatorId).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: outlet.menuItemId, quantity: 1 });
      const res = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', idemKey()).send({ settlements: [{ method: 'terminal', terminal_account_id: foreign }] });
      expect(res.status).toBe(400);
      const sameTenant = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', idemKey()).send({ settlements: [{ method: 'terminal', terminal_account_id: siblingAccount }] });
      expect(sameTenant.status).toBe(400);
      expect((await t.trx('pos_orders').where({ id: orderId }).first()).status).toBe('open');
    });

    it('does not trust a client-supplied label or last 4', async () => {
      const row = await settleTerminal({ method: 'terminal', terminal_account_label: 'FORGED', terminal_account_last4: '9999' });
      expect(row.terminal_account_label).toBeNull();
      expect(row.terminal_account_last4).toBeNull();
    });

    it('keeps history exactly as recorded when the account is later edited or REMOVED', async () => {
      const before = await settleTerminal({ method: 'terminal', terminal_account_id: opay });
      expect(before).toMatchObject({ terminal_account_last4: '2020', terminal_provider: 'opay' });
      const snapshot = { label: before.terminal_account_label, last4: before.terminal_account_last4, provider: before.terminal_provider };

      // Edited: the next sale sees the new details, the old one is unchanged.
      await as(adminId).patch(`${listUrl()}/${opay}`).send({ provider: 'opay', account_number: '3030303030', account_label: 'New Opay' });
      const after = await settleTerminal({ method: 'terminal', terminal_account_id: opay });
      expect(after).toMatchObject({ terminal_account_last4: '3030', terminal_account_label: 'New Opay' });
      // Removed: the old sales do not break, blank out or lose their snapshot.
      expect((await removeAccount(opay)).status).toBe(200);
      for (const [row, want] of [[before, snapshot], [after, { label: 'New Opay', last4: '3030', provider: 'opay' }]]) {
        const reread = await t.trx('pos_order_settlements').where({ id: row.id }).first();
        expect({ label: reread.terminal_account_label, last4: reread.terminal_account_last4, provider: reread.terminal_provider }).toEqual(want);
      }
      const rec = await as(managerId).get(`/api/v1/reconciliation/payments?date_from=2027-08-01&date_to=2027-08-01`);
      expect(rec.status).toBe(200);
      expect(rec.body.data.lines.some((l) => l.terminalAccountLast4 === '2020')).toBe(true);
    });
  });

  describe('reporting', () => {
    let report;
    const DATE = '2027-08-02';

    beforeAll(async () => {
      await t.trx('properties').where({ id: propertyId }).update({ current_business_date: DATE });
      const first = await addAccount({ provider: 'moniepoint', account_number: '1010101010', account_label: 'Bar Moniepoint' });
      await settleTerminal({ method: 'terminal', terminal_account_id: first });
      await settleTerminal({ method: 'terminal', terminal_account_id: first });
      await settleTerminal({ method: 'terminal', terminal_provider: 'gtbank' }); // no account picked
      const other = await addAccount({ provider: 'other', account_number: '7070707070', account_label: 'Zenith POS — Zenith Bank' });
      await settleTerminal({ method: 'terminal', terminal_account_id: other });
      // Same provider, a second account: its own row, never merged with the first.
      const second = await addAccount({ provider: 'moniepoint', account_number: '4040404040', account_label: 'Bar Moniepoint 2' });
      await settleTerminal({ method: 'terminal', terminal_account_id: second });
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
