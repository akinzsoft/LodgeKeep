'use strict';

/**
 * `GET /internal/ask-tls` (`src/shared/tenant-domain-ask.js`) — Caddy's
 * on-demand-TLS `ask` check.
 *
 * Real deployment bug, found live against the VPS: the bare `APP_DOMAIN`
 * itself serves `/signup` and `/platform` (neither is tenant-resolved —
 * see `src/app.js`), but `resolveTenantRowForHostname` never matched it
 * (not a tenant subdomain, not a claimed custom domain), so the ask
 * endpoint 404'd it and Caddy refused a certificate for the site's own
 * bare domain. With an empty database that's a genuine chicken-and-egg:
 * no cert on APP_DOMAIN means `/signup` itself is unreachable, so no
 * tenant can ever be created to make APP_DOMAIN "resolve."
 *
 * This file deliberately does NOT seed any tenants (no `seedTwoTenants`
 * call) — the bare-domain case must hold with zero tenant rows in the
 * database, which is exactly the real production scenario this bug was
 * found in.
 */

const { useTestApp } = require('../helpers/app');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');

describe('GET /internal/ask-tls', () => {
  const t = useTestApp();

  beforeAll(() => flushRateLimitPrefixes(['ask-tls-rl:']));

  test('allows the bare APP_DOMAIN itself with zero tenants in the database', async () => {
    const res = await t.request.get(`/internal/ask-tls?domain=${process.env.APP_DOMAIN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'ok' });
  });

  test('is case-insensitive for the bare APP_DOMAIN', async () => {
    const res = await t.request.get(`/internal/ask-tls?domain=${process.env.APP_DOMAIN.toUpperCase()}`);

    expect(res.status).toBe(200);
  });

  test('refuses an unknown hostname that is not the bare domain and resolves to no tenant', async () => {
    const res = await t.request.get('/internal/ask-tls?domain=not-a-real-tenant.example.com');

    expect(res.status).toBe(404);
  });

  test('refuses a bare tenant subdomain suffix with no matching tenant', async () => {
    const res = await t.request.get(`/internal/ask-tls?domain=no-such-tenant.${process.env.APP_DOMAIN}`);

    expect(res.status).toBe(404);
  });

  test('refuses a missing domain parameter', async () => {
    const res = await t.request.get('/internal/ask-tls');

    expect(res.status).toBe(404);
  });
  // Tenant retention purge: a `purging`/`purged` tenant's subdomain must stop being
  // issued TLS certificates — `resolveTenantRowForHostname` is shared with request
  // resolution, so the two can never disagree.
  describe('a tenant being purged', () => {
    const { seedTwoTenants } = require('../helpers/fixtures');
    let ctx;

    beforeAll(async () => {
      ctx = await seedTwoTenants(t.trx);
    });

    afterEach(async () => {
      await t.trx('tenants').where({ id: ctx.a.id }).update({ status: 'active' });
    });

    test('an active tenant’s subdomain gets a certificate', async () => {
      const res = await t.request.get(`/internal/ask-tls?domain=${ctx.a.slug}.${process.env.APP_DOMAIN}`);
      expect(res.status).toBe(200);
    });

    test.each(['purging', 'purged'])('a %s tenant’s subdomain does not', async (status) => {
      await t.trx('tenants').where({ id: ctx.a.id }).update({ status });
      const res = await t.request.get(`/internal/ask-tls?domain=${ctx.a.slug}.${process.env.APP_DOMAIN}`);
      expect(res.status).toBe(404);
    });
  });
});
