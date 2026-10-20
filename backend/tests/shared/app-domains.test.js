'use strict';

/**
 * Two-domain support: one PRIMARY app domain plus any ADDITIONAL accepted ones.
 *   incoming  -> accepted on every domain, but only EXACTLY `{one label}.{domain}` (or the bare domain itself)
 *   outgoing  -> always https and always the primary
 * With nothing new set, everything is identical to the single APP_DOMAIN it always was.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');
const { signAccessToken } = require('../../src/auth/tokens');
const { scopedDb } = require('../../src/db');
const { contextFromSession } = require('../../src/modules/tenancy');
const { assertAllowedCallbackUrl } = require('../../src/shared/callback-url');
const { requireSameOrigin } = require('../../src/auth/same-origin-guard');
const { validateStartupConfig } = require('../../src/shared/startup-checks');
const { appDomains, normaliseDomain, matchTenantSubdomain, isBareAppDomain, tenantBaseUrl, AppDomainConfigError } = require('../../src/shared/app-domains');

const ENV_KEYS = ['APP_DOMAIN', 'PRIMARY_APP_DOMAIN', 'ADDITIONAL_APP_DOMAINS'];

describe('app domains', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const setEnv = (values) => {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
  };
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('the helper', () => {
    it('with only APP_DOMAIN set it is that single domain, exactly as before', () => {
      setEnv({ APP_DOMAIN: 'lodgekeep.planmsys.com' });
      expect(appDomains()).toEqual({ primary: 'lodgekeep.planmsys.com', additional: [], all: ['lodgekeep.planmsys.com'] });
    });

    it('PRIMARY_APP_DOMAIN wins over APP_DOMAIN; the old domain is accepted only when listed as additional', () => {
      setEnv({ APP_DOMAIN: 'lodgekeep.planmsys.com', PRIMARY_APP_DOMAIN: 'lodgekeep.ng' });
      expect(appDomains().all).toEqual(['lodgekeep.ng']);
      setEnv({ APP_DOMAIN: 'lodgekeep.planmsys.com', PRIMARY_APP_DOMAIN: 'lodgekeep.ng', ADDITIONAL_APP_DOMAINS: 'lodgekeep.planmsys.com' });
      expect(appDomains()).toEqual({ primary: 'lodgekeep.ng', additional: ['lodgekeep.planmsys.com'], all: ['lodgekeep.ng', 'lodgekeep.planmsys.com'] });
    });

    it('normalises: lowercases, trims, drops blanks and duplicates, and keeps the primary first', () => {
      setEnv({ APP_DOMAIN: ' LodgeKeep.Planmsys.com ', ADDITIONAL_APP_DOMAINS: ' LODGEKEEP.NG , ,lodgekeep.ng, lodgekeep.planmsys.com' });
      expect(appDomains().all).toEqual(['lodgekeep.planmsys.com', 'lodgekeep.ng']);
    });

    it('accepts a single-label dev domain such as localhost', () => {
      setEnv({ APP_DOMAIN: 'localhost' });
      expect(matchTenantSubdomain('alpha-hotels.localhost')).toBe('alpha-hotels');
    });

    it.each([
      ['a scheme', 'https://lodgekeep.ng'],
      ['a port', 'lodgekeep.ng:3000'],
      ['a wildcard', '*.lodgekeep.ng'],
      ['a path', 'lodgekeep.ng/app'],
      ['spaces', 'lodge keep.ng'],
      ['a leading dot', '.lodgekeep.ng'],
      ['a trailing dot', 'lodgekeep.ng.'],
      ['an empty label', 'lodgekeep..ng'],
      ['an underscore', 'lodge_keep.ng'],
      ['a leading hyphen', '-lodgekeep.ng'],
    ])('rejects %s instead of fixing it', (_name, bad) => {
      expect(() => normaliseDomain(bad)).toThrow(AppDomainConfigError);
      setEnv({ APP_DOMAIN: 'lodgekeep.planmsys.com', ADDITIONAL_APP_DOMAINS: bad });
      expect(() => appDomains()).toThrow(AppDomainConfigError);
    });

    it('refuses to start in production with a bad domain value (startup check)', () => {
      setEnv({ APP_DOMAIN: 'lodgekeep.planmsys.com', ADDITIONAL_APP_DOMAINS: '*.lodgekeep.ng' });
      expect(() => validateStartupConfig()).toThrow(/ADDITIONAL_APP_DOMAINS/);
    });
  });

  describe('exact matching (security)', () => {
    beforeEach(() => setEnv({ APP_DOMAIN: 'lodgekeep.planmsys.com', ADDITIONAL_APP_DOMAINS: 'lodgekeep.ng' }));

    it.each([
      ['alpha-motel.lodgekeep.planmsys.com', 'alpha-motel'],
      ['alpha-motel.lodgekeep.ng', 'alpha-motel'],
      ['ALPHA-MOTEL.LODGEKEEP.NG', 'alpha-motel'],
    ])('%s is the tenant %s', (host, slug) => {
      expect(matchTenantSubdomain(host)).toBe(slug);
    });

    it.each([
      ['the bare domain itself', 'lodgekeep.ng'],
      ['the other bare domain', 'lodgekeep.planmsys.com'],
      ['an attacker suffix after a real domain', 'x.lodgekeep.ng.evil.com'],
      ['the domain as a prefix of another host', 'lodgekeep.ng.evil.com'],
      ['a lookalike without the dot', 'evillodgekeep.ng'],
      ['a lookalike one label up', 'alpha-motel.evil-lodgekeep.ng'],
      ['a multi-label host', 'a.b.lodgekeep.ng'],
      ['a multi-label host on the primary', 'a.b.lodgekeep.planmsys.com'],
      ['an empty label', '.lodgekeep.ng'],
      ['an unrelated TLD', 'alpha-motel.lodgekeep.com'],
      ['a parent of an accepted domain', 'planmsys.com'],
      ['nothing', ''],
    ])('does not treat %s as a tenant host', (_name, host) => {
      expect(matchTenantSubdomain(host)).toBeNull();
    });

    it('treats only the exact bare domains as bare', () => {
      expect(isBareAppDomain('lodgekeep.ng')).toBe(true);
      expect(isBareAppDomain('LODGEKEEP.PLANMSYS.COM')).toBe(true);
      for (const host of ['alpha.lodgekeep.ng', 'lodgekeep.ng.evil.com', 'evillodgekeep.ng', 'ng', '']) expect(isBareAppDomain(host)).toBe(false);
    });
  });

  describe('outgoing links use the primary over https', () => {
    it('before the flip the primary is the old domain; after it the new one', () => {
      setEnv({ APP_DOMAIN: 'lodgekeep.planmsys.com', ADDITIONAL_APP_DOMAINS: 'lodgekeep.ng' });
      expect(tenantBaseUrl('alpha-motel')).toBe('https://alpha-motel.lodgekeep.planmsys.com');
      setEnv({ APP_DOMAIN: 'lodgekeep.planmsys.com', PRIMARY_APP_DOMAIN: 'lodgekeep.ng', ADDITIONAL_APP_DOMAINS: 'lodgekeep.planmsys.com' });
      expect(tenantBaseUrl('alpha-motel')).toBe('https://alpha-motel.lodgekeep.ng');
    });
  });
});

describe('two domains over HTTP', () => {
  const t = useTestApp();
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await flushRateLimitPrefixes(['ask-tls-rl:']);
  });

  beforeEach(() => {
    process.env.PRIMARY_APP_DOMAIN = 'lodgekeep.ng';
    process.env.ADDITIONAL_APP_DOMAINS = process.env.APP_DOMAIN;
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const ask = (domain) => t.request.get(`/internal/ask-tls?domain=${domain}`);

  describe('/internal/ask-tls', () => {
    it('allows every accepted bare domain', async () => {
      expect((await ask('lodgekeep.ng')).status).toBe(200);
      expect((await ask(process.env.APP_DOMAIN)).status).toBe(200);
      expect((await ask('LODGEKEEP.NG')).status).toBe(200);
    });

    it('allows a real tenant on either domain', async () => {
      expect((await ask(`${ctx.a.slug}.lodgekeep.ng`)).status).toBe(200);
      expect((await ask(`${ctx.a.slug}.${process.env.APP_DOMAIN}`)).status).toBe(200);
    });

    it('refuses an unknown tenant, lookalikes and multi-label hosts on the new domain', async () => {
      for (const host of ['no-such-tenant.lodgekeep.ng', `${ctx.a.slug}.lodgekeep.ng.evil.com`, 'lodgekeep.ng.evil.com', 'evillodgekeep.ng', `x.${ctx.a.slug}.lodgekeep.ng`, `${ctx.a.slug}.lodgekeep.com`]) {
        expect((await ask(host)).status).toBe(404);
      }
    });

    it('does not treat the new domain as accepted when it is not configured', async () => {
      delete process.env.PRIMARY_APP_DOMAIN;
      delete process.env.ADDITIONAL_APP_DOMAINS;
      expect((await ask('lodgekeep.ng')).status).toBe(404);
      expect((await ask(`${ctx.a.slug}.lodgekeep.ng`)).status).toBe(404);
    });
  });

  describe('tenant resolution from the Host header', () => {
    const login = (host) => t.request.post('/api/v1/auth/login').set('Host', host).send({ email: 'nobody@example.com', password: 'wrong-password-123' });

    it('resolves the tenant on both domains (a wrong password is a 401, not a 404)', async () => {
      expect((await login(`${ctx.a.slug}.lodgekeep.ng`)).status).toBe(401);
      expect((await login(`${ctx.a.slug}.${process.env.APP_DOMAIN}`)).status).toBe(401);
    });

    it('is 404 for a lookalike, a multi-label host, the bare domain and an unknown slug', async () => {
      for (const host of [`${ctx.a.slug}.lodgekeep.ng.evil.com`, `x.${ctx.a.slug}.lodgekeep.ng`, 'lodgekeep.ng', 'ghost-tenant.lodgekeep.ng', `${ctx.a.slug}.evil-lodgekeep.ng`]) {
        expect((await login(host)).status).toBe(404);
      }
    });
  });

  describe('callback URLs', () => {
    const dbFor = (tenant) => scopedDb().for(contextFromSession({ tenantId: tenant.id }));

    it("accepts the tenant's own subdomain on either domain, in any case", async () => {
      await expect(assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: `http://${ctx.a.slug}.lodgekeep.ng/pay/done` })).resolves.toBeUndefined();
      await expect(assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: `http://${ctx.a.slug.toUpperCase()}.${process.env.APP_DOMAIN}/pay/done` })).resolves.toBeUndefined();
    });

    it.each([
      ['another tenant on the new domain', (c) => `http://${c.b.slug}.lodgekeep.ng/x`],
      ['a lookalike suffix', (c) => `http://${c.a.slug}.lodgekeep.ng.evil.com/x`],
      ['a lookalike without the dot', (c) => `http://${c.a.slug}.evil-lodgekeep.ng/x`],
      ['a multi-label host', (c) => `http://x.${c.a.slug}.lodgekeep.ng/x`],
      ['the bare domain', () => 'http://lodgekeep.ng/x'],
      ['a userinfo trick', (c) => `http://${c.a.slug}.lodgekeep.ng@evil.example/x`],
    ])('rejects %s', async (_name, build) => {
      await expect(assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: build(ctx) })).rejects.toMatchObject({ code: 'VALIDATION_INVALID_CALLBACK_URL' });
    });
  });

  describe('sessions and CSRF', () => {
    it('the refresh cookie stays host-only, so it never travels between the two domains', async () => {
      const res = await t.request.post('/api/v1/auth/login').set('X-Tenant-Slug', ctx.a.slug).send({ email: ctx.a.users[0].email, password: 'not-the-password' });
      const header = String(res.headers['set-cookie'] ?? '');
      expect(header).not.toMatch(/domain=/i);
    });

    it('the same-origin guard compares with the request host, so it passes on the new domain and fails on a mismatch', () => {
      const run = (origin) => {
        let status = null;
        let passed = false;
        requireSameOrigin({ headers: { host: `${ctx.a.slug}.lodgekeep.ng`, origin } }, { status: (code) => ({ json: () => { status = code; } }) }, () => { passed = true; });
        return { status, passed };
      };
      expect(run(`https://${ctx.a.slug}.lodgekeep.ng`)).toEqual({ status: null, passed: true });
      expect(run(`https://${ctx.a.slug}.${process.env.APP_DOMAIN}`).status).toBe(403);
    });
  });

  describe('invitation links', () => {
    it('use the primary domain over https', async () => {
      await t.trx('user_property_access').where({ user_id: ctx.a.users[1].id, property_id: ctx.a.properties[0].id }).del();
      await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, user_id: ctx.a.users[1].id, role: 'admin' });
      const token = signAccessToken({ aud: 'staff', sub: String(ctx.a.users[1].id), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });
      const res = await t.request.post('/api/v1/users/invite').set('Authorization', `Bearer ${token}`).send({ email: `link-${Date.now()}@example.com`, role: 'front_desk' });
      expect(res.status).toBe(201);
      const event = await t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'staff.invited' }).orderBy('id', 'desc').first();
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      expect(payload.invitationUrl).toBe(`https://${ctx.a.slug}.lodgekeep.ng/?invite_token=${res.body.data.dev_only_token}`);
    });
  });
});
