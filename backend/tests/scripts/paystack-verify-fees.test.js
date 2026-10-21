'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { db } = require('../helpers/db');
const { encrypt } = require('../../src/shared/encryption');
const { run } = require('../../scripts/paystack-verify-fees');

const SCRIPT = path.join(__dirname, '../../scripts/paystack-verify-fees.js');
const STUB = path.join(__dirname, 'fixtures/stub-paystack-fetch.js');
const TEST_KEY = 'sk_test_verify_fees_0123456789abcdef';
const LIVE_KEY = 'sk_live_verify_fees_0123456789abcdef';

describe('scripts/paystack-verify-fees', () => {
  let original;

  beforeAll(async () => {
    original = await db()('platform_payment_integrations').where({ currency: 'NGN' }).first();
  });

  afterAll(async () => {
    if (original) await db()('platform_payment_integrations').where({ currency: 'NGN' }).update({ secret_key_encrypted: original.secret_key_encrypted, is_active: original.is_active });
  });

  async function storeKey(key) {
    await db()('platform_payment_integrations').where({ currency: 'NGN' }).update({ secret_key_encrypted: encrypt(key), is_active: true });
  }

  // Exactly how the container runs it: a fresh `node scripts/...` process against the database, nothing injected but env.
  function runLikeTheContainer(env = {}) {
    return spawnSync(process.execPath, ['--require', STUB, SCRIPT], {
      env: { ...process.env, NODE_ENV: 'test', ...env },
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  it('the real entry point reads the key from the database and prints the fees, never the key', async () => {
    await storeKey(TEST_KEY);
    const result = runLikeTheContainer({ REF: 'ref_1' });
    expect(result.stderr).not.toMatch(/is not a function|Failed/);
    expect(result.status).toBe(0);
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{\n')));
    expect(printed).toMatchObject({ reference: 'ref_1', amount: '10000.00', fees: '150.00', subaccount_code: 'ACCT_x' });
    expect(result.stdout + result.stderr).not.toContain(TEST_KEY);
  });

  it('the real entry point refuses a live key and prints no key', async () => {
    await storeKey(LIVE_KEY);
    const result = runLikeTheContainer({ REF: 'ref_1' });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/not a TEST key/);
    expect(result.stdout + result.stderr).not.toContain(LIVE_KEY);
  });

  it('the real entry point asks for REF', () => {
    const result = runLikeTheContainer({ REF: '' });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/Set REF/);
  });

  it('run() never calls Paystack with a live key', async () => {
    await storeKey(LIVE_KEY);
    const fetchFn = jest.fn();
    const lines = [];
    expect(await run({ db: db(), env: { REF: 'r' }, out: (l) => lines.push(l), fetchFn })).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
