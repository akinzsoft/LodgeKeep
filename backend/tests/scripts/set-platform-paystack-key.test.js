'use strict';

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { encrypt, decrypt } = require('../../src/shared/encryption');
const { run, KEY_ENV } = require('../../scripts/set-platform-paystack-key');

const LIVE = 'sk_live_unit_test_0123456789abcdef';
const TEST_KEY = 'sk_test_unit_test_0123456789abcdef';
const ORIGINAL = 'sk_test_original_0123456789abcdef';

describe('scripts/set-platform-paystack-key', () => {
  const t = useTestApp();

  beforeAll(async () => {
    await seedTwoTenants(t.trx);
  });

  beforeEach(async () => {
    await t.trx('platform_payment_integrations').where({ currency: 'NGN' }).update({ provider: 'paystack', secret_key_encrypted: encrypt(ORIGINAL), is_active: true });
    await t.trx('platform_payment_integrations').where({ currency: 'GHS' }).delete();
    await t.trx('platform_payment_integrations').insert({ provider: 'paystack', country: 'GH', currency: 'GHS', secret_key_encrypted: encrypt('sk_test_ghana_key'), is_active: true });
  });

  async function exec(argv, env = {}) {
    const lines = [];
    const code = await run({ db: t.trx, env, argv, out: (l) => lines.push(l) });
    return { code, output: lines.join('\n') };
  }
  const stored = async (currency = 'NGN') => decrypt((await t.trx('platform_payment_integrations').where({ currency }).first()).secret_key_encrypted);

  it('rejects a key that is not sk_live_ and changes nothing', async () => {
    const { code, output } = await exec([], { [KEY_ENV]: TEST_KEY });
    expect(code).toBe(2);
    expect(output).toMatch(/not a live key/);
    expect(output).not.toContain(TEST_KEY);
    expect(await stored()).toBe(ORIGINAL);
  });

  it('rejects junk and an empty variable', async () => {
    expect((await exec([], { [KEY_ENV]: 'pk_live_public' })).code).toBe(2);
    expect((await exec([], {})).code).toBe(2);
    expect(await stored()).toBe(ORIGINAL);
  });

  it('accepts a test key only with --allow-test (rollback)', async () => {
    const { code, output } = await exec(['--allow-test'], { [KEY_ENV]: TEST_KEY });
    expect(code).toBe(0);
    expect(output).toBe('rows updated: 1');
    expect(await stored()).toBe(TEST_KEY);
  });

  it('writes exactly one row (NGN paystack), encrypted, and prints only the count', async () => {
    const { code, output } = await exec([], { [KEY_ENV]: LIVE });
    expect(code).toBe(0);
    expect(output).toBe('rows updated: 1');
    expect(await stored()).toBe(LIVE);
    expect(await stored('GHS')).toBe('sk_test_ghana_key'); // other currencies untouched
    const raw = (await t.trx('platform_payment_integrations').where({ currency: 'NGN' }).first()).secret_key_encrypted;
    expect(raw).not.toContain(LIVE);
  });

  it('--dry-run does everything except write', async () => {
    const { code, output } = await exec(['--dry-run'], { [KEY_ENV]: LIVE });
    expect(code).toBe(0);
    expect(output).toMatch(/would update 1 row/);
    expect(output).not.toContain(LIVE);
    expect(await stored()).toBe(ORIGINAL);
  });

  it('--dry-run still refuses a non-live key', async () => {
    expect((await exec(['--dry-run'], { [KEY_ENV]: TEST_KEY })).code).toBe(2);
  });

  it('rolls back and reports when the row does not exist exactly once', async () => {
    // Other tables reference the row, so make it not match instead of deleting it.
    await t.trx('platform_payment_integrations').where({ currency: 'NGN' }).update({ provider: 'not-paystack' });
    const { code, output } = await exec([], { [KEY_ENV]: LIVE });
    expect(code).toBe(1);
    expect(output).toMatch(/Rolled back/);
    expect(output).not.toContain(LIVE);
  });

  it('--check prints only true/false flags and never any key material', async () => {
    const test = await exec(['--check']);
    expect(test.code).toBe(0);
    expect(test.output).toBe(['active: true', 'live key: false', 'test key: true'].join('\n'));
    expect(test.output).not.toContain(ORIGINAL);
    expect(test.output).not.toContain('sk_');

    await exec([], { [KEY_ENV]: LIVE });
    const live = await exec(['--check']);
    expect(live.output).toBe(['active: true', 'live key: true', 'test key: false'].join('\n'));
    expect(live.output).not.toContain('live_');
    expect(live.output).not.toContain(LIVE.slice(8));
  });

  it('--check needs no new key and does not write', async () => {
    await exec(['--check'], { [KEY_ENV]: LIVE });
    expect(await stored()).toBe(ORIGINAL);
  });

  it('refuses a key passed as an argument (argv is visible in ps and shell history)', async () => {
    const { code, output } = await exec([`--key=${LIVE}`]);
    expect(code).toBe(2);
    expect(output).not.toContain(LIVE);
    expect(await stored()).toBe(ORIGINAL);
  });
});
