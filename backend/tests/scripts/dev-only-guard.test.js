'use strict';

const { developmentOnlyProblems, assertDevelopmentOnly } = require('../../scripts/lib/dev-only-guard');

const DEV = { NODE_ENV: 'development', DB_NAME: 'lodgekeep_dev', DB_HOST: '127.0.0.1' };

describe('dev-only guard', () => {
  it('accepts a local development environment', () => {
    expect(developmentOnlyProblems(DEV)).toEqual([]);
    expect(() => assertDevelopmentOnly({ ...DEV, APP_DOMAIN: 'localhost', EMAIL_PROVIDER: 'console' })).not.toThrow();
  });

  it.each([
    ['production NODE_ENV', { NODE_ENV: 'production' }],
    ['another database name', { DB_NAME: 'lodgekeep_prod' }],
    ['a lookalike database name', { DB_NAME: 'lodgekeep_dev; drop' }],
    ['an unset database name', { DB_NAME: undefined }],
    ['a remote database host', { DB_HOST: 'mysql' }],
    ['a real app domain', { APP_DOMAIN: 'lodgekeep.planmsys.com' }],
    ['a real primary app domain', { PRIMARY_APP_DOMAIN: 'lodgekeep.ng' }],
    ['a real email provider', { EMAIL_PROVIDER: 'smtp' }],
    ['a live Paystack key', { PAYSTACK_SECRET_KEY: 'sk_live_abc' }],
  ])('refuses %s', (_label, override) => {
    expect(() => assertDevelopmentOnly({ ...DEV, ...override })).toThrow(/Refusing to run/);
  });

  it('allows a throwaway dev database with a suffix', () => {
    expect(developmentOnlyProblems({ ...DEV, DB_NAME: 'lodgekeep_dev_helpcheck' })).toEqual([]);
  });

  it('allows a test-mode Paystack key and a localhost subdomain', () => {
    expect(developmentOnlyProblems({ ...DEV, PAYSTACK_SECRET_KEY: 'sk_test_abc', APP_DOMAIN: 'app.localhost' })).toEqual([]);
  });
});
