'use strict';

/**
 * Self-service "My Profile" screen (user-requested) —
 * `POST /api/v1/auth/me/password`, the password change WHILE LOGGED IN,
 * distinct from `completePasswordReset` (the forgot-password flow, which
 * needs a reset token and has no "current password" to check). Confirmed
 * with the user: revokes every OTHER active session, spares the one
 * behind the request itself.
 */

// Security-review finding: `validatePassword` makes a real network call
// (`isPasswordBreached`) — mocked here so this file's many login/password
// calls stay fast and immune to network flakiness, matching
// `tests/auth/auth.test.js`'s own established convention.
jest.mock('../../src/auth/breached-password', () => ({ isPasswordBreached: jest.fn().mockResolvedValue(false) }));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { hashPassword } = require('../../src/auth/password');
const { hashRefreshToken } = require('../../src/auth/tokens');
const { COOKIE_NAME: REFRESH_COOKIE_NAME } = require('../../src/auth/refresh-cookie');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');

const ORIGINAL_PASSWORD = 'the original strong passphrase';
const NEW_PASSWORD = 'a brand new strong passphrase';

describe('Self-service password change — POST /api/v1/auth/me/password', () => {
  const t = useTestApp();
  let ctx;
  let user; // { id, email }

  beforeAll(async () => {
    // Security-review finding: real HTTP volume against the new per-IP/
    // per-account rate limiter would otherwise collide with real Redis
    // state left over from an earlier run of this same file within the
    // same window — see `tests/auth/auth.test.js`'s own identical flush.
    await flushRateLimitPrefixes(['auth-staff-password-change:ip:', 'auth-staff-password-change:acct:']);

    ctx = await seedTwoTenants(t.trx);
    const hash = await hashPassword(ORIGINAL_PASSWORD);
    const [userId] = await t.trx('users').insert({
      tenant_id: ctx.a.id,
      email: 'password-changer@example.com',
      password_hash: hash,
      first_name: 'Pass',
      last_name: 'Changer',
      status: 'active',
    });
    await t.trx('user_property_access').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      user_id: userId,
      role: 'manager',
    });
    user = { id: userId, email: 'password-changer@example.com' };
  });

  function asTenantA(req) {
    return req.set('X-Tenant-Slug', ctx.a.slug);
  }

  function refreshCookieHeader(res) {
    const setCookie = res.headers['set-cookie'] || [];
    const raw = setCookie.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
    if (!raw) throw new Error('Response did not set a refresh-token cookie.');
    return raw.split(';')[0];
  }

  /** The exact `sessions.id` a cookie header names — for precise, per-row
   * assertions that ignore any stray historical session left over from an
   * earlier test in this same shared, per-file transaction. */
  async function sessionIdForCookie(cookieHeader) {
    const rawToken = decodeURIComponent(cookieHeader.split('=')[1]);
    const row = await t.trx('sessions').where({ refresh_token_hash: hashRefreshToken(rawToken) }).first('id');
    return row?.id ?? null;
  }

  async function login(password = ORIGINAL_PASSWORD) {
    const res = await asTenantA(t.request.post('/api/v1/auth/login')).send({ email: user.email, password });
    return { accessToken: res.body.data.accessToken, cookie: refreshCookieHeader(res), res };
  }

  it('rejects the wrong current password, changes nothing, and records a real auth_events failure', async () => {
    const session = await login();
    const res = await asTenantA(t.request.post('/api/v1/auth/me/password'))
      .set('Authorization', `Bearer ${session.accessToken}`)
      .set('Cookie', session.cookie)
      .send({ current_password: 'definitely wrong', new_password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_CURRENT_PASSWORD_INCORRECT');

    const event = await t.trx('auth_events').where({ user_id: user.id, event_type: 'password_changed' }).orderBy('id', 'desc').first();
    expect(event).toBeDefined();
    expect(event.failure_reason).toBe('invalid_password');

    // The OLD password still works — nothing was changed.
    const stillWorks = await asTenantA(t.request.post('/api/v1/auth/login')).send({ email: user.email, password: ORIGINAL_PASSWORD });
    expect(stillWorks.status).toBe(200);

    // Nothing was revoked either.
    const refreshRes = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', session.cookie);
    expect(refreshRes.status).toBe(200);

    // Every test in this file shares one user (and thus one `sessions`
    // pool) across the same per-file rolled-back transaction — clean up
    // this test's own login so later "exact otherSessionsRevoked count"
    // assertions aren't polluted by a stray still-live session from here.
    await t.trx('sessions').where({ user_id: user.id }).whereNull('revoked_at').update({ revoked_at: new Date(), revoked_reason: 'logout' });
  });

  it('rejects a new password that fails validatePassword (too short), changes nothing', async () => {
    const session = await login();
    const res = await asTenantA(t.request.post('/api/v1/auth/me/password'))
      .set('Authorization', `Bearer ${session.accessToken}`)
      .set('Cookie', session.cookie)
      .send({ current_password: ORIGINAL_PASSWORD, new_password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_PASSWORD_TOO_SHORT');

    const stillWorks = await asTenantA(t.request.post('/api/v1/auth/login')).send({ email: user.email, password: ORIGINAL_PASSWORD });
    expect(stillWorks.status).toBe(200);

    // Same cross-test-isolation cleanup as the test above.
    await t.trx('sessions').where({ user_id: user.id }).whereNull('revoked_at').update({ revoked_at: new Date(), revoked_reason: 'logout' });
  });

  it(
    'THE CORE PROOF: changing the password revokes every OTHER session but genuinely spares the one making the change',
    async () => {
      const sessionA = await login(); // "device A" — makes the change
      const sessionB = await login(); // "device B" — a second, independent login
      const sessionAId = await sessionIdForCookie(sessionA.cookie);
      const sessionBId = await sessionIdForCookie(sessionB.cookie);

      const changeRes = await asTenantA(t.request.post('/api/v1/auth/me/password'))
        .set('Authorization', `Bearer ${sessionA.accessToken}`)
        .set('Cookie', sessionA.cookie)
        .send({ current_password: ORIGINAL_PASSWORD, new_password: NEW_PASSWORD });

      expect(changeRes.status).toBe(200);
      expect(changeRes.body.data.status).toBe('ok');
      expect(changeRes.body.data.otherSessionsRevoked).toBe(1);

      // Direct, PER-ROW DB proof (by exact session id, immune to any stray
      // historical session left over from an earlier test in this same
      // shared, per-file transaction) — done BEFORE the refresh calls
      // below, since refreshing session A legitimately rotates/supersedes
      // its own row (token rotation), which would otherwise muddy this
      // specific "was it spared at the moment of the password change"
      // check.
      const sessionARow = await t.trx('sessions').where({ id: sessionAId }).first();
      const sessionBRow = await t.trx('sessions').where({ id: sessionBId }).first();
      expect(sessionARow.revoked_at).toBeNull();
      expect(sessionBRow.revoked_at).not.toBeNull();
      expect(sessionBRow.revoked_reason).toBe('password_changed');

      // Session B is genuinely dead — its own refresh now fails.
      const refreshB = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', sessionB.cookie);
      expect(refreshB.status).toBe(401);
      expect(refreshB.body.error.code).toBe('AUTH_TOKEN_INVALID');

      // Session A is genuinely spared — not just "not yet noticed" — a real
      // refresh against it still succeeds and issues a fresh access token.
      const refreshA = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', sessionA.cookie);
      expect(refreshA.status).toBe(200);
      expect(typeof refreshA.body.data.accessToken).toBe('string');

      // The old password no longer works; the new one does.
      const oldPasswordLogin = await asTenantA(t.request.post('/api/v1/auth/login')).send({ email: user.email, password: ORIGINAL_PASSWORD });
      expect(oldPasswordLogin.status).toBe(401);
      expect(oldPasswordLogin.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');

      const newPasswordLogin = await asTenantA(t.request.post('/api/v1/auth/login')).send({ email: user.email, password: NEW_PASSWORD });
      expect(newPasswordLogin.status).toBe(200);

      // A real auth_events success row exists too (no failure_reason).
      const successEvent = await t.trx('auth_events').where({ user_id: user.id, event_type: 'password_changed' }).whereNull('failure_reason').orderBy('id', 'desc').first();
      expect(successEvent).toBeDefined();

      // Restore original password and revoke every currently-live session
      // so later tests in this file are unaffected.
      const restoreHash = await hashPassword(ORIGINAL_PASSWORD);
      await t.trx('users').where({ id: user.id }).update({ password_hash: restoreHash });
      await t.trx('sessions').where({ user_id: user.id }).whereNull('revoked_at').update({ revoked_at: new Date(), revoked_reason: 'logout' });
    }
  );

  it('otherSessionsRevoked is 0 when there was only ever the one session', async () => {
    const session = await login();
    const res = await asTenantA(t.request.post('/api/v1/auth/me/password'))
      .set('Authorization', `Bearer ${session.accessToken}`)
      .set('Cookie', session.cookie)
      .send({ current_password: ORIGINAL_PASSWORD, new_password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.otherSessionsRevoked).toBe(0);

    const restoreHash = await hashPassword(ORIGINAL_PASSWORD);
    await t.trx('users').where({ id: user.id }).update({ password_hash: restoreHash });
    await t.trx('sessions').where({ user_id: user.id }).update({ revoked_at: new Date(), revoked_reason: 'logout' });
  });

  it('documented fallback: with no refresh cookie at all, revokes EVERY session (nothing to spare)', async () => {
    const sessionA = await login();
    const sessionB = await login();

    const res = await asTenantA(t.request.post('/api/v1/auth/me/password'))
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      // Deliberately no `.set('Cookie', ...)` at all.
      .send({ current_password: ORIGINAL_PASSWORD, new_password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.otherSessionsRevoked).toBe(2);

    const refreshA = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', sessionA.cookie);
    expect(refreshA.status).toBe(401);
    const refreshB = await asTenantA(t.request.post('/api/v1/auth/refresh')).set('Cookie', sessionB.cookie);
    expect(refreshB.status).toBe(401);

    const restoreHash = await hashPassword(ORIGINAL_PASSWORD);
    await t.trx('users').where({ id: user.id }).update({ password_hash: restoreHash });
  });
});
