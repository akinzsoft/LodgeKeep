'use strict';

/**
 * The admin verification-code (email MFA) requirement: `PUT /properties/:id/security`.
 * super_admin only (`security.manage`), a typed reason to turn it off, an audit row,
 * a bell alert to the OTHER admins, active property only, and platform TOTP untouched.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { hashPassword } = require('../../src/auth/password');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');

describe('admin verification-code requirement (security.manage)', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;

  const tokenFor = (tenant, userId, pid = propertyId) =>
    signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(pid) });

  async function setRole(tenant, userIndex, role, pid = tenant.properties[0].id) {
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: pid }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: pid, user_id: userId, role });
  }

  const put = (token, body, id = propertyId) =>
    t.request.put(`/api/v1/properties/${id}/security`).set('Authorization', `Bearer ${token}`).send(body);
  const flag = async () => Boolean((await t.trx('properties').where({ id: propertyId }).first()).mfa_required_for_admin_roles);
  const setFlag = (value) => t.trx('properties').where({ id: propertyId }).update({ mfa_required_for_admin_roles: value });

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await setRole(ctx.a, 0, 'super_admin');
    await setRole(ctx.a, 1, 'admin');
  });

  beforeEach(() => setFlag(true));

  const superToken = () => tokenFor(ctx.a, ctx.a.users[0].id);
  const adminToken = () => tokenFor(ctx.a, ctx.a.users[1].id);

  it('refuses admin and manager: only super_admin holds security.manage', async () => {
    const res = await put(adminToken(), { mfa_required_for_admin_roles: false, reason: 'nope' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    expect(await flag()).toBe(true);

    await setRole(ctx.a, 1, 'manager');
    const manager = await put(adminToken(), { mfa_required_for_admin_roles: false, reason: 'nope' });
    expect(manager.status).toBe(403);
    await setRole(ctx.a, 1, 'admin');
    expect(await flag()).toBe(true);
  });

  it('requires a typed reason to turn it off, and a boolean', async () => {
    for (const reason of [undefined, '', '   ']) {
      const res = await put(superToken(), { mfa_required_for_admin_roles: false, reason });
      expect(res.status).toBe(400);
    }
    expect((await put(superToken(), { reason: 'x' })).status).toBe(400);
    expect((await put(superToken(), { mfa_required_for_admin_roles: 'false', reason: 'x' })).status).toBe(400);
    expect(await flag()).toBe(true);
  });

  it('turns it off with a reason: audited with actor, before/after and reason', async () => {
    const res = await put(superToken(), { mfa_required_for_admin_roles: false, reason: '  Email outage until Friday ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mfaRequiredForAdminRoles: false, changed: true });
    expect(await flag()).toBe(false);

    const rows = await t.trx('audit_log').where({ entity_type: 'properties', entity_id: String(propertyId), action: 'mfa_requirement_disabled' });
    expect(rows).toHaveLength(1);
    expect(String(rows[0].user_id)).toBe(String(ctx.a.users[0].id));
    expect(rows[0].reason).toBe('Email outage until Friday');
    const before = typeof rows[0].before_state === 'string' ? JSON.parse(rows[0].before_state) : rows[0].before_state;
    const after = typeof rows[0].after_state === 'string' ? JSON.parse(rows[0].after_state) : rows[0].after_state;
    expect(before.mfa_required_for_admin_roles).toBe(true);
    expect(after.mfa_required_for_admin_roles).toBe(false);
  });

  it('turns it back on without a reason, audited as enabled', async () => {
    await setFlag(false);
    const res = await put(superToken(), { mfa_required_for_admin_roles: true });
    expect(res.status).toBe(200);
    expect(await flag()).toBe(true);
    const rows = await t.trx('audit_log').where({ entity_id: String(propertyId), action: 'mfa_requirement_enabled' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('an unchanged value writes no audit row and sends no alert', async () => {
    const auditBefore = await t.trx('audit_log').where({ entity_id: String(propertyId) }).whereIn('action', ['mfa_requirement_enabled', 'mfa_requirement_disabled']);
    const res = await put(superToken(), { mfa_required_for_admin_roles: true });
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
    const auditAfter = await t.trx('audit_log').where({ entity_id: String(propertyId) }).whereIn('action', ['mfa_requirement_enabled', 'mfa_requirement_disabled']);
    expect(auditAfter.length).toBe(auditBefore.length);
  });

  it('turning it off alerts the OTHER admins and super admins, never the actor, and turning it on alerts nobody', async () => {
    await t.trx('in_app_notifications').where({ type: 'security.mfa_requirement_disabled' }).delete();
    await put(superToken(), { mfa_required_for_admin_roles: false, reason: 'Lost the mailbox' });
    const alerts = await t.trx('in_app_notifications').where({ type: 'security.mfa_requirement_disabled' });
    const recipients = alerts.map((row) => String(row.user_id));
    expect(recipients).toContain(String(ctx.a.users[1].id)); // the admin
    expect(recipients).not.toContain(String(ctx.a.users[0].id)); // the actor
    const payload = typeof alerts[0].payload === 'string' ? JSON.parse(alerts[0].payload) : alerts[0].payload;
    expect(payload.reason).toBe('Lost the mailbox');

    const count = alerts.length;
    await put(superToken(), { mfa_required_for_admin_roles: true });
    expect(await t.trx('in_app_notifications').where({ type: 'security.mfa_requirement_disabled' })).toHaveLength(count);
  });

  it('GET reports the setting to anyone with setup.view, with canManage only for super_admin', async () => {
    const asSuper = await t.request.get(`/api/v1/properties/${propertyId}/security`).set('Authorization', `Bearer ${superToken()}`);
    expect(asSuper.body.data).toEqual({ mfaRequiredForAdminRoles: true, canManage: true });
    const asAdmin = await t.request.get(`/api/v1/properties/${propertyId}/security`).set('Authorization', `Bearer ${adminToken()}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.data.canManage).toBe(false);
  });

  it('only the ACTIVE property is reachable, and another tenant is 404', async () => {
    const other = ctx.a.properties[1].id;
    await setRole(ctx.a, 0, 'super_admin', other);
    const res = await put(superToken(), { mfa_required_for_admin_roles: false, reason: 'x' }, other);
    expect(res.status).toBe(404);
    expect(Boolean((await t.trx('properties').where({ id: other }).first()).mfa_required_for_admin_roles)).toBe(true);

    const cross = await put(superToken(), { mfa_required_for_admin_roles: false, reason: 'x' }, ctx.b.properties[0].id);
    expect(cross.status).toBe(404);
  });

  it('platform-staff MFA is untouched: platform login still demands TOTP with every property switched off', async () => {
    await flushRateLimitPrefixes(['auth-platform-login:ip:', 'auth-platform-login:acct:']);
    await put(superToken(), { mfa_required_for_admin_roles: false, reason: 'isolation check' });
    const password = 'a real platform password, not a fixture hash';
    const email = `ops-${Date.now()}@lodgekeep.test`;
    await t.trx('platform_users').insert({ email, password_hash: await hashPassword(password), first_name: 'T', last_name: 'O' });
    const res = await t.request.post('/api/v1/platform/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('mfa_enrollment_required');
    expect(res.body.data.accessToken).toBeUndefined();
  });
});
