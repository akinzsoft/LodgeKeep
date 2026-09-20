'use strict';

/**
 * `src/shared/callback-url.js` — security fix. `callback_url` used to
 * reach Paystack unvalidated at three call sites (cashiering, billing,
 * qr-ordering — see that file's own header, and
 * `tests/cashiering/cashiering.test.js`/`tests/billing/billing.test.js`
 * for the HTTP-level integration coverage), a classic open redirect. This
 * file exercises `assertAllowedCallbackUrl` directly against a real
 * scoped accessor and real `tenants`/`tenant_domains` rows, covering every
 * branch the shared call sites depend on.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { scopedDb } = require('../../src/db');
const { contextFromSession } = require('../../src/modules/tenancy');
const { assertAllowedCallbackUrl } = require('../../src/shared/callback-url');

describe('assertAllowedCallbackUrl', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  function dbFor(tenant) {
    return scopedDb().for(contextFromSession({ tenantId: tenant.id }));
  }

  it('does nothing for a missing/blank callback_url — every call site treats it as optional', async () => {
    await expect(assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: undefined })).resolves.toBeUndefined();
    await expect(assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: null })).resolves.toBeUndefined();
    await expect(assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: '' })).resolves.toBeUndefined();
  });

  it('rejects a malformed URL', async () => {
    await expect(assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: 'not a url' })).rejects.toMatchObject({
      code: 'VALIDATION_INVALID_CALLBACK_URL',
    });
  });

  it('rejects a non-http(s) protocol', async () => {
    await expect(assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: 'javascript:alert(1)' })).rejects.toMatchObject({
      code: 'VALIDATION_INVALID_CALLBACK_URL',
    });
  });

  it("accepts the tenant's own default {slug}.APP_DOMAIN subdomain", async () => {
    await expect(
      assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: `http://${ctx.a.slug}.${process.env.APP_DOMAIN}/pay/done` })
    ).resolves.toBeUndefined();
  });

  it('is case-insensitive on the hostname', async () => {
    await expect(
      assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: `http://${ctx.a.slug.toUpperCase()}.${process.env.APP_DOMAIN}/pay/done` })
    ).resolves.toBeUndefined();
  });

  it("rejects another tenant's subdomain — the actual open-redirect/cross-tenant-reference-leak scenario", async () => {
    await expect(
      assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: `http://${ctx.b.slug}.${process.env.APP_DOMAIN}/pay/done` })
    ).rejects.toMatchObject({ code: 'VALIDATION_INVALID_CALLBACK_URL' });
  });

  it('rejects an unrelated, attacker-controlled origin', async () => {
    await expect(assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: 'https://evil.example.com/steal' })).rejects.toMatchObject({
      code: 'VALIDATION_INVALID_CALLBACK_URL',
    });
  });

  it('accepts a domain the tenant has genuinely claimed AND had DNS-verified in tenant_domains', async () => {
    await t.trx('tenant_domains').insert({ tenant_id: ctx.a.id, domain: 'book.alpha-hotels-group.example', verified_at: new Date() });
    await expect(
      assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: 'https://book.alpha-hotels-group.example/confirm' })
    ).resolves.toBeUndefined();
  });

  // Re-review finding: an unverified claim used to be trusted, on the
  // (wrong, for this check) reasoning that tenant-resolution.js already
  // trusts one for Host-header resolution — see this file's own header
  // for why that reasoning doesn't transfer to a client-supplied body
  // field with no DNS-level gate. `tenant_domains.domain` accepts any
  // string; a tenant claiming a domain it doesn't actually control must
  // not be enough to legitimize it as a payment-redirect destination.
  it('rejects a domain the tenant has claimed but NOT yet had DNS-verified — a naked claim proves nothing', async () => {
    await t.trx('tenant_domains').insert({ tenant_id: ctx.a.id, domain: 'unverified.alpha-hotels-group.example', verified_at: null });
    await expect(
      assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: 'https://unverified.alpha-hotels-group.example/confirm' })
    ).rejects.toMatchObject({ code: 'VALIDATION_INVALID_CALLBACK_URL' });
  });

  it("rejects a domain claimed by a DIFFERENT tenant, even if verified — a claim never crosses tenant lines", async () => {
    await t.trx('tenant_domains').insert({ tenant_id: ctx.b.id, domain: 'book.beta-resorts-group.example', verified_at: new Date() });
    await expect(
      assertAllowedCallbackUrl(dbFor(ctx.a), { callbackUrl: 'https://book.beta-resorts-group.example/confirm' })
    ).rejects.toMatchObject({ code: 'VALIDATION_INVALID_CALLBACK_URL' });
  });
});
