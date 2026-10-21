'use strict';

const { buildAdapter } = require('../../src/modules/cashiering/paystack-adapter');
const { feeBearer, logFeeBearer } = require('../../src/shared/paystack-fee-bearer');
const { validateStartupConfig } = require('../../src/shared/startup-checks');

describe('Paystack fee bearer (PAYSTACK_FEE_BEARER)', () => {
  const realFetch = global.fetch;
  const original = process.env.PAYSTACK_FEE_BEARER;

  afterEach(() => {
    global.fetch = realFetch;
    if (original === undefined) delete process.env.PAYSTACK_FEE_BEARER;
    else process.env.PAYSTACK_FEE_BEARER = original;
  });

  async function initializeBody(args) {
    let body;
    global.fetch = jest.fn(async (url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ status: true, data: { authorization_url: 'https://x', access_code: 'a', reference: 'r' } }) };
    });
    await buildAdapter('sk_test_x').initializeTransaction({ email: 'a@b.co', amount: '10.00', currency: 'NGN', reference: 'r', ...args });
    return body;
  }

  it('defaults to subaccount when unset or blank', () => {
    delete process.env.PAYSTACK_FEE_BEARER;
    expect(feeBearer()).toBe('subaccount');
    process.env.PAYSTACK_FEE_BEARER = '  ';
    expect(feeBearer()).toBe('subaccount');
  });

  it('sends bearer=subaccount by default when a subaccount is attached, and never transaction_charge', async () => {
    delete process.env.PAYSTACK_FEE_BEARER;
    const body = await initializeBody({ subaccount: 'ACCT_1' });
    expect(body.subaccount).toBe('ACCT_1');
    expect(body.bearer).toBe('subaccount');
    expect(body).not.toHaveProperty('transaction_charge');
  });

  it('sends bearer=account when configured', async () => {
    process.env.PAYSTACK_FEE_BEARER = 'account';
    expect((await initializeBody({ subaccount: 'ACCT_1' })).bearer).toBe('account');
  });

  it('sends no bearer when there is no subaccount', async () => {
    delete process.env.PAYSTACK_FEE_BEARER;
    const body = await initializeBody({});
    expect(body).not.toHaveProperty('bearer');
    expect(body).not.toHaveProperty('subaccount');
  });

  it('rejects an unknown value, at the helper and at startup', () => {
    process.env.PAYSTACK_FEE_BEARER = 'customer';
    expect(() => feeBearer()).toThrow(/PAYSTACK_FEE_BEARER/);
    expect(() => validateStartupConfig()).toThrow(/PAYSTACK_FEE_BEARER/);
  });

  it('logs the effective value at boot', () => {
    const log = jest.fn();
    expect(logFeeBearer({ PAYSTACK_FEE_BEARER: 'account' }, log)).toMatch(/account/);
    expect(logFeeBearer({}, log)).toMatch(/subaccount/);
  });
});
