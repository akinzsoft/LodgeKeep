'use strict';

/**
 * GET /auth/branding — the sign-in page's hotel name and logo, public
 * (user-requested: show the hotel's own logo on its login page). Returns
 * the tenant's name and the logo of its first active property that has one;
 * nothing else about the tenant.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');

describe('GET /auth/branding', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  const branding = (slug) => t.request.get('/api/v1/auth/branding').set('X-Tenant-Slug', slug);

  it("returns the tenant's name and no logo when no property has one — without signing in", async () => {
    await t.trx('properties').where({ tenant_id: ctx.a.id }).update({ logo_url: null });
    const res = await branding(ctx.a.slug);
    expect(res.status).toBe(200);
    const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first('name');
    expect(res.body.data).toEqual({ tenantName: tenant.name, logoUrl: null });
  });

  it("uses the first active property's logo, skipping archived properties", async () => {
    const [first, second] = ctx.a.properties;
    await t.trx('properties').where({ id: first.id }).update({ logo_url: '/api/v1/media/property-logos/first.png', status: 'archived' });
    await t.trx('properties').where({ id: second.id }).update({ logo_url: '/api/v1/media/property-logos/second.png' });
    const res = await branding(ctx.a.slug);
    expect(res.body.data.logoUrl).toBe('/api/v1/media/property-logos/second.png');
    await t.trx('properties').where({ id: first.id }).update({ status: 'active' });
    expect((await branding(ctx.a.slug)).body.data.logoUrl).toBe('/api/v1/media/property-logos/first.png');
  });

  it("never returns another tenant's logo", async () => {
    await t.trx('properties').where({ tenant_id: ctx.b.id }).update({ logo_url: null });
    const res = await branding(ctx.b.slug);
    expect(res.body.data.logoUrl).toBeNull();
  });

  it('is a 404 for an address that is no tenant, like every tenant-resolved route', async () => {
    expect((await branding('no-such-hotel-anywhere')).status).toBe(404);
  });
});
