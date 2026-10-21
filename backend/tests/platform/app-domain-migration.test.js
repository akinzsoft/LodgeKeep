'use strict';

/**
 * The 20261207090000 migration's backfill: every existing tenant gets the explicit TRIAL_APP_DOMAIN (the OLD domain)
 * whatever its status, nobody moves at deploy, and a missing TRIAL_APP_DOMAIN fails the migration before it changes anything.
 */

const { useTestApp } = require('../helpers/app');
const migration = require('../../migrations/20261207090000_tenant_app_domain_and_manual_subscriptions');

const PRODUCTION_STATUSES = [
  ['alpha-motel', 'active'],
  ['stical-hotel-suite', 'active'],
  ['isaac-hotel', 'suspended'],
  ['jigoe', 'trial'],
  ['riverside-hotel', 'trial'],
  ['vena-tech-ltd', 'trial'],
  ['revana-hotels-ltd', 'trial'],
];

describe('tenants.app_domain backfill', () => {
  const t = useTestApp();

  it('puts the old domain on every one of the seven production tenants, whatever the status', async () => {
    for (const [slug, status] of PRODUCTION_STATUSES) {
      await t.trx('tenants').insert({ name: slug, slug: `migtest-${slug}`, status, app_domain: null });
    }
    await migration.backfillAppDomain(t.trx, 'lodgekeep.planmsys.com');
    const rows = await t.trx('tenants').whereIn('slug', PRODUCTION_STATUSES.map(([slug]) => `migtest-${slug}`)).select('slug', 'status', 'app_domain');
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.app_domain).toBe('lodgekeep.planmsys.com');
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(['active', 'suspended', 'trial'])); // statuses untouched
  });
});

describe('TRIAL_APP_DOMAIN requirement', () => {
  const env = { APP_DOMAIN: 'lodgekeep.planmsys.com', ADDITIONAL_APP_DOMAINS: 'lodgekeep.ng' };

  it('fails loudly when it is unset or blank, instead of falling back to the primary', () => {
    expect(() => migration.requireTrialDomain(env)).toThrow(/TRIAL_APP_DOMAIN is not set/);
    expect(() => migration.requireTrialDomain({ ...env, TRIAL_APP_DOMAIN: '   ' })).toThrow(/TRIAL_APP_DOMAIN is not set/);
  });

  it('the migration stops before touching the database when it is unset', async () => {
    const saved = process.env.TRIAL_APP_DOMAIN;
    delete process.env.TRIAL_APP_DOMAIN;
    const untouched = new Proxy(() => { throw new Error('the database was used'); }, { get: () => { throw new Error('the database was used'); } });
    try {
      await expect(migration.up(untouched)).rejects.toThrow(/TRIAL_APP_DOMAIN is not set/);
    } finally {
      if (saved !== undefined) process.env.TRIAL_APP_DOMAIN = saved;
    }
  });

  it('rejects a domain the server does not accept, and accepts an accepted one', () => {
    expect(() => migration.requireTrialDomain({ ...env, TRIAL_APP_DOMAIN: 'elsewhere.example.com' })).toThrow(/not one of the accepted/);
    expect(migration.requireTrialDomain({ ...env, TRIAL_APP_DOMAIN: 'LODGEKEEP.planmsys.com' })).toBe('lodgekeep.planmsys.com');
  });
});
