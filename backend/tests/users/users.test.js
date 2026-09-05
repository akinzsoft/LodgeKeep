'use strict';

/**
 * HTTP-level tests for the user-management module — PLAN.md Phase 1 gap
 * closure, PRODUCT_REQUIREMENTS.md §3.19 ("User & staff setup: create
 * users, assign roles, deactivate leavers") and §3.16's invitation flow.
 *
 * Tokens are minted directly (`signAccessToken`), the same pattern
 * `tests/setup/setup.test.js` already uses.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('User management (PLAN.md Phase 1 gap closure)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  /** users[0] holds `manager` at properties[0] — setup.view only (fixtures.js's own grant plan). */
  function managerToken() {
    return signAccessToken({
      aud: 'staff',
      sub: String(ctx.a.users[0].id),
      tenant_id: String(ctx.a.id),
      property_id: String(ctx.a.properties[0].id),
    });
  }

  async function grantRoleToUser({ tenant, userIndex, propertyIndex, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  let adminGranted = false;
  async function adminToken() {
    if (!adminGranted) {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'admin' });
      adminGranted = true;
    }
    return signAccessToken({
      aud: 'staff',
      sub: String(ctx.a.users[1].id),
      tenant_id: String(ctx.a.id),
      property_id: String(ctx.a.properties[0].id),
    });
  }

  describe('listing', () => {
    it('lists every user holding access at the active property', async () => {
      const res = await t.request.get('/api/v1/users').set('Authorization', `Bearer ${managerToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((row) => row.email === 'sam@example.com')).toBe(true);
    });

    it('view-only role can list but not invite', async () => {
      const res = await t.request
        .post('/api/v1/users/invite')
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ email: 'should-fail@example.com', role: 'front_desk' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });
  });

  describe('invite → accept', () => {
    it('invites a user, exposes a dev-only token, and rejects an unknown role', async () => {
      const admin = await adminToken();
      const badRole = await t.request
        .post('/api/v1/users/invite')
        .set('Authorization', `Bearer ${admin}`)
        .send({ email: 'new-hire@example.com', role: 'not_a_real_role' });
      expect(badRole.status).toBe(400);
      expect(badRole.body.error.code).toBe('VALIDATION_ROLE_NOT_FOUND');

      const invite = await t.request
        .post('/api/v1/users/invite')
        .set('Authorization', `Bearer ${admin}`)
        .send({ email: 'new-hire@example.com', role: 'front_desk' });
      expect(invite.status).toBe(201);
      expect(invite.body.data.email).toBe('new-hire@example.com');
      expect(typeof invite.body.data.dev_only_token).toBe('string');

      const pending = await t.request.get('/api/v1/users/pending-invitations').set('Authorization', `Bearer ${admin}`);
      expect(pending.body.data.some((row) => row.email === 'new-hire@example.com' && row.status === 'pending')).toBe(true);
    });

    it('re-inviting the same address supersedes the earlier invitation rather than layering a second one', async () => {
      const admin = await adminToken();
      await t.request.post('/api/v1/users/invite').set('Authorization', `Bearer ${admin}`).send({
        email: 'twice-invited@example.com',
        role: 'front_desk',
      });
      const second = await t.request.post('/api/v1/users/invite').set('Authorization', `Bearer ${admin}`).send({
        email: 'twice-invited@example.com',
        role: 'cashier',
      });
      expect(second.status).toBe(201);

      const rows = await t.trx('user_invitations').where({ tenant_id: ctx.a.id, email: 'twice-invited@example.com' });
      expect(rows.length).toBe(1);
      expect(rows[0].role).toBe('cashier');
    });

    it('accepts an invitation, creating a real login-capable user with the invited role', async () => {
      const admin = await adminToken();
      const invite = await t.request.post('/api/v1/users/invite').set('Authorization', `Bearer ${admin}`).send({
        email: 'accepted-hire@example.com',
        role: 'front_desk',
      });
      const token = invite.body.data.dev_only_token;

      const accept = await t.request
        .post('/api/v1/auth/invitations/accept')
        .set('X-Tenant-Slug', ctx.a.slug)
        .send({ token, first_name: 'New', last_name: 'Hire', password: 'a brand new strong passphrase' });
      expect(accept.status).toBe(200);
      expect(accept.body.data.status).toBe('ok');

      const login = await t.request
        .post('/api/v1/auth/login')
        .set('X-Tenant-Slug', ctx.a.slug)
        .send({ email: 'accepted-hire@example.com', password: 'a brand new strong passphrase' });
      expect(login.status).toBe(200);
      expect(login.body.data.role).toBe('front_desk');
    });

    it('rejects re-using an already-accepted token with a real 401, not a silent replay', async () => {
      const admin = await adminToken();
      const invite = await t.request.post('/api/v1/users/invite').set('Authorization', `Bearer ${admin}`).send({
        email: 'single-use@example.com',
        role: 'cashier',
      });
      const token = invite.body.data.dev_only_token;
      const body = { token, first_name: 'A', last_name: 'B', password: 'a brand new strong passphrase' };

      const first = await t.request.post('/api/v1/auth/invitations/accept').set('X-Tenant-Slug', ctx.a.slug).send(body);
      expect(first.status).toBe(200);

      const second = await t.request.post('/api/v1/auth/invitations/accept').set('X-Tenant-Slug', ctx.a.slug).send(body);
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('rejects a garbage token', async () => {
      const res = await t.request
        .post('/api/v1/auth/invitations/accept')
        .set('X-Tenant-Slug', ctx.a.slug)
        .send({ token: 'not-a-real-token', first_name: 'A', last_name: 'B', password: 'a brand new strong passphrase' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('rejects accepting an invitation addressed to an email that already has a user', async () => {
      const admin = await adminToken();
      const invite = await t.request.post('/api/v1/users/invite').set('Authorization', `Bearer ${admin}`).send({
        email: 'sam@example.com', // already a seeded user in this tenant
        role: 'cashier',
      });
      const token = invite.body.data.dev_only_token;

      const accept = await t.request
        .post('/api/v1/auth/invitations/accept')
        .set('X-Tenant-Slug', ctx.a.slug)
        .send({ token, first_name: 'Sam', last_name: 'Duplicate', password: 'a brand new strong passphrase' });
      expect(accept.status).toBe(401);
      expect(accept.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });
  });

  describe('deactivate / change role', () => {
    it('deactivates a user, revoking their sessions and surviving the record', async () => {
      const admin = await adminToken();
      const invite = await t.request.post('/api/v1/users/invite').set('Authorization', `Bearer ${admin}`).send({
        email: 'to-deactivate@example.com',
        role: 'front_desk',
      });
      await t.request
        .post('/api/v1/auth/invitations/accept')
        .set('X-Tenant-Slug', ctx.a.slug)
        .send({
          token: invite.body.data.dev_only_token,
          first_name: 'To',
          last_name: 'Deactivate',
          password: 'a brand new strong passphrase',
        });
      const userId = (await t.trx('users').where({ tenant_id: ctx.a.id, email: 'to-deactivate@example.com' }).first('id')).id;
      await t.trx('sessions').insert({
        tenant_id: ctx.a.id,
        user_id: userId,
        refresh_token_hash: 'f'.repeat(64),
        expires_at: new Date(Date.now() + 3600 * 1000),
      });

      const deactivate = await t.request
        .post(`/api/v1/users/${userId}/deactivate`)
        .set('Authorization', `Bearer ${admin}`);
      expect(deactivate.status).toBe(200);
      expect(deactivate.body.data.status).toBe('inactive');

      const stillExists = await t.trx('users').where({ id: userId }).first();
      expect(stillExists).toBeDefined(); // never deleted

      const revoked = await t.trx('sessions').where({ user_id: userId }).first();
      expect(revoked.revoked_at).not.toBeNull();
    });

    it('reassigns the role held at the active property', async () => {
      const admin = await adminToken();
      const targetUserId = ctx.a.users[0].id; // sam@example.com, currently 'manager'

      const res = await t.request
        .patch(`/api/v1/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ role: 'front_desk' });
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('front_desk');

      // Restore, so later tests in this file (and any that run after) still
      // see users[0] as 'manager' per fixtures.js's own documented grant plan.
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'manager' });
    });

    it('404s deactivating an id with no access at the active property, never a silent no-op', async () => {
      const admin = await adminToken();
      const res = await t.request.post('/api/v1/users/999999999/deactivate').set('Authorization', `Bearer ${admin}`);
      expect(res.status).toBe(404);
    });
  });

  describe('cross-tenant isolation at the route level', () => {
    it("tenant A's admin cannot see or deactivate tenant B's user", async () => {
      const admin = await adminToken();
      const list = await t.request.get('/api/v1/users').set('Authorization', `Bearer ${admin}`);
      expect(list.body.data.some((row) => row.email === ctx.b.users[0].email && row.id === String(ctx.b.users[0].id))).toBe(false);

      const res = await t.request
        .post(`/api/v1/users/${ctx.b.users[0].id}/deactivate`)
        .set('Authorization', `Bearer ${admin}`);
      expect(res.status).toBe(404);
    });
  });
});
