'use strict';

/**
 * Pending invitations: Resend and Delete (revoke), the role-escalation rule on
 * invite / resend / revoke, and what happens to the delivery-log Resend once an
 * invitation has been replaced, revoked or accepted (a dead link must never be
 * re-emailed).
 */

jest.mock('../../src/auth/breached-password', () => ({ isPasswordBreached: jest.fn().mockResolvedValue(false) }));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { workerContext } = require('../../src/modules/tenancy');
const { dispatchPendingOutboxEventsForTenant } = require('../../src/modules/notifications/service');
const { consoleAdapter } = require('../../src/modules/notifications/email-adapter');
const { rateLimitRedisConnection } = require('../../src/shared/rate-limit-redis-connection');

describe('Pending invitations: resend and revoke', () => {
  const t = useTestApp();
  const ORIGINAL_ENV = { ...process.env };
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    process.env.INVITATION_RESEND_MIN_INTERVAL_SECONDS = '0'; // most tests resend repeatedly
    await clearCounters();
    await t.trx('user_invitations').where({ tenant_id: ctx.a.id }).del();
    await t.trx('outbox_events').where({ tenant_id: ctx.a.id }).del();
    await t.trx('notification_log').where({ tenant_id: ctx.a.id }).del();
  });

  /** Redis counters outlive the test database: the resend limits, and the accept endpoint's per-IP limit (20 per 15 minutes) which this file's many accepts would otherwise exhaust for later suites. */
  async function clearCounters() {
    const redis = rateLimitRedisConnection();
    for (const pattern of ['invresend:*', '*auth-staff-invite-accept:*']) {
      const keys = await redis.keys(pattern);
      if (keys.length) await redis.del(...keys);
    }
  }

  afterAll(clearCounters);

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  async function setRole({ tenant = ctx.a, userIndex, propertyIndex = 0, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  /** users[1] as `role` at properties[0]. */
  async function tokenAs(role, { tenant = ctx.a, propertyIndex = 0 } = {}) {
    await setRole({ tenant, userIndex: 1, propertyIndex, role });
    return signAccessToken({ aud: 'staff', sub: String(tenant.users[1].id), tenant_id: String(tenant.id), property_id: String(tenant.properties[propertyIndex].id) });
  }

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  async function invite(token, email, role = 'front_desk') {
    const res = await t.request.post('/api/v1/users/invite').set(auth(token)).send({ email, role });
    expect(res.status).toBe(201);
    return { id: res.body.data.id, token: res.body.data.dev_only_token, body: res.body.data };
  }
  const accept = (token) =>
    t.request.post('/api/v1/auth/invitations/accept').set('X-Tenant-Slug', ctx.a.slug).send({ token, first_name: 'A', last_name: 'B', password: 'a brand new strong passphrase' });
  const resend = (token, id) => t.request.post(`/api/v1/users/invitations/${id}/resend`).set(auth(token)).send({});
  const revoke = (token, id) => t.request.post(`/api/v1/users/invitations/${id}/revoke`).set(auth(token)).send({});
  const pending = async (token) => (await t.request.get('/api/v1/users/pending-invitations').set(auth(token))).body.data;
  const workerCtx = () => workerContext({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id });
  const dispatchAll = () => dispatchPendingOutboxEventsForTenant({ context: workerCtx() });
  const resendFromLog = (token, logId) => t.request.post(`/api/v1/notifications/log/${logId}/resend`).set(auth(token)).send({});

  describe('role escalation (invite, resend, revoke)', () => {
    it('an admin cannot invite a super_admin; a super_admin can invite any role', async () => {
      const admin = await tokenAs('admin');
      const refused = await t.request.post('/api/v1/users/invite').set(auth(admin)).send({ email: 'esc@example.com', role: 'super_admin' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN_ROLE_ESCALATION');
      expect(await t.trx('user_invitations').where({ email: 'esc@example.com' }).first()).toBeUndefined();
      expect((await t.request.post('/api/v1/users/invite').set(auth(admin)).send({ email: 'ok-admin@example.com', role: 'admin' })).status).toBe(201);
      expect((await t.request.post('/api/v1/users/invite').set(auth(admin)).send({ email: 'ok-mgr@example.com', role: 'manager' })).status).toBe(201);

      const superAdmin = await tokenAs('super_admin');
      for (const role of ['super_admin', 'admin', 'manager', 'front_desk']) {
        expect((await t.request.post('/api/v1/users/invite').set(auth(superAdmin)).send({ email: `sa-${role}@example.com`, role })).status).toBe(201);
      }
    });

    it('an admin cannot resend or revoke a pending super_admin invitation; the link keeps working untouched', async () => {
      const superAdmin = await tokenAs('super_admin');
      const inv = await invite(superAdmin, 'sa-pending@example.com', 'super_admin');
      const admin = await tokenAs('admin');
      for (const act of [resend, revoke]) {
        const res = await act(admin, inv.id);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_ROLE_ESCALATION');
      }
      const row = await t.trx('user_invitations').where({ id: inv.id }).first();
      expect(row.revoked_at).toBeNull();
      expect((await accept(inv.token)).status).toBe(200);
    });

    it('a super_admin can resend and revoke any role', async () => {
      const superAdmin = await tokenAs('super_admin');
      const inv = await invite(superAdmin, 'sa-self@example.com', 'super_admin');
      expect((await resend(superAdmin, inv.id)).status).toBe(200);
      expect((await revoke(superAdmin, inv.id)).status).toBe(200);
    });

    it('a setup.view-only manager cannot resend or revoke', async () => {
      const admin = await tokenAs('admin');
      const inv = await invite(admin, 'perm@example.com');
      const manager = await tokenAs('manager');
      expect((await resend(manager, inv.id)).status).toBe(403);
      expect((await revoke(manager, inv.id)).status).toBe(403);
    });
  });

  describe('no token or token hash is exposed', () => {
    it('the invite response, the pending list and the audit rows carry no token hash', async () => {
      const admin = await tokenAs('admin');
      const inv = await invite(admin, 'leak@example.com');
      expect(inv.body).not.toHaveProperty('token_hash');
      const listed = await pending(admin);
      expect(listed.length).toBe(1);
      expect(listed[0]).not.toHaveProperty('token_hash');
      const hash = (await t.trx('user_invitations').where({ id: inv.id }).first()).token_hash;
      const audit = await t.trx('audit_log').where({ entity_type: 'user_invitations' });
      expect(JSON.stringify(audit)).not.toContain(hash);
      expect(JSON.stringify(audit)).not.toContain(inv.token);
    });

    it('resend and revoke audit rows record who/what but never a token or hash; production responses carry no token', async () => {
      const admin = await tokenAs('admin');
      const inv = await invite(admin, 'audit@example.com', 'cashier');
      const res = await resend(admin, inv.id);
      expect(res.status).toBe(200);
      const newToken = res.body.data.dev_only_token;
      expect(typeof newToken).toBe('string');
      await revoke(admin, inv.id);
      const rows = await t.trx('audit_log').where({ entity_type: 'user_invitations', entity_id: String(inv.id) }).whereIn('action', ['resend', 'revoke']);
      expect(rows.map((r) => r.action).sort()).toEqual(['resend', 'revoke']);
      const text = JSON.stringify(rows);
      expect(text).toContain('audit@example.com');
      expect(text).toContain('cashier');
      for (const secret of [inv.token, newToken]) expect(text).not.toContain(secret);
      const hashes = [(await t.trx('user_invitations').where({ id: inv.id }).first()).token_hash];
      expect(text).not.toContain(hashes[0]);

      process.env.NODE_ENV = 'production';
      const second = await invite(admin, 'prod@example.com');
      const prodResend = await resend(admin, second.id);
      expect(prodResend.status).toBe(200);
      expect(prodResend.body.data.dev_only_token).toBeNull();
      expect(JSON.stringify(prodResend.body)).not.toMatch(/token_hash/);
    });
  });

  describe('resend', () => {
    it('kills the old link, issues a working new one, renews the expiry, and queues a new email', async () => {
      const admin = await tokenAs('admin');
      const inv = await invite(admin, 'again@example.com');
      await t.trx('user_invitations').where({ id: inv.id }).update({ expires_at: new Date(Date.now() - 3600 * 1000) });
      expect((await pending(admin))[0].status).toBe('expired');

      const res = await resend(admin, inv.id);
      expect(res.status).toBe(200);
      expect(res.body.data.invitation).toMatchObject({ id: inv.id, email: 'again@example.com', status: 'pending' });
      expect(new Date(res.body.data.invitation.expires_at).getTime()).toBeGreaterThan(Date.now() + 6.9 * 86400000);
      expect(res.body.data.email).toMatchObject({ status: 'sent' });

      expect((await accept(inv.token)).status).toBe(401); // old link dead
      const events = await t.trx('outbox_events').where({ event_type: 'staff.invited' }).orderBy('id');
      expect(events).toHaveLength(2);
      const payloadOf = (e) => (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload);
      expect(payloadOf(events[0]).invitationUrl).toBeNull(); // old link blanked
      expect(payloadOf(events[1]).invitationUrl).toContain(res.body.data.dev_only_token);
      expect((await accept(res.body.data.dev_only_token)).status).toBe(200); // new link works
    });

    it('only pending or expired invitations: accepted and revoked ones return a clear 409', async () => {
      const admin = await tokenAs('admin');
      const done = await invite(admin, 'done@example.com');
      await accept(done.token);
      for (const act of [resend, revoke]) {
        const res = await act(admin, done.id);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT_INVITATION_NOT_PENDING');
        expect(res.body.error.message).toMatch(/accepted/i);
      }
      const gone = await invite(admin, 'gone@example.com');
      await revoke(admin, gone.id);
      for (const act of [resend, revoke]) {
        const res = await act(admin, gone.id);
        expect(res.status).toBe(409);
        expect(res.body.error.message).toMatch(/revoked/i);
      }
    });

    it("is rate limited per invitation: one a minute and a daily cap, without affecting other invitations", async () => {
      const admin = await tokenAs('admin');
      const a = await invite(admin, 'rl-a@example.com');
      const b = await invite(admin, 'rl-b@example.com');
      process.env.INVITATION_RESEND_MIN_INTERVAL_SECONDS = '60';
      expect((await resend(admin, a.id)).status).toBe(200);
      const tooSoon = await resend(admin, a.id);
      expect(tooSoon.status).toBe(429);
      expect(tooSoon.body.error.message).toMatch(/wait/i);
      expect((await resend(admin, b.id)).status).toBe(200);

      process.env.INVITATION_RESEND_MIN_INTERVAL_SECONDS = '0';
      process.env.INVITATION_RESEND_DAILY_CAP = '2';
      const c = await invite(admin, 'rl-c@example.com');
      expect((await resend(admin, c.id)).status).toBe(200);
      expect((await resend(admin, c.id)).status).toBe(200);
      const capped = await resend(admin, c.id);
      expect(capped.status).toBe(429);
      expect(capped.body.error.message).toMatch(/today|daily/i);
      // a refused attempt did not rotate the token
      const tokenBefore = (await t.trx('user_invitations').where({ id: c.id }).first()).token_hash;
      await resend(admin, c.id);
      expect((await t.trx('user_invitations').where({ id: c.id }).first()).token_hash).toBe(tokenBefore);
    });

    it('reports a failed send with the scrubbed reason, and keeps the new link valid', async () => {
      const admin = await tokenAs('admin');
      const inv = await invite(admin, 'fail@example.com');
      process.env.NODE_ENV = 'production';
      process.env.EMAIL_PROVIDER = 'console';
      const res = await resend(admin, inv.id);
      expect(res.status).toBe(200);
      expect(res.body.data.email.status).toBe('failed');
      expect(res.body.data.email.reason).toMatch(/not configured on this server/);
      process.env.NODE_ENV = 'test';
      const row = await t.trx('user_invitations').where({ id: inv.id }).first();
      expect(row.token_hash).not.toBeNull();
    });

    it('waits at most the configured time for the mailer, then answers "queued" while the send finishes in the background', async () => {
      const admin = await tokenAs('admin');
      const inv = await invite(admin, 'slow@example.com');
      process.env.INVITATION_SEND_WAIT_MS = '50';
      jest.spyOn(consoleAdapter, 'send').mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ providerRef: 'slow', status: 'sent' }), 600)));
      const started = Date.now();
      const res = await resend(admin, inv.id);
      expect(Date.now() - started).toBeLessThan(500);
      expect(res.body.data.email.status).toBe('queued');
      await new Promise((resolve) => setTimeout(resolve, 900));
      const event = await t.trx('outbox_events').where({ event_type: 'staff.invited' }).orderBy('id', 'desc').first();
      expect(event.status).toBe('sent');
    });
  });

  describe('revoke', () => {
    it('kills the link at once, removes it from the pending list, keeps the row, and blanks the old email link', async () => {
      const admin = await tokenAs('admin');
      const inv = await invite(admin, 'revoked@example.com');
      const before = (await t.trx('user_invitations').where({ id: inv.id }).first()).token_hash;
      const res = await revoke(admin, inv.id);
      expect(res.status).toBe(200);
      expect(await pending(admin)).toHaveLength(0);
      expect((await accept(inv.token)).status).toBe(401);
      const row = await t.trx('user_invitations').where({ id: inv.id }).first();
      expect(row.revoked_at).not.toBeNull();
      expect(String(row.revoked_by_user_id)).toBe(String(ctx.a.users[1].id));
      expect(row.token_hash).not.toBe(before); // even a path that forgot revoked_at cannot match the old token
      const event = await t.trx('outbox_events').where({ event_type: 'staff.invited' }).first();
      expect((typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload).invitationUrl).toBeNull();
    });

    it('inviting the same address again after a revoke works and keeps the revoked history', async () => {
      const admin = await tokenAs('admin');
      const first = await invite(admin, 'back@example.com');
      await revoke(admin, first.id);
      const second = await invite(admin, 'back@example.com');
      expect(second.id).not.toBe(first.id);
      const rows = await t.trx('user_invitations').where({ email: 'back@example.com' });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.revoked_at).length).toBe(1);
      expect((await accept(second.token)).status).toBe(200);
    });

    it('lists expired invitations as expired (with Resend available), not pending forever', async () => {
      const admin = await tokenAs('admin');
      const inv = await invite(admin, 'old@example.com');
      await t.trx('user_invitations').where({ id: inv.id }).update({ expires_at: new Date(Date.now() - 1000) });
      const listed = await pending(admin);
      expect(listed[0]).toMatchObject({ email: 'old@example.com', status: 'expired' });
      expect((await revoke(admin, inv.id)).status).toBe(200);
    });
  });

  describe('isolation', () => {
    it("another tenant's, or another property's, invitation id is a 404 and is left unchanged", async () => {
      const adminA = await tokenAs('admin', { tenant: ctx.a });
      const inv = await invite(adminA, 'tenant-a@example.com');
      const adminB = await tokenAs('admin', { tenant: ctx.b });
      for (const act of [resend, revoke]) expect((await act(adminB, inv.id)).status).toBe(404);

      // same tenant, a different property
      await setRole({ userIndex: 1, propertyIndex: 1, role: 'admin' });
      const otherProperty = signAccessToken({ aud: 'staff', sub: String(ctx.a.users[1].id), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[1].id) });
      for (const act of [resend, revoke]) expect((await act(otherProperty, inv.id)).status).toBe(404);
      expect((await act404Missing(adminA))).toBe(404);

      const row = await t.trx('user_invitations').where({ id: inv.id }).first();
      expect(row.revoked_at).toBeNull();
      expect((await accept(inv.token)).status).toBe(200);
    });
    async function act404Missing(token) {
      return (await resend(token, 99999999)).status;
    }
  });

  describe('delivery-log Resend never resurrects a dead invitation link', () => {
    const REFUSAL = /This invitation was replaced or revoked, use Users → Pending invitations/;

    async function invitedWithLog(admin, email) {
      const inv = await invite(admin, email);
      await dispatchAll();
      const log = await t.trx('notification_log').where({ recipient_email: email }).first();
      expect(log.status).toBe('sent');
      return { inv, log };
    }

    it('still works for a live, unchanged invitation (and re-sends the same link)', async () => {
      const admin = await tokenAs('admin');
      const { inv, log } = await invitedWithLog(admin, 'live@example.com');
      const res = await resendFromLog(admin, log.id);
      expect(res.status).toBe(201);
      expect(console.log.mock.calls.some(([line]) => String(line).includes(inv.token))).toBe(true);
    });

    it('is refused after the invitation was resent', async () => {
      const admin = await tokenAs('admin');
      const { inv, log } = await invitedWithLog(admin, 'ra@example.com');
      await resend(admin, inv.id);
      console.log.mockClear();
      const res = await resendFromLog(admin, log.id);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(REFUSAL);
      expect(console.log.mock.calls.some(([line]) => String(line).includes(inv.token))).toBe(false);
    });

    it('is refused after the invitation was revoked', async () => {
      const admin = await tokenAs('admin');
      const { inv, log } = await invitedWithLog(admin, 'rr@example.com');
      await revoke(admin, inv.id);
      const res = await resendFromLog(admin, log.id);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(REFUSAL);
    });

    it('is refused after the invitation was accepted', async () => {
      const admin = await tokenAs('admin');
      const { inv, log } = await invitedWithLog(admin, 'rac@example.com');
      await accept(inv.token);
      const res = await resendFromLog(admin, log.id);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(REFUSAL);
    });

    it('is refused for an expired invitation', async () => {
      const admin = await tokenAs('admin');
      const { inv, log } = await invitedWithLog(admin, 'rex@example.com');
      await t.trx('user_invitations').where({ id: inv.id }).update({ expires_at: new Date(Date.now() - 1000) });
      const res = await resendFromLog(admin, log.id);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(REFUSAL);
    });

    it('for an older log row with no event link, never sends the old link: it is refused once the invitation is gone, and only ever the CURRENT live link otherwise', async () => {
      const admin = await tokenAs('admin');
      const { inv, log } = await invitedWithLog(admin, 'legacy@example.com');
      await t.trx('notification_log').where({ id: log.id }).update({ outbox_event_id: null });

      // Re-inviting replaces the row: a resend must not send the OLD token, only the new live one.
      const second = await invite(admin, 'legacy@example.com');
      console.log.mockClear();
      const res = await resendFromLog(admin, log.id);
      expect(res.status).toBe(201);
      const printed = console.log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(printed).not.toContain(inv.token);
      expect(printed).toContain(second.token);

      // Once that invitation is revoked there is nothing live left to send.
      await revoke(admin, second.id);
      const refused = await resendFromLog(admin, log.id);
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(REFUSAL);
    });
  });
});
