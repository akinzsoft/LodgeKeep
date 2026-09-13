'use strict';

/**
 * GET /api/v1/auth/me/permissions — the role-aware sidebar's data source.
 * The list must agree with what `requirePermission` actually enforces, so
 * several cases cross-check a real gated route alongside the listing.
 */
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants, seedPlatformUser } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('GET /api/v1/auth/me/permissions', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    ctx.platform = await seedPlatformUser(t.trx);
  });

  // Fixture grant plan: user 0 is manager at property 0 and front_desk at
  // property 1; user 1 is housekeeping at property 0.
  function staffToken({ tenant = ctx.a, user = 0, property = 0, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[user].id),
      tenant_id: String(tenant.id),
      property_id: propertyId === null ? null : String(propertyId ?? tenant.properties[property].id),
    });
  }

  function getPermissions(token) {
    return t.request.get('/api/v1/auth/me/permissions').set('Authorization', `Bearer ${token}`);
  }

  it("returns a manager's real grants at the active property — and nothing they don't hold", async () => {
    const res = await getPermissions(staffToken());
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('manager');
    expect(res.body.data.propertyId).toBe(String(ctx.a.properties[0].id));
    expect(res.body.data.permissions).toEqual(expect.arrayContaining(['setup.view', 'reservations.view', 'cashiering.void_line']));
    // Manager is view-only on Setup; Billing is admin/super_admin only.
    expect(res.body.data.permissions).not.toContain('setup.manage');
    expect(res.body.data.permissions).not.toContain('billing.view');
  });

  it("follows the role at the ACTIVE property — the same user is front_desk at their second property", async () => {
    const res = await getPermissions(staffToken({ property: 1 }));
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('front_desk');
    expect(res.body.data.permissions).toContain('cashiering.post_charge');
    expect(res.body.data.permissions).not.toContain('cashiering.void_line');
    expect(res.body.data.permissions).not.toContain('setup.view');
  });

  it('agrees with real enforcement: a key the list omits is genuinely refused, a key it includes is allowed', async () => {
    const housekeeping = staffToken({ user: 1 });
    const res = await getPermissions(housekeeping);
    expect(res.body.data.role).toBe('housekeeping');
    expect(res.body.data.permissions).toContain('housekeeping.view');
    expect(res.body.data.permissions).not.toContain('reservations.view');

    const refused = await t.request.get('/api/v1/guests').set('Authorization', `Bearer ${housekeeping}`);
    expect(refused.status).toBe(403);
    const allowed = await t.request.get('/api/v1/housekeeping/board').set('Authorization', `Bearer ${housekeeping}`);
    expect(allowed.status).not.toBe(403);
  });

  it('returns no role and no permissions when no property is active yet', async () => {
    const res = await getPermissions(staffToken({ propertyId: null }));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ propertyId: null, role: null, permissions: [] });
  });

  it('grants nothing through an archived role, even though the grant rows still exist', async () => {
    await t.trx('roles').where({ id: ctx.a.roles.housekeeping }).update({ status: 'archived' });
    try {
      const res = await getPermissions(staffToken({ user: 1 }));
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toEqual([]);
    } finally {
      await t.trx('roles').where({ id: ctx.a.roles.housekeeping }).update({ status: 'active' });
    }
  });

  it('returns the whole catalogue under platform impersonation, which the API lets every read through for', async () => {
    const start = await t.request
      .post(`/api/v1/platform/tenants/${ctx.a.id}/impersonate`)
      .set('Authorization', `Bearer ${signAccessToken({ aud: 'platform', sub: String(ctx.platform.id) })}`)
      .send({ property_id: ctx.a.properties[0].id, reason: 'Support ticket #42' });
    expect(start.status).toBe(201);

    const res = await getPermissions(start.body.data.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('platform_impersonation');
    const catalogue = (await t.trx('permissions').select('permission_key')).map((row) => row.permission_key).sort();
    expect(res.body.data.permissions).toEqual(catalogue);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await t.request.get('/api/v1/auth/me/permissions');
    expect(res.status).toBe(401);
  });

  it('rejects a guest token — this is a staff-only endpoint', async () => {
    const guestToken = signAccessToken({
      aud: 'guest',
      sub: String(ctx.a.guestAccounts[0].id),
      tenant_id: String(ctx.a.id),
      property_id: String(ctx.a.properties[0].id),
    });
    const res = await getPermissions(guestToken);
    expect(res.status).toBe(401);
  });
});
