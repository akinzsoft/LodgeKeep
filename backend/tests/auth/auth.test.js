'use strict';

/**
 * The auth module, end to end through HTTP — TESTING.md AUTH-1..AUTH-15.
 *
 * Runs against the real Express app (`src/app.js`) via `useTestApp()`, which
 * points the app's database access at this file's own rolled-back fixture
 * transaction (see `tests/helpers/app.js`). `X-Tenant-Slug` stands in for the
 * Host-header subdomain resolution `resolveTenant` normally uses — the
 * documented dev/test override (`src/auth/tenant-resolution.js`), not a
 * production code path.
 */

const jwt = require('jsonwebtoken');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants, seedPlatformUser, PASSWORD_HASH } = require('../helpers/fixtures');
const { hashPassword } = require('../../src/auth/password');
const { issueRefreshToken, hashRefreshToken } = require('../../src/auth/tokens');
const {
  ACCOUNT_THRESHOLD,
  IP_THRESHOLD,
} = require('../../src/auth/lockout');

const STRONG_PASSWORD = 'correct horse battery staple 42';

describe('auth module (SECURITY.md §3, TESTING.md AUTH-1..15)', () => {
  const t = useTestApp();
  let ctx;
  let loginable; // { id, email, propertyId }
  let adminNoMfa; // a user with the admin role at a property, mfa_enabled=false

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    ctx.platform = await seedPlatformUser(t.trx);

    const hash = await hashPassword(STRONG_PASSWORD);

    const [loginableId] = await t.trx('users').insert({
      tenant_id: ctx.a.id,
      email: 'loginable@example.com',
      password_hash: hash,
      first_name: 'Logs',
      last_name: 'In',
      status: 'active',
    });
    await t.trx('user_property_access').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      user_id: loginableId,
      role: 'manager',
    });
    loginable = { id: loginableId, email: 'loginable@example.com', propertyId: ctx.a.properties[0].id };

    const [adminId] = await t.trx('users').insert({
      tenant_id: ctx.a.id,
      email: 'admin-no-mfa@example.com',
      password_hash: hash,
      first_name: 'Ad',
      last_name: 'Min',
      status: 'active',
      mfa_enabled: false,
    });
    await t.trx('user_property_access').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      user_id: adminId,
      role: 'admin',
    });
    adminNoMfa = { id: adminId, email: 'admin-no-mfa@example.com' };
  });

  const asTenantA = (req) => req.set('X-Tenant-Slug', ctx.a.slug);

  const authEventsFor = async (userId) =>
    t.trx('auth_events').where({ user_id: userId }).orderBy('id', 'asc');

  // ==================================================================
  // AUTH-1 — valid credentials
  // ==================================================================
  describe('AUTH-1: valid credentials', () => {
    it('returns 200 with access and refresh tokens, and tenant/property/role', async () => {
      const res = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(typeof res.body.data.refreshToken).toBe('string');
      expect(res.body.data.tenantId).toBe(String(ctx.a.id));
      expect(res.body.data.activePropertyId).toBe(String(loginable.propertyId));
      expect(res.body.data.role).toBe('manager');

      const claims = jwt.decode(res.body.data.accessToken);
      expect(claims.aud).toBe('staff');
      expect(claims.tenant_id).toBe(String(ctx.a.id));
      expect(claims.property_id).toBe(String(loginable.propertyId));
    });
  });

  // ==================================================================
  // AUTH-2 — identical failure for wrong password / unknown email
  // ==================================================================
  describe('AUTH-2: no account enumeration', () => {
    it('gives an identical response for a wrong password and an unknown email', async () => {
      const wrongPassword = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: 'not the right passphrase',
      });
      const unknownEmail = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: 'nobody-here@example.com',
        password: 'whatever',
      });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(unknownEmail.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });
  });

  // ==================================================================
  // AUTH-3 / AUTH-4 — lockout, per account and per IP
  // ==================================================================
  describe('AUTH-3: per-account lockout', () => {
    it('locks the account after the threshold and unlocks nothing on a correct password meanwhile', async () => {
      const email = 'lockout-target@example.com';
      const hash = await hashPassword(STRONG_PASSWORD);
      const [userId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email,
        password_hash: hash,
        first_name: 'Lock',
        last_name: 'Out',
        status: 'active',
      });

      for (let i = 0; i < ACCOUNT_THRESHOLD; i += 1) {
        const res = await asTenantA(t.request.post('/api/v1/auth/login')).send({
          email,
          password: 'wrong',
        });
        expect(res.status).toBe(401);
      }

      // The threshold is reached — even the RIGHT password is now refused.
      const res = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email,
        password: STRONG_PASSWORD,
      });
      expect(res.status).toBe(423);
      expect(res.body.error.code).toBe('LOCKED_ACCOUNT');

      const events = await authEventsFor(userId);
      expect(events.some((e) => e.event_type === 'lockout')).toBe(true);
    });
  });

  describe('AUTH-4: per-IP lockout does not punish a shared terminal', () => {
    it('does not lock a fresh account after many failures against OTHER accounts from the same IP', async () => {
      const sharedIp = '198.51.100.77';

      // IP_THRESHOLD - 1 failures, spread across distinct unknown accounts —
      // below the per-IP ceiling, and none of them share a user_id so the
      // per-account dimension can never be what's being exercised here.
      const rows = [];
      for (let i = 0; i < IP_THRESHOLD - 1; i += 1) {
        rows.push({
          audience: 'staff',
          event_type: 'login_failure',
          failure_reason: 'unknown_email',
          tenant_id: ctx.a.id,
          ip: sharedIp,
          email_attempted: `nobody-${i}@example.com`,
        });
      }
      await t.trx('auth_events').insert(rows);

      const res = await asTenantA(t.request.post('/api/v1/auth/login'))
        .set('X-Forwarded-For', sharedIp)
        .send({ email: adminNoMfa.email, password: 'still wrong though' });

      // Wrong password, not a lockout — proves the IP dimension alone, one
      // failure short of its own threshold, did not block a different account.
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('does lock the IP once its own threshold is reached, independent of which accounts were involved', async () => {
      const sharedIp = '198.51.100.88';
      const rows = [];
      for (let i = 0; i < IP_THRESHOLD; i += 1) {
        rows.push({
          audience: 'staff',
          event_type: 'login_failure',
          failure_reason: 'unknown_email',
          tenant_id: ctx.a.id,
          ip: sharedIp,
          email_attempted: `nobody-${i}@example.com`,
        });
      }
      await t.trx('auth_events').insert(rows);

      const res = await asTenantA(t.request.post('/api/v1/auth/login'))
        .set('X-Forwarded-For', sharedIp)
        .send({ email: 'yet-another-unknown@example.com', password: 'irrelevant' });

      expect(res.status).toBe(423);
      expect(res.body.error.code).toBe('LOCKED_ACCOUNT');
    });
  });

  // ==================================================================
  // AUTH-5 — expired access token
  // ==================================================================
  describe('AUTH-5: expired access token', () => {
    it('rejects an expired access token with 401', async () => {
      const expired = jwt.sign(
        { aud: 'staff', sub: String(loginable.id), tenant_id: String(ctx.a.id), property_id: null },
        process.env.JWT_SECRET,
        { expiresIn: -10 }
      );

      const res = await t.request
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${expired}`)
        .send({ refresh_token: 'irrelevant' });
      // No X-Tenant-Slug needed here: /auth/logout is authenticated, not
      // tenant-resolved (see routes.js) — tenant comes from the token itself.

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_EXPIRED');
    });
  });

  // ==================================================================
  // AUTH-6 — refresh after revocation
  // ==================================================================
  describe('AUTH-6: refresh token after revocation', () => {
    it('rejects a refresh whose session was already revoked', async () => {
      const { token, hash } = issueRefreshToken();
      await t.trx('sessions').insert({
        tenant_id: ctx.a.id,
        user_id: loginable.id,
        refresh_token_hash: hash,
        expires_at: new Date(Date.now() + 86400000),
        revoked_at: new Date(),
        revoked_reason: 'admin_revoked',
      });

      const res = await asTenantA(t.request.post('/api/v1/auth/refresh')).send({ refresh_token: token });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('rotates a live refresh token and the old one stops working', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });
      const firstRefresh = login.body.data.refreshToken;

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh')).send({
        refresh_token: firstRefresh,
      });
      expect(rotated.status).toBe(200);
      expect(typeof rotated.body.data.accessToken).toBe('string');
      expect(rotated.body.data.refreshToken).not.toBe(firstRefresh);

      const replay = await asTenantA(t.request.post('/api/v1/auth/refresh')).send({
        refresh_token: firstRefresh,
      });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('restores the active property across a refresh when the caller supplies it, re-verified rather than trusted', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh')).send({
        refresh_token: login.body.data.refreshToken,
        property_id: String(loginable.propertyId),
      });
      expect(rotated.status).toBe(200);
      const claims = jwt.decode(rotated.body.data.accessToken);
      expect(claims.property_id).toBe(String(loginable.propertyId));
    });

    it('drops the active property across a refresh when the caller supplies none — never invents one', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh')).send({
        refresh_token: login.body.data.refreshToken,
      });
      expect(rotated.status).toBe(200);
      const claims = jwt.decode(rotated.body.data.accessToken);
      expect(claims.property_id).toBeNull();
    });

    it('refuses to restore a property the caller no longer holds — re-verified, not trusted (SECURITY.md §3)', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh')).send({
        refresh_token: login.body.data.refreshToken,
        property_id: String(ctx.a.properties[1].id), // loginable has no grant here
      });
      expect(rotated.status).toBe(200);
      const claims = jwt.decode(rotated.body.data.accessToken);
      expect(claims.property_id).toBeNull();
    });
  });

  // ==================================================================
  // AUTH-7 — password reset: single-use, expires
  // ==================================================================
  describe('AUTH-7: password reset token', () => {
    it('completes once, rejects the second use, and rejects an expired token', async () => {
      // A fresh account, never `loginable` — completing a reset changes the
      // real password, and `loginable` is reused by later AUTH-N tests that
      // still expect to log in with STRONG_PASSWORD.
      const email = 'resettable@example.com';
      await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email,
        password_hash: await hashPassword(STRONG_PASSWORD),
        first_name: 'Re',
        last_name: 'Settable',
        status: 'active',
      });

      const forgot = await asTenantA(t.request.post('/api/v1/auth/password/forgot')).send({
        email,
      });
      expect(forgot.status).toBe(200);
      const token = forgot.body.data.dev_only_token;
      expect(typeof token).toBe('string');

      const first = await asTenantA(t.request.post('/api/v1/auth/password/reset')).send({
        token,
        new_password: 'a brand new strong passphrase',
      });
      expect(first.status).toBe(200);

      const second = await asTenantA(t.request.post('/api/v1/auth/password/reset')).send({
        token,
        new_password: 'a different passphrase entirely',
      });
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('AUTH_TOKEN_INVALID');

      const [expiredUserId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email: 'expired-reset@example.com',
        password_hash: await hashPassword(STRONG_PASSWORD),
        first_name: 'Ex',
        last_name: 'Pired',
        status: 'active',
      });
      const { token: expiredToken, hash: expiredHash } = issueRefreshToken();
      await t.trx('password_resets').insert({
        tenant_id: ctx.a.id,
        user_id: expiredUserId,
        token_hash: expiredHash,
        expires_at: new Date(Date.now() - 1000),
      });

      const expiredRes = await asTenantA(t.request.post('/api/v1/auth/password/reset')).send({
        token: expiredToken,
        new_password: 'irrelevant but long enough',
      });
      expect(expiredRes.status).toBe(401);
      expect(expiredRes.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });
  });

  // ==================================================================
  // AUTH-8 — completing a reset invalidates existing sessions
  // ==================================================================
  describe('AUTH-8: password reset invalidates existing sessions', () => {
    it('revokes a session opened before the reset', async () => {
      const email = 'reset-invalidates@example.com';
      const [userId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email,
        password_hash: await hashPassword(STRONG_PASSWORD),
        first_name: 'Re',
        last_name: 'Set',
        status: 'active',
      });

      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email,
        password: STRONG_PASSWORD,
      });
      expect(login.status).toBe(200);
      const liveRefreshToken = login.body.data.refreshToken;

      const forgot = await asTenantA(t.request.post('/api/v1/auth/password/forgot')).send({ email });
      const resetToken = forgot.body.data.dev_only_token;
      const completed = await asTenantA(t.request.post('/api/v1/auth/password/reset')).send({
        token: resetToken,
        new_password: 'a totally different passphrase',
      });
      expect(completed.status).toBe(200);

      const refreshAfterReset = await asTenantA(t.request.post('/api/v1/auth/refresh')).send({
        refresh_token: liveRefreshToken,
      });
      expect(refreshAfterReset.status).toBe(401);

      const session = await t.trx('sessions').where({ user_id: userId }).first();
      expect(session.revoked_reason).toBe('password_reset');
    });
  });

  // ==================================================================
  // AUTH-9 — MFA-required role without MFA
  // ==================================================================
  describe('AUTH-9: MFA-required role without MFA', () => {
    it('issues a challenge instead of tokens for an admin without MFA', async () => {
      const res = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: adminNoMfa.email,
        password: STRONG_PASSWORD,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('mfa_challenge_required');
      expect(res.body.data.accessToken).toBeUndefined();
      expect(res.body.data.refreshToken).toBeUndefined();
      expect(typeof res.body.data.challengeToken).toBe('string');

      const events = await authEventsFor(adminNoMfa.id);
      expect(events.some((e) => e.event_type === 'mfa_challenge_issued')).toBe(true);
    });
  });

  // ==================================================================
  // MFA dev bypass — src/auth/mfa.js. Not a TESTING.md-numbered case (no
  // real MFA verification exists to number), but the only path today by
  // which an admin/super_admin account can complete a real HTTP login, so
  // its one production-safety property (never outside NODE_ENV!=='production')
  // gets its own explicit failing-path coverage per CLAUDE.md's "auth needs
  // every branch including failure paths" rule.
  // ==================================================================
  describe('MFA dev bypass (src/auth/mfa.js)', () => {
    async function challenge() {
      const res = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: adminNoMfa.email,
        password: STRONG_PASSWORD,
      });
      return res.body.data.challengeToken;
    }

    it('completes the login with the dev bypass code outside production', async () => {
      const challengeToken = await challenge();
      const res = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: '000000' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ok');
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(typeof res.body.data.refreshToken).toBe('string');
      expect(res.body.data.role).toBe('admin');

      const events = await authEventsFor(adminNoMfa.id);
      expect(events.some((e) => e.event_type === 'mfa_verified')).toBe(true);
    });

    it('rejects the wrong code with the standard 501, and audits it as mfa_failed', async () => {
      const challengeToken = await challenge();
      const res = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: '123456' });

      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('AUTH_MFA_NOT_IMPLEMENTED');

      const events = await authEventsFor(adminNoMfa.id);
      expect(events.some((e) => e.event_type === 'mfa_failed')).toBe(true);
    });

    it('rejects an invalid or garbage challenge token with the standard 501', async () => {
      const res = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: 'not-a-real-token', code: '000000' });

      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('AUTH_MFA_NOT_IMPLEMENTED');
    });

    it('never accepts the bypass code when NODE_ENV is production, even with a valid challenge token', async () => {
      const challengeToken = await challenge();
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: '000000' });
        expect(res.status).toBe(501);
        expect(res.body.error.code).toBe('AUTH_MFA_NOT_IMPLEMENTED');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });

  // ==================================================================
  // AUTH-10 — deactivation takes effect on the very next request
  // ==================================================================
  describe('AUTH-10: deactivated user’s live session', () => {
    it('rejects a still-unexpired access token once the user is deactivated', async () => {
      const email = 'deactivate-me@example.com';
      const [userId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email,
        password_hash: await hashPassword(STRONG_PASSWORD),
        first_name: 'De',
        last_name: 'Active',
        status: 'active',
      });

      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email,
        password: STRONG_PASSWORD,
      });
      const accessToken = login.body.data.accessToken;

      await t.trx('users').where({ id: userId }).update({ status: 'inactive' });

      const res = await t.request
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refresh_token: 'anything' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_SESSION_INVALID');
    });
  });

  // ==================================================================
  // AUTH-11 — passwords are stored as hashes only
  // ==================================================================
  describe('AUTH-11: password stored', () => {
    it('never stores the plaintext password anywhere in the row', async () => {
      const row = await t.trx('users').where({ id: loginable.id }).first();
      expect(row.password_hash).not.toBe(STRONG_PASSWORD);
      expect(row.password_hash.startsWith('$2b$')).toBe(true);
      expect(JSON.stringify(row)).not.toContain(STRONG_PASSWORD);
    });
  });

  // ==================================================================
  // AUTH-12 — a guest token on a PMS route
  // ==================================================================
  describe('AUTH-12: guest credentials on a PMS route', () => {
    it('rejects a guest-audience token with 401 wrong-audience', async () => {
      const guestToken = jwt.sign(
        {
          aud: 'guest',
          sub: String(ctx.a.guestAccounts[0].id),
          tenant_id: String(ctx.a.id),
          property_id: String(ctx.a.properties[0].id),
        },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      const res = await t.request
        .post('/api/v1/auth/switch-property')
        .set('Authorization', `Bearer ${guestToken}`)
        .send({ property_id: ctx.a.properties[1].id });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_WRONG_AUDIENCE');
    });
  });

  // ==================================================================
  // AUTH-13 — platform staff without impersonation
  // ==================================================================
  describe('AUTH-13: platform user without impersonation reads tenant data', () => {
    it('authenticates a platform token but the platform tree has no path to tenant data', async () => {
      const platformToken = jwt.sign(
        { aud: 'platform', sub: String(ctx.platform.id) },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      // Authenticates fine (proves the token itself is good) but the platform
      // tree mounts no tenant-data route at all yet — the bare-404 catch-all
      // is what answers, never tenant data. The database-level guarantee (a
      // platform context structurally cannot scope a tenant-owned table) is
      // asserted directly in tests/isolation/scoped-accessor.test.js.
      const res = await t.request
        .get('/api/v1/platform/anything')
        .set('Authorization', `Bearer ${platformToken}`);

      expect(res.status).toBe(404);
    });

    it('rejects a staff token on the platform tree entirely', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });
      const res = await t.request
        .get('/api/v1/platform/anything')
        .set('Authorization', `Bearer ${login.body.data.accessToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_WRONG_AUDIENCE');
    });
  });

  // ==================================================================
  // AUTH-14 — every auth event lands a row
  // ==================================================================
  describe('AUTH-14: auth events are recorded', () => {
    it('writes a login_success row with the right attribution', async () => {
      const res = await asTenantA(t.request.post('/api/v1/auth/login'))
        .set('X-Forwarded-For', '203.0.113.44')
        .send({ email: loginable.email, password: STRONG_PASSWORD });
      expect(res.status).toBe(200);

      const events = await authEventsFor(loginable.id);
      const success = events.filter((e) => e.event_type === 'login_success');
      expect(success.length).toBeGreaterThan(0);
      const last = success[success.length - 1];
      expect(String(last.tenant_id)).toBe(String(ctx.a.id));
      expect(last.audience).toBe('staff');
    });
  });

  // ==================================================================
  // AUTH-15 — authenticated by default
  // ==================================================================
  describe('AUTH-15: unlisted route without a token', () => {
    it.each([
      ['/api/v1/reservations', 'staff'],
      ['/api/v1/anything-not-yet-built', 'staff'],
    ])('%s requires a token (401), never a silent 404', async (path) => {
      const res = await t.request.get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_UNAUTHENTICATED');
    });

    it('applies the same default-deny to the portal tree', async () => {
      const res = await t.request.get('/api/v1/portal/orders');
      expect(res.status).toBe(401);
    });

    it('applies the same default-deny to the platform tree', async () => {
      const res = await t.request.get('/api/v1/platform/tenants');
      expect(res.status).toBe(401);
    });

    it('still allows the public login route with no token', async () => {
      const res = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: 'nope@example.com',
        password: 'nope',
      });
      expect(res.status).toBe(401); // invalid credentials, not "unauthenticated"
      expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    });
  });
});
