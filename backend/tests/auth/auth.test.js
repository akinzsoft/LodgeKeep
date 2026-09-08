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
const { hashMfaCode } = require('../../src/auth/mfa');
const { COOKIE_NAME: REFRESH_COOKIE_NAME } = require('../../src/auth/refresh-cookie');
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

  /**
   * Gap closure: the refresh token now travels only as an HttpOnly cookie
   * (`src/auth/refresh-cookie.js`), never in the response body — supertest
   * has no browser-style cookie jar, so a test that needs to carry a
   * previous response's cookie into its next request must extract and
   * resend it explicitly, exactly what a real browser does invisibly.
   */
  function refreshCookieHeader(res) {
    const setCookie = res.headers['set-cookie'] || [];
    const raw = setCookie.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
    if (!raw) throw new Error('Response did not set a refresh-token cookie.');
    return raw.split(';')[0];
  }

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
      // Gap closure: the refresh token travels ONLY as an HttpOnly cookie now
      // — never in the JSON body, not even once, so it's never JS-readable.
      expect(res.body.data.refreshToken).toBeUndefined();
      expect(res.body.data.tenantId).toBe(String(ctx.a.id));
      expect(res.body.data.activePropertyId).toBe(String(loginable.propertyId));
      expect(res.body.data.role).toBe('manager');

      const setCookie = res.headers['set-cookie'] || [];
      const refreshCookie = setCookie.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toMatch(/HttpOnly/i);
      expect(refreshCookie).toMatch(/SameSite=Lax/i);
      expect(refreshCookie).toMatch(/Path=\/api\/v1\/auth/i);
      // Not Secure outside production — see refresh-cookie.js's own header;
      // a plain-HTTP dev/test origin would silently drop a Secure cookie.
      expect(refreshCookie).not.toMatch(/Secure/i);

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

      // Gap closure: /auth/logout moved off authenticate('staff') (see
      // service.js's own staffLogout header for why), so it's no longer a
      // route where "expired access token → 401" applies at all — this
      // general authenticate()-gate case now uses /switch-property
      // instead, which genuinely still needs the authenticated context.
      const res = await t.request
        .post('/api/v1/auth/switch-property')
        .set('Authorization', `Bearer ${expired}`)
        .send({ property_id: loginable.propertyId });
      // No X-Tenant-Slug needed here: /auth/switch-property is
      // authenticated, not tenant-resolved — tenant comes from the token.

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

      const res = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', `${REFRESH_COOKIE_NAME}=${token}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('rejects a refresh with no cookie at all — the new endpoint reads no body field any more', async () => {
      const res = await asTenantA(t.request.post('/api/v1/auth/refresh'));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('rotates a live refresh token and the old one stops working', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });
      const firstRefreshCookie = refreshCookieHeader(login);

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', firstRefreshCookie);
      expect(rotated.status).toBe(200);
      expect(typeof rotated.body.data.accessToken).toBe('string');
      expect(rotated.body.data.refreshToken).toBeUndefined();
      const rotatedCookie = refreshCookieHeader(rotated);
      expect(rotatedCookie).not.toBe(firstRefreshCookie);

      const replay = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', firstRefreshCookie);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('returns the same tenantId/userId/role/properties shape login does — a page reload restores its session through THIS endpoint, with nothing else to read them from', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh'))
        .set('Cookie', refreshCookieHeader(login))
        .send({ property_id: String(loginable.propertyId) });

      expect(rotated.status).toBe(200);
      expect(rotated.body.data.tenantId).toBe(String(ctx.a.id));
      expect(rotated.body.data.userId).toBe(String(loginable.id));
      expect(rotated.body.data.activePropertyId).toBe(String(loginable.propertyId));
      expect(rotated.body.data.role).toBe('manager');
      expect(rotated.body.data.properties).toEqual(
        expect.arrayContaining([{ propertyId: String(loginable.propertyId), role: 'manager' }])
      );
    });

    it('restores the active property across a refresh when the caller supplies it, re-verified rather than trusted', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh'))
        .set('Cookie', refreshCookieHeader(login))
        .send({ property_id: String(loginable.propertyId) });
      expect(rotated.status).toBe(200);
      const claims = jwt.decode(rotated.body.data.accessToken);
      expect(claims.property_id).toBe(String(loginable.propertyId));
    });

    it('defaults the active property across a refresh when the caller supplies none and holds exactly one — same default staffLogin itself uses, so a page-reload bootstrap resumes where it left off', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', refreshCookieHeader(login));
      expect(rotated.status).toBe(200);
      const claims = jwt.decode(rotated.body.data.accessToken);
      expect(claims.property_id).toBe(String(loginable.propertyId));
      expect(rotated.body.data.activePropertyId).toBe(String(loginable.propertyId));
    });

    it('still drops the active property when the caller supplies none AND holds more than one — genuinely ambiguous, never guessed', async () => {
      const email = 'multi-property@example.com';
      const [userId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email,
        password_hash: await hashPassword(STRONG_PASSWORD),
        first_name: 'Multi',
        last_name: 'Property',
        status: 'active',
      });
      await t.trx('user_property_access').insert([
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, user_id: userId, role: 'manager' },
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[1].id, user_id: userId, role: 'manager' },
      ]);

      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({ email, password: STRONG_PASSWORD });
      expect(jwt.decode(login.body.data.accessToken).property_id).toBeNull(); // login's own ambiguous case

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', refreshCookieHeader(login));
      expect(rotated.status).toBe(200);
      const claims = jwt.decode(rotated.body.data.accessToken);
      expect(claims.property_id).toBeNull();
      expect(rotated.body.data.activePropertyId).toBeNull();
    });

    it('refuses to restore a property the caller no longer holds — re-verified, not trusted (SECURITY.md §3)', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });

      const rotated = await asTenantA(t.request.post('/api/v1/auth/refresh'))
        .set('Cookie', refreshCookieHeader(login))
        .send({ property_id: String(ctx.a.properties[1].id) }); // loginable has no grant here
      expect(rotated.status).toBe(200);
      const claims = jwt.decode(rotated.body.data.accessToken);
      expect(claims.property_id).toBeNull();
    });
  });

  // ==================================================================
  // Gap closure: HttpOnly refresh-token cookie (src/auth/refresh-cookie.js)
  // — no TESTING.md-numbered case exists for logout itself; grouped here
  // since it exercises the same cookie mechanism AUTH-6 does.
  // ==================================================================
  describe('staff logout — cookie-based', () => {
    it('revokes the session behind the cookie and clears the cookie', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });
      const loginCookie = refreshCookieHeader(login);

      // Gap closure: /auth/logout is tenant-resolved now (see service.js's
      // own staffLogout header), not authenticated — X-Tenant-Slug replaces
      // the Authorization header this test used to need.
      const res = await asTenantA(t.request.post('/api/v1/auth/logout')).set('Cookie', loginCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.revoked).toBe(true);
      const cleared = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
      expect(cleared).toBeDefined();
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);

      const refreshAfterLogout = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', loginCookie);
      expect(refreshAfterLogout.status).toBe(401);
      expect(refreshAfterLogout.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('is a no-op (200, revoked: false) rather than an error when no cookie is present', async () => {
      const res = await asTenantA(t.request.post('/api/v1/auth/logout'));

      expect(res.status).toBe(200);
      expect(res.body.data.revoked).toBe(false);
    });

    /**
     * The actual bug (user-reported, live-tested): sign out appeared to
     * work (the UI showed the login screen), but a page reload afterward
     * restored the same dashboard session — because the OLD /auth/logout
     * required a fresh access token, and any access-token problem other
     * than a clean `AUTH_TOKEN_EXPIRED` (a malformed one, a missing one,
     * one from a stale in-memory ref) meant the real, server-side session
     * was never actually revoked. Proven here with NO Authorization header
     * at all — the harshest real case — and confirmed the session is
     * genuinely gone afterward via a real subsequent refresh attempt, not
     * just a 200 response.
     */
    it('revokes the session from the cookie alone, with no access token needed at all', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });
      const loginCookie = refreshCookieHeader(login);

      const res = await asTenantA(t.request.post('/api/v1/auth/logout')).set('Cookie', loginCookie);
      // Deliberately no .set('Authorization', ...) at all.

      expect(res.status).toBe(200);
      expect(res.body.data.revoked).toBe(true);

      const refreshAfterLogout = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', loginCookie);
      expect(refreshAfterLogout.status).toBe(401);
      expect(refreshAfterLogout.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('revokes the session from the cookie alone even with a malformed Authorization header (the AUTH_TOKEN_INVALID case the old logout could never recover from)', async () => {
      const login = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: loginable.email,
        password: STRONG_PASSWORD,
      });
      const loginCookie = refreshCookieHeader(login);

      const res = await asTenantA(t.request.post('/api/v1/auth/logout'))
        .set('Cookie', loginCookie)
        .set('Authorization', 'Bearer this-is-not-a-real-token');

      expect(res.status).toBe(200);
      expect(res.body.data.revoked).toBe(true);
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
      const liveRefreshCookie = refreshCookieHeader(login);

      const forgot = await asTenantA(t.request.post('/api/v1/auth/password/forgot')).send({ email });
      const resetToken = forgot.body.data.dev_only_token;
      const completed = await asTenantA(t.request.post('/api/v1/auth/password/reset')).send({
        token: resetToken,
        new_password: 'a totally different passphrase',
      });
      expect(completed.status).toBe(200);

      const refreshAfterReset = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', liveRefreshCookie);
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
  // Real staff MFA verification — src/auth/mfa.js, src/auth/service.js.
  // Gap closure (user-reported, live-tested): "the verification code shld
  // be send to the account email to login not a static code." Not a
  // TESTING.md-numbered case by name, but the same "auth needs every
  // branch including failure paths" discipline the old dev-bypass block
  // already applied — now proven against a real emailed code, not a fixed
  // string.
  // ==================================================================
  describe('staff MFA verification (real emailed code)', () => {
    async function challenge() {
      const res = await asTenantA(t.request.post('/api/v1/auth/login')).send({
        email: adminNoMfa.email,
        password: STRONG_PASSWORD,
      });
      return { challengeToken: res.body.data.challengeToken, devOnlyCode: res.body.data.dev_only_code };
    }

    it('issues a real code: stored hashed, emailed via the outbox, and disclosed as dev_only_code outside production', async () => {
      const { challengeToken, devOnlyCode } = await challenge();
      expect(typeof challengeToken).toBe('string');
      expect(typeof devOnlyCode).toBe('string');
      expect(devOnlyCode).toMatch(/^\d{6}$/);

      const stored = await t.trx('mfa_login_codes').where({ user_id: adminNoMfa.id }).whereNull('used_at').orderBy('id', 'desc').first();
      expect(stored).toBeDefined();
      expect(stored.code_hash).toBe(hashMfaCode(devOnlyCode));
      expect(stored.attempts).toBe(0);

      const outboxEvent = await t.trx('outbox_events').where({ event_type: 'staff.mfa_code_requested' }).orderBy('id', 'desc').first();
      expect(outboxEvent).toBeDefined();
      const payload = typeof outboxEvent.payload === 'string' ? JSON.parse(outboxEvent.payload) : outboxEvent.payload;
      expect(payload.guestEmail).toBe(adminNoMfa.email);
      expect(payload.code).toBe(devOnlyCode);
    });

    it('completes the login with the real code', async () => {
      const { challengeToken, devOnlyCode } = await challenge();
      const res = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: devOnlyCode });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ok');
      expect(typeof res.body.data.accessToken).toBe('string');
      // Same gap closure as AUTH-1 — the refresh token never touches the body.
      expect(res.body.data.refreshToken).toBeUndefined();
      const setCookie = res.headers['set-cookie'] || [];
      expect(setCookie.some((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`))).toBe(true);
      expect(res.body.data.role).toBe('admin');

      const events = await authEventsFor(adminNoMfa.id);
      expect(events.some((e) => e.event_type === 'mfa_verified')).toBe(true);

      const stored = await t.trx('mfa_login_codes').where({ code_hash: hashMfaCode(devOnlyCode) }).first();
      expect(stored.used_at).not.toBeNull();
    });

    it('rejects a wrong code with a real 401, and audits it as mfa_failed', async () => {
      const { challengeToken, devOnlyCode } = await challenge();
      const wrongCode = devOnlyCode === '111111' ? '222222' : '111111';
      const res = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: wrongCode });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_MFA_CODE_INVALID');

      const events = await authEventsFor(adminNoMfa.id);
      expect(events.some((e) => e.event_type === 'mfa_failed')).toBe(true);
    });

    it('rejects reuse of an already-verified code (single-use)', async () => {
      const { challengeToken, devOnlyCode } = await challenge();
      const first = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: devOnlyCode });
      expect(first.status).toBe(200);

      // A fresh login+challenge is needed for a second attempt in real use
      // (staffLogin deletes/replaces the outstanding code on each new
      // challenge) — but the SAME challenge token can still be replayed
      // against the now-spent code row directly, which is exactly the
      // single-use claim this proves.
      const second = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: devOnlyCode });
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('AUTH_MFA_CODE_INVALID');
    });

    it('rejects an expired code', async () => {
      const { challengeToken, devOnlyCode } = await challenge();
      await t.trx('mfa_login_codes').where({ code_hash: hashMfaCode(devOnlyCode) }).update({ expires_at: new Date(Date.now() - 1000) });

      const res = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: devOnlyCode });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_MFA_CODE_INVALID');
    });

    it('locks out a code after MFA_CODE_MAX_ATTEMPTS wrong guesses, even once the right code is finally submitted', async () => {
      const { challengeToken, devOnlyCode } = await challenge();
      const wrongCode = devOnlyCode === '111111' ? '222222' : '111111';

      for (let i = 0; i < 5; i += 1) {
        const attempt = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: wrongCode });
        expect(attempt.status).toBe(401);
      }

      const finalAttempt = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: challengeToken, code: devOnlyCode });
      expect(finalAttempt.status).toBe(401);
      expect(finalAttempt.body.error.code).toBe('AUTH_MFA_CODE_INVALID');

      const stored = await t.trx('mfa_login_codes').where({ code_hash: hashMfaCode(devOnlyCode) }).first();
      expect(stored.attempts).toBe(5);
      expect(stored.used_at).toBeNull();
    });

    it('a repeat login attempt while already mid-challenge supersedes the earlier code — the old one no longer works', async () => {
      const first = await challenge();
      const second = await challenge();
      expect(second.devOnlyCode).not.toBe(first.devOnlyCode);

      const staleAttempt = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: first.challengeToken, code: first.devOnlyCode });
      expect(staleAttempt.status).toBe(401);

      const freshAttempt = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: second.challengeToken, code: second.devOnlyCode });
      expect(freshAttempt.status).toBe(200);
    });

    it('rejects an invalid or garbage challenge token with the standard 501 (also the only path a platform MFA-verify attempt ever reaches)', async () => {
      const res = await t.request.post('/api/v1/auth/mfa/verify').send({ challenge_token: 'not-a-real-token', code: '000000' });

      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('AUTH_MFA_NOT_IMPLEMENTED');
    });

    it('never discloses dev_only_code when NODE_ENV is production, though real verification still works', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        // `resolveTenant` only honours the X-Tenant-Slug dev override
        // outside production (`tenant-resolution.js`'s own header) — a
        // real Host header, matching production's actual subdomain
        // resolution, is what every other test in this describe block
        // gets from X-Tenant-Slug for free.
        const loginRes = await t.request
          .post('/api/v1/auth/login')
          .set('Host', `${ctx.a.slug}.${process.env.APP_DOMAIN}`)
          .send({ email: adminNoMfa.email, password: STRONG_PASSWORD });
        expect(loginRes.body.data.dev_only_code).toBeNull();

        // The real code still exists in the database (it was still really
        // emailed via the outbox) — read it directly, the same way a real
        // client in production would only ever see it via the actual
        // email, never this response.
        const stored = await t.trx('mfa_login_codes').where({ user_id: adminNoMfa.id }).whereNull('used_at').orderBy('id', 'desc').first();
        const outboxEvent = await t.trx('outbox_events').where({ event_type: 'staff.mfa_code_requested' }).orderBy('id', 'desc').first();
        const payload = typeof outboxEvent.payload === 'string' ? JSON.parse(outboxEvent.payload) : outboxEvent.payload;
        expect(stored.code_hash).toBe(hashMfaCode(payload.code));

        const verifyRes = await t.request
          .post('/api/v1/auth/mfa/verify')
          .send({ challenge_token: loginRes.body.data.challengeToken, code: payload.code });
        expect(verifyRes.status).toBe(200);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    // Gap closure (user-reported, live-tested): "i want the verification
    // code shld be send to account email not to show on the screen." The
    // dev-only disclosure existed purely to cover "no real inbox exists to
    // check" — once a real adapter is actually configured, disclosing the
    // code anywhere but the email it was just sent to defeats the point.
    it('never discloses dev_only_code once a real email adapter (not console) is configured, even outside production', async () => {
      const originalProvider = process.env.EMAIL_PROVIDER;
      process.env.EMAIL_PROVIDER = 'smtp';
      try {
        // The real code still exists and is still really emailed via the
        // outbox — this login call only enqueues that event, it never
        // opens a real SMTP connection itself (that's the dispatcher's
        // job), so no SMTP_HOST/credentials are needed for this test.
        const loginRes = await asTenantA(t.request.post('/api/v1/auth/login')).send({
          email: adminNoMfa.email,
          password: STRONG_PASSWORD,
        });
        expect(loginRes.body.data.dev_only_code).toBeNull();

        const stored = await t.trx('mfa_login_codes').where({ user_id: adminNoMfa.id }).whereNull('used_at').orderBy('id', 'desc').first();
        const outboxEvent = await t.trx('outbox_events').where({ event_type: 'staff.mfa_code_requested' }).orderBy('id', 'desc').first();
        const payload = typeof outboxEvent.payload === 'string' ? JSON.parse(outboxEvent.payload) : outboxEvent.payload;
        expect(stored.code_hash).toBe(hashMfaCode(payload.code));

        const verifyRes = await t.request
          .post('/api/v1/auth/mfa/verify')
          .send({ challenge_token: loginRes.body.data.challengeToken, code: payload.code });
        expect(verifyRes.status).toBe(200);
      } finally {
        if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
        else process.env.EMAIL_PROVIDER = originalProvider;
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

      // Gap closure: /auth/logout moved off authenticate('staff') (see
      // service.js's own staffLogout header) — a deactivated account can,
      // and should, still be able to revoke its own lingering session, so
      // this general authenticate()-gate case now uses /switch-property.
      const res = await t.request
        .post('/api/v1/auth/switch-property')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ property_id: ctx.a.properties[0].id });

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
