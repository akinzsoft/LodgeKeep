'use strict';

/**
 * F-01 (product audit): change-role and deactivate had no rank check, so an `admin` could promote themselves
 * (or anyone) to `super_admin`, or deactivate the owner. The rule is now the one invite / resend / revoke use
 * (`roleOutranksOrEquals`), plus: no self change, the last active super_admin of the TENANT (counted across all its
 * properties) can never be demoted or deactivated, and a role change or deactivation ends the user's sessions.
 */

jest.mock('../../src/auth/breached-password', () => ({ isPasswordBreached: jest.fn().mockResolvedValue(false) }));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { workerContext } = require('../../src/modules/tenancy');
const usersService = require('../../src/modules/users/service');

describe('F-01: role rank on change-role and deactivate', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  const P0 = () => ctx.a.properties[0].id;
  const P1 = () => ctx.a.properties[1].id;
  const actor = () => ctx.a.users[1]; // ada
  const target = () => ctx.a.users[0]; // sam: manager at P0, front_desk at P1

  async function setRole(user, propertyId, role) {
    const row = await t.trx('user_property_access').where({ user_id: user.id, property_id: propertyId }).first('id');
    if (row) await t.trx('user_property_access').where({ id: row.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: user.id, role });
  }

  beforeEach(async () => {
    await t.trx('users').whereIn('id', [actor().id, target().id]).update({ status: 'active' });
    await t.trx('sessions').whereIn('user_id', [actor().id, target().id]).del();
    await t.trx('auth_events').where({ tenant_id: ctx.a.id, event_type: 'session_revoked' }).del();
    await setRole(target(), P0(), 'manager');
    await setRole(target(), P1(), 'front_desk');
    await setRole(actor(), P0(), 'housekeeping');
    await t.trx('user_property_access').where({ user_id: actor().id, property_id: P1() }).del();
  });

  async function tokenAs(role) {
    await setRole(actor(), P0(), role);
    return signAccessToken({ aud: 'staff', sub: String(actor().id), tenant_id: String(ctx.a.id), property_id: String(P0()) });
  }
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const changeRole = (token, id, role) => t.request.patch(`/api/v1/users/${id}/role`).set(auth(token)).send({ role });
  const deactivate = (token, id) => t.request.post(`/api/v1/users/${id}/deactivate`).set(auth(token)).send({});
  const roleOf = async (user, propertyId) => (await t.trx('user_property_access').where({ user_id: user.id, property_id: propertyId }).first('role')).role;
  const statusOf = async (user) => (await t.trx('users').where({ id: user.id }).first('status')).status;

  describe('rank', () => {
    it('an admin cannot promote another user to super_admin', async () => {
      const token = await tokenAs('admin');
      const res = await changeRole(token, target().id, 'super_admin');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE_ESCALATION');
      expect(await roleOf(target(), P0())).toBe('manager');
    });

    it('an admin cannot promote themselves to super_admin (the audited exploit)', async () => {
      const token = await tokenAs('admin');
      const res = await changeRole(token, actor().id, 'super_admin');
      expect(res.status).toBe(403);
      expect(await roleOf(actor(), P0())).toBe('admin');
    });

    it('an admin cannot change the role of a super_admin', async () => {
      await setRole(target(), P0(), 'super_admin');
      const token = await tokenAs('admin');
      const res = await changeRole(token, target().id, 'front_desk');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE_ESCALATION');
      expect(await roleOf(target(), P0())).toBe('super_admin');
    });

    it('an admin cannot deactivate a super_admin', async () => {
      await setRole(target(), P0(), 'super_admin');
      const token = await tokenAs('admin');
      const res = await deactivate(token, target().id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE_ESCALATION');
      expect(await statusOf(target())).toBe('active');
    });

    it('a user who is super_admin at ANOTHER property of the tenant also outranks an admin here', async () => {
      await setRole(target(), P1(), 'super_admin');
      const token = await tokenAs('admin');
      const res = await deactivate(token, target().id);
      expect(res.status).toBe(403);
      expect(await statusOf(target())).toBe('active');
    });

    it('an admin may still change a lower role and deactivate a lower-ranked user', async () => {
      const token = await tokenAs('admin');
      const changed = await changeRole(token, target().id, 'cashier');
      expect(changed.status).toBe(200);
      expect(await roleOf(target(), P0())).toBe('cashier');
      const gone = await deactivate(token, target().id);
      expect(gone.status).toBe(200);
      expect(await statusOf(target())).toBe('inactive');
    });

    it('a super_admin may change and deactivate an admin', async () => {
      await setRole(target(), P0(), 'admin');
      const token = await tokenAs('super_admin');
      expect((await changeRole(token, target().id, 'manager')).status).toBe(200);
      expect((await deactivate(token, target().id)).status).toBe(200);
    });
  });

  describe('self', () => {
    it('nobody can change their own role', async () => {
      const token = await tokenAs('super_admin');
      const res = await changeRole(token, actor().id, 'manager');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_SELF_ROLE_CHANGE');
      expect(await roleOf(actor(), P0())).toBe('super_admin');
    });

    it('nobody can deactivate themselves', async () => {
      const token = await tokenAs('super_admin');
      const res = await deactivate(token, actor().id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_SELF_DEACTIVATION');
      expect(await statusOf(actor())).toBe('active');
    });
  });

  describe('the last active super_admin of the tenant', () => {
    // The service is called directly with a stand-in actor: through HTTP the rank and self rules already stop the
    // ordinary routes to this state, so these tests pin the backstop itself (e.g. an actor deactivated mid-request).
    const callerCtx = () => workerContext({ tenantId: ctx.a.id, propertyId: P0() });
    const call = (fn, args) => fn({ context: callerCtx(), actorRole: 'super_admin', actorUserId: '999999999', ...args });

    it('cannot be demoted', async () => {
      await setRole(target(), P0(), 'super_admin');
      await expect(call(usersService.changeUserRole, { id: target().id, role: 'manager' })).rejects.toMatchObject({ code: 'FORBIDDEN_LAST_SUPER_ADMIN' });
      expect(await roleOf(target(), P0())).toBe('super_admin');
    });

    it('cannot be deactivated', async () => {
      await setRole(target(), P0(), 'super_admin');
      await expect(call(usersService.deactivateUser, { id: target().id })).rejects.toMatchObject({ code: 'FORBIDDEN_LAST_SUPER_ADMIN' });
      expect(await statusOf(target())).toBe('active');
    });

    it('counts across the tenant\'s properties: another active super_admin at a different property lets this one go', async () => {
      await setRole(target(), P0(), 'super_admin');
      await setRole(actor(), P1(), 'super_admin');
      await call(usersService.changeUserRole, { id: target().id, role: 'manager' });
      expect(await roleOf(target(), P0())).toBe('manager');
    });

    it('does not count an inactive super_admin', async () => {
      await setRole(target(), P0(), 'super_admin');
      await setRole(actor(), P1(), 'super_admin');
      await t.trx('users').where({ id: actor().id }).update({ status: 'inactive' });
      await expect(call(usersService.changeUserRole, { id: target().id, role: 'manager' })).rejects.toMatchObject({ code: 'FORBIDDEN_LAST_SUPER_ADMIN' });
    });

    it('a user who stays super_admin at another property is not "demoted" by losing the role here', async () => {
      await setRole(target(), P0(), 'super_admin');
      await setRole(target(), P1(), 'super_admin');
      await call(usersService.changeUserRole, { id: target().id, role: 'manager' });
      expect(await roleOf(target(), P0())).toBe('manager');
    });
  });

  describe('sessions and audit', () => {
    async function addSession(user, hash) {
      await t.trx('sessions').insert({ tenant_id: ctx.a.id, user_id: user.id, refresh_token_hash: hash.repeat(64).slice(0, 64), expires_at: new Date(Date.now() + 3600 * 1000) });
    }

    it('a role change revokes the target\'s sessions and records it', async () => {
      await addSession(target(), 'a');
      const token = await tokenAs('admin');
      expect((await changeRole(token, target().id, 'cashier')).status).toBe(200);
      const session = await t.trx('sessions').where({ user_id: target().id }).first();
      expect(session.revoked_at).not.toBeNull();
      expect(session.revoked_reason).toBe('admin_revoked');
      const event = await t.trx('auth_events').where({ tenant_id: ctx.a.id, user_id: target().id, event_type: 'session_revoked' }).first();
      expect(event).toBeDefined();
      const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'user_property_access', action: 'change_role' }).orderBy('id', 'desc').first();
      expect(audit).toBeDefined();
      expect(String(audit.user_id)).toBe(String(actor().id));
    });

    it('an unchanged role does not revoke sessions', async () => {
      await addSession(target(), 'b');
      const token = await tokenAs('admin');
      expect((await changeRole(token, target().id, 'manager')).status).toBe(200);
      const session = await t.trx('sessions').where({ user_id: target().id }).first();
      expect(session.revoked_at).toBeNull();
    });

    it('a refused change leaves the target\'s sessions alone', async () => {
      await addSession(target(), 'c');
      const token = await tokenAs('admin');
      expect((await changeRole(token, target().id, 'super_admin')).status).toBe(403);
      const session = await t.trx('sessions').where({ user_id: target().id }).first();
      expect(session.revoked_at).toBeNull();
    });

    it('deactivation revokes sessions and writes the deactivate audit row', async () => {
      await addSession(target(), 'd');
      const token = await tokenAs('admin');
      expect((await deactivate(token, target().id)).status).toBe(200);
      const session = await t.trx('sessions').where({ user_id: target().id }).first();
      expect(session.revoked_at).not.toBeNull();
      const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'users', action: 'deactivate' }).orderBy('id', 'desc').first();
      expect(String(audit.user_id)).toBe(String(actor().id));
    });
  });
});
