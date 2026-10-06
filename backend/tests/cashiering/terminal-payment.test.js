'use strict';

/**
 * A room/folio payment taken on the hotel's own physical card terminal ("Card (terminal)"). Lodgekeep RECORDS it
 * like cash (no gateway; the terminal did the charge) with the terminal account snapshotted for reconciliation.
 * Covers: the property-level accounts (Setup), recording, refund staying local, reconciliation labelling it
 * `terminal` (not cash), the permission rule (cashier and above, never front desk), and that a cash payment is
 * untouched. The hotel golden-output suite (tests/payments) separately pins that existing output is byte-identical.
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
  return { ...actual, __mockAdapter: mockAdapter, resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })) };
});

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;

const BUSINESS_DATE = '2027-07-01';

describe('Card (terminal) payments on a folio', () => {
  const t = useTestApp();
  let ctx;
  let tokens;
  let counter = 0;
  const key = () => `term-${Date.now().toString(36)}-${(counter += 1)}`;

  async function userWithRole(role) {
    const [userId] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${role}-${Date.now().toString(36)}${(counter += 1)}@example.com`, first_name: role, last_name: 'User', password_hash: 'x', status: 'active' });
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, user_id: userId, role });
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });
  }

  const as = (who) => ({
    get: (url, query) => t.request.get(`/api/v1${url}`).query(query ?? {}).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url, body) => t.request.post(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`).set('Idempotency-Key', key()).send(body ?? {}),
    patch: (url, body) => t.request.patch(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body ?? {}),
    del: (url) => t.request.delete(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`),
  });

  let folioCounter = 0;
  async function folioWithBalance(amount) {
    folioCounter += 1;
    const [id] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      reservation_id: ctx.a.reservations[0].id,
      folio_number: `TP${String(folioCounter).padStart(6, '0')}`,
      status: 'open',
      balance: amount,
      currency: 'NGN',
      billed_to: 'Terminal Guest',
    });
    await t.trx('folio_line_items').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      folio_id: id,
      type: 'adjustment',
      description: 'Test balance',
      amount,
      currency: 'NGN',
      business_date: BUSINESS_DATE,
    });
    return id;
  }
  const balanceOf = async (folioId) => (await t.trx('folios').where({ id: folioId }).first('balance')).balance;

  async function account(overrides = {}) {
    const res = await as('admin').post('/cashiering/terminal-accounts', { provider: 'gtbank', account_number: `77${Date.now().toString().slice(-8)}${(counter += 1)}`.slice(0, 12), account_label: 'Front desk POS', ...overrides });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: BUSINESS_DATE });
    tokens = {
      cashier: await userWithRole('cashier'),
      front: await userWithRole('front_desk'),
      admin: await userWithRole('admin'),
      manager: await userWithRole('manager'),
    };
  });
  beforeEach(() => jest.clearAllMocks());

  describe('the hotel terminal accounts (Setup)', () => {
    it('lets an admin add, list, edit and remove; the payment form list shows the last 4 only', async () => {
      const created = await account({ account_number: '1234567890', bank_name: 'Zenith Bank', account_label: 'Lobby' });
      expect(created.account_number_last4).toBe('7890');
      const listed = await as('admin').get('/cashiering/terminal-accounts');
      expect(listed.body.data.some((a) => a.id === created.id)).toBe(true);
      const options = await as('cashier').get('/cashiering/terminal-account-options');
      expect(options.status).toBe(200);
      const option = options.body.data.find((a) => a.id === created.id);
      expect(option).toEqual({ id: created.id, name: 'Zenith Bank · Lobby', provider: 'gtbank', last4: '7890' });
      expect(JSON.stringify(options.body.data)).not.toContain('1234567890');
      const edited = await as('admin').patch(`/cashiering/terminal-accounts/${created.id}`, { provider: 'opay', account_number: '1234567890', account_label: 'Lobby 2' });
      expect(edited.status).toBe(200);
      expect((await as('admin').del(`/cashiering/terminal-accounts/${created.id}`)).status).toBe(200);
    });

    it('refuses a duplicate number, and managing accounts is admin only', async () => {
      const created = await account({ account_number: '5559990001' });
      const dup = await as('admin').post('/cashiering/terminal-accounts', { provider: 'gtbank', account_number: '5559990001' });
      expect(dup.status).toBe(409);
      for (const who of ['manager', 'cashier', 'front']) {
        expect((await as(who).post('/cashiering/terminal-accounts', { provider: 'gtbank', account_number: '5559990002' })).status).toBe(403);
      }
      expect((await as('manager').get('/cashiering/terminal-accounts')).status).toBe(403);
      await as('admin').del(`/cashiering/terminal-accounts/${created.id}`);
    });

    it('the picker is for cashier and above only (not front desk)', async () => {
      expect((await as('front').get('/cashiering/terminal-account-options')).status).toBe(403);
    });
  });

  describe('recording a payment', () => {
    it('records a CAPTURED terminal payment with a negative folio line and the account snapshot, no gateway call', async () => {
      const acct = await account({ account_number: '4000111122', bank_name: 'GTBank', account_label: 'Desk 1' });
      const folioId = await folioWithBalance('100.00');
      const res = await as('cashier').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '100.00', currency: 'NGN', account_id: acct.id, reference: 'RRN-123' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ provider: 'terminal', status: 'CAPTURED', terminal: { provider: 'gtbank', reference: 'RRN-123', account_label: 'GTBank · Desk 1', account_last4: '1122' } });
      const line = await t.trx('folio_line_items').where({ payment_id: res.body.data.id }).first();
      expect(line).toMatchObject({ type: 'payment', payment_method: 'terminal', amount: '-100.00' });
      expect(await balanceOf(folioId)).toBe('0.00');
      const payment = await t.trx('payments').where({ id: res.body.data.id }).first();
      expect(payment).toMatchObject({ provider: 'terminal', settlement_target: 'folio', provider_channel: null, subaccount_code: null });
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });

    it('needs no account or reference', async () => {
      const folioId = await folioWithBalance('20.00');
      const res = await as('manager').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '20.00', currency: 'NGN' });
      expect(res.status).toBe(201);
      expect(res.body.data.terminal).toEqual({ provider: null, reference: null, account_label: null, account_last4: null });
    });

    it('refuses an account that does not exist here, or an over-long reference, writing nothing', async () => {
      const folioId = await folioWithBalance('30.00');
      const before = Number((await t.trx('payments').where({ folio_id: folioId }).count({ n: '*' }).first()).n);
      const bad = await as('cashier').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '30.00', currency: 'NGN', account_id: 99999999 });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_INVALID_TERMINAL_ACCOUNT');
      const foreign = ctx.b.propertyTerminalAccounts[0].id;
      expect((await as('cashier').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '30.00', currency: 'NGN', account_id: foreign })).status).toBe(400);
      const long = await as('cashier').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '30.00', currency: 'NGN', reference: 'x'.repeat(61) });
      expect(long.status).toBe(400);
      expect(Number((await t.trx('payments').where({ folio_id: folioId }).count({ n: '*' }).first()).n)).toBe(before);
      expect(await balanceOf(folioId)).toBe('30.00');
    });

    it('is cashier and above only: front desk is refused, nothing written', async () => {
      const folioId = await folioWithBalance('40.00');
      const res = await as('front').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '40.00', currency: 'NGN' });
      expect(res.status).toBe(403);
      expect(await balanceOf(folioId)).toBe('40.00');
    });

    it('replays the same Idempotency-Key as one payment', async () => {
      const folioId = await folioWithBalance('15.00');
      const send = () => t.request.post(`/api/v1/cashiering/folios/${folioId}/payments/terminal`).set('Authorization', `Bearer ${tokens.cashier}`).set('Idempotency-Key', 'term-replay-1').send({ amount: '15.00', currency: 'NGN' });
      const first = await send();
      const second = await send();
      expect(first.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(Number((await t.trx('payments').where({ folio_id: folioId }).count({ n: '*' }).first()).n)).toBe(1);
    });

    it('does not rewrite a past payment when the account is later edited or removed', async () => {
      const acct = await account({ account_number: '4000333344', account_label: 'Old name' });
      const folioId = await folioWithBalance('10.00');
      const paid = await as('cashier').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '10.00', currency: 'NGN', account_id: acct.id });
      await as('admin').patch(`/cashiering/terminal-accounts/${acct.id}`, { provider: 'opay', account_number: '4000999999', account_label: 'New name' });
      await as('admin').del(`/cashiering/terminal-accounts/${acct.id}`);
      const details = await t.trx('payment_terminal_details').where({ payment_id: paid.body.data.id }).first();
      expect(details).toMatchObject({ terminal_account_label: 'Old name', terminal_account_last4: '3344' });
    });

    it('leaves cash recording exactly as it was (no terminal row, method cash)', async () => {
      const folioId = await folioWithBalance('12.00');
      const res = await as('cashier').post(`/cashiering/folios/${folioId}/payments/cash`, { amount: '12.00', currency: 'NGN' });
      expect(res.status).toBe(201);
      expect(await t.trx('payment_terminal_details').where({ payment_id: res.body.data.id }).first()).toBeUndefined();
      expect((await t.trx('folio_line_items').where({ payment_id: res.body.data.id }).first()).payment_method).toBe('cash');
    });
  });

  describe('refunding', () => {
    it('reverses locally with no gateway call, as a terminal-labelled refund, and copies the terminal details', async () => {
      const acct = await account({ account_number: '4000555566', account_label: 'Refund desk' });
      const folioId = await folioWithBalance('50.00');
      const paid = await as('cashier').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '50.00', currency: 'NGN', account_id: acct.id, reference: 'RRN-9' });
      const partial = await as('cashier').post(`/cashiering/payments/${paid.body.data.id}/refund`, { amount: '20.00', reason: 'Guest overcharged' });
      expect(partial.status).toBeLessThan(300);
      expect(paystack.refundTransaction).not.toHaveBeenCalled();
      expect(await balanceOf(folioId)).toBe('20.00');
      expect((await t.trx('payments').where({ id: paid.body.data.id }).first()).status).toBe('PARTIALLY_REFUNDED');
      const refundRow = await t.trx('payments').where({ parent_payment_id: paid.body.data.id }).first();
      expect(refundRow.provider).toBe('terminal');
      expect((await t.trx('folio_line_items').where({ payment_id: refundRow.id }).first())).toMatchObject({ type: 'refund', payment_method: 'terminal', amount: '20.00' });
      expect(await t.trx('payment_terminal_details').where({ payment_id: refundRow.id }).first()).toMatchObject({ terminal_reference: 'RRN-9', terminal_account_last4: '5566' });
      const rest = await as('cashier').post(`/cashiering/payments/${paid.body.data.id}/refund`, { reason: 'Rest back' });
      expect(rest.status).toBeLessThan(300);
      expect((await t.trx('payments').where({ id: paid.body.data.id }).first()).status).toBe('REFUNDED');
      expect(await balanceOf(folioId)).toBe('50.00');
    });

    it('still refuses more than was paid, and front desk cannot refund', async () => {
      const folioId = await folioWithBalance('10.00');
      const paid = await as('cashier').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '10.00', currency: 'NGN' });
      expect((await as('cashier').post(`/cashiering/payments/${paid.body.data.id}/refund`, { amount: '11.00', reason: 'x' })).status).toBe(422);
      expect((await as('front').post(`/cashiering/payments/${paid.body.data.id}/refund`, { amount: '1.00', reason: 'x' })).status).toBe(403);
    });
  });

  describe('reconciliation', () => {
    it('lists a terminal folio payment as `terminal` (not cash) with its account, net = gross, and groups it by provider and account', async () => {
      const acct = await account({ account_number: '4000777788', bank_name: 'Opay', account_label: 'Recon desk', provider: 'opay' });
      const folioId = await folioWithBalance('80.00');
      const paid = await as('cashier').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '80.00', currency: 'NGN', account_id: acct.id, reference: 'RRN-R' });
      const cashFolio = await folioWithBalance('5.00');
      const cash = await as('cashier').post(`/cashiering/folios/${cashFolio}/payments/cash`, { amount: '5.00', currency: 'NGN' });
      const report = await as('manager').get('/reconciliation/payments', { date_from: BUSINESS_DATE, date_to: BUSINESS_DATE });
      expect(report.status).toBe(200);
      const lines = report.body.data.lines;
      const terminalLine = lines.find((l) => l.paymentId === String(paid.body.data.id));
      expect(terminalLine).toMatchObject({ method: 'terminal', grossAmount: '80.00', feeAmount: '0.00', netAmount: '80.00', terminalProvider: 'opay', terminalReference: 'RRN-R', terminalAccountLabel: 'Opay · Recon desk', terminalAccountLast4: '7788', providerReference: null });
      const cashLine = lines.find((l) => l.paymentId === String(cash.body.data.id));
      expect(cashLine.method).toBe('cash');
      expect(Object.keys(cashLine)).not.toContain('terminalProvider');
      const group = report.body.data.byTerminalProvider.find((g) => g.accountLast4 === '7788');
      expect(group).toMatchObject({ provider: 'opay', accountLabel: 'Opay · Recon desk', count: 1, grossTotal: '80.00' });
    });

    it('lists the terminal refund as a terminal refund line', async () => {
      const folioId = await folioWithBalance('25.00');
      const paid = await as('cashier').post(`/cashiering/folios/${folioId}/payments/terminal`, { amount: '25.00', currency: 'NGN', reference: 'RRN-RF' });
      const refund = await as('cashier').post(`/cashiering/payments/${paid.body.data.id}/refund`, { reason: 'Reversal' });
      const report = await as('manager').get('/reconciliation/payments', { date_from: BUSINESS_DATE, date_to: BUSINESS_DATE });
      const line = report.body.data.lines.find((l) => l.paymentId === String(refund.body.data.id));
      expect(line).toMatchObject({ method: 'terminal', isRefund: true, grossAmount: '-25.00', terminalReference: 'RRN-RF' });
    });
  });
});
