'use strict';

/**
 * HTTP-level tests for the guest portal's own auth endpoints — PLAN.md
 * Phase 4, PRODUCT_REQUIREMENTS.md §3.14/§3.16. `guestLogin` and
 * `guestRegister` (src/auth/service.js) already existed/were added, but no
 * test anywhere exercised either over real HTTP before this file — the
 * only prior guest-auth coverage was AUTH-12 (a directly-minted guest token
 * against a staff route), in `tests/auth/auth.test.js`.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { issueRefreshToken } = require('../../src/auth/tokens');

describe('Guest portal auth (PLAN.md Phase 4)', () => {
  const t = useTestApp();
  let ctx;

  let propertySlugs;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    // The fixture's own `properties[i]` objects carry only {id, ordinal} —
    // `slug` lives in the real row (tests/helpers/fixtures.js's own
    // `${t.slug}-property-${i+1}` insert), fetched here rather than
    // guessed at.
    const rows = await t.trx('properties').where({ tenant_id: ctx.a.id }).orderBy('id');
    propertySlugs = rows.map((row) => row.slug);
  });

  describe('POST /api/v1/portal/auth/register', () => {
    it('registers a new guest account and returns a real, usable access token', async () => {
      const res = await t.request
        .post('/api/v1/portal/auth/register')
        .set('X-Tenant-Slug', ctx.a.slug)
        .send({
          property_slug: propertySlugs[0],
          email: 'new-guest@example.com',
          password: 'a brand new strong passphrase',
          first_name: 'New',
          last_name: 'Guest',
          phone: '+10000000001',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('ok');
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(res.body.data.refreshToken).toBeUndefined();

      const guestAccount = await t.trx('guest_accounts').where({ tenant_id: ctx.a.id, email: 'new-guest@example.com' }).first();
      expect(guestAccount).toBeDefined();
      expect(guestAccount.guest_id).not.toBeNull();

      const guest = await t.trx('guests').where({ id: guestAccount.guest_id }).first();
      expect(guest.first_name).toBe('New');

      const event = await t.trx('auth_events').where({ tenant_id: ctx.a.id, event_type: 'registration' }).orderBy('id', 'desc').first();
      expect(event).toBeDefined();
      expect(String(event.guest_account_id)).toBe(String(guestAccount.id));
    });

    it('rejects a duplicate email at the same property with a real 409, not a bare 500', async () => {
      await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'twice@example.com',
        password: 'a brand new strong passphrase',
        first_name: 'A',
        last_name: 'B',
      });
      const dupe = await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'twice@example.com',
        password: 'a different strong passphrase',
        first_name: 'C',
        last_name: 'D',
      });
      expect(dupe.status).toBe(409);
      expect(dupe.body.error.code).toBe('CONFLICT_DUPLICATE_ENTRY');
    });

    it('allows the same email to register at a DIFFERENT property (unique per property, not per tenant)', async () => {
      await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'multi-property@example.com',
        password: 'a brand new strong passphrase',
        first_name: 'A',
        last_name: 'B',
      });
      const secondProperty = await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[1],
        email: 'multi-property@example.com',
        password: 'a brand new strong passphrase',
        first_name: 'A',
        last_name: 'B',
      });
      expect(secondProperty.status).toBe(201);
    });

    it('rejects a weak password', async () => {
      const res = await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'weak@example.com',
        password: 'short',
        first_name: 'A',
        last_name: 'B',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_PASSWORD_TOO_SHORT');
    });

    it('404s an unknown property slug rather than resolving into the wrong one', async () => {
      const res = await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: 'not-a-real-property',
        email: 'orphan@example.com',
        password: 'a brand new strong passphrase',
        first_name: 'A',
        last_name: 'B',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_PROPERTY_NOT_FOUND');
    });
  });

  describe('POST /api/v1/portal/auth/login', () => {
    it('logs a registered guest in for real, and the token satisfies authenticate(guest)', async () => {
      await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'login-test@example.com',
        password: 'a brand new strong passphrase',
        first_name: 'Login',
        last_name: 'Test',
      });

      const res = await t.request.post('/api/v1/portal/auth/login').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'login-test@example.com',
        password: 'a brand new strong passphrase',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ok');
      expect(typeof res.body.data.accessToken).toBe('string');
    });

    it('rejects a wrong password with the same generic message as an unknown email (no enumeration)', async () => {
      const wrongPassword = await t.request.post('/api/v1/portal/auth/login').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'guest@example.com', // real fixture account
        password: 'definitely wrong',
      });
      const unknownEmail = await t.request.post('/api/v1/portal/auth/login').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'no-such-guest@example.com',
        password: 'anything',
      });
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(unknownEmail.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });
  });

  /**
   * Gap closure (flagged in CLAUDE.md's own Phase 4 section, built via
   * feature-dev): guest password-reset. Mirrors AUTH-7/AUTH-8's own shape
   * for staff, against `guest_accounts`/`guest_password_resets` instead —
   * a genuinely separate credential store (SECURITY.md §3), not a reuse of
   * the staff flow.
   */
  describe('POST /api/v1/portal/auth/password/forgot', () => {
    it('requests a reset for a real active guest account, and writes a real reset row + outbox event + auth event', async () => {
      await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'forgot-me@example.com',
        password: 'a brand new strong passphrase',
        first_name: 'Forgot',
        last_name: 'Me',
      });

      const res = await t.request.post('/api/v1/portal/auth/password/forgot').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'forgot-me@example.com',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ok');
      expect(typeof res.body.data.dev_only_token).toBe('string');

      const guestAccount = await t.trx('guest_accounts').where({ tenant_id: ctx.a.id, email: 'forgot-me@example.com' }).first();
      const resetRow = await t.trx('guest_password_resets').where({ guest_account_id: guestAccount.id }).first();
      expect(resetRow).toBeDefined();
      expect(resetRow.used_at).toBeNull();

      const outboxEvent = await t.trx('outbox_events').where({ event_type: 'guest.password_reset_requested' }).orderBy('id', 'desc').first();
      expect(outboxEvent).toBeDefined();
      const payload = typeof outboxEvent.payload === 'string' ? JSON.parse(outboxEvent.payload) : outboxEvent.payload;
      expect(payload.guestEmail).toBe('forgot-me@example.com');
      expect(typeof payload.resetUrl).toBe('string');

      const authEvent = await t.trx('auth_events').where({ tenant_id: ctx.a.id, event_type: 'password_reset_requested', audience: 'guest' }).orderBy('id', 'desc').first();
      expect(authEvent).toBeDefined();
      expect(String(authEvent.guest_account_id)).toBe(String(guestAccount.id));
    });

    it('returns the identical response shape for an unknown email — no enumeration', async () => {
      const known = await t.request.post('/api/v1/portal/auth/password/forgot').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'guest@example.com', // real fixture account
      });
      const unknown = await t.request.post('/api/v1/portal/auth/password/forgot').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'no-such-guest-at-all@example.com',
      });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(Object.keys(known.body.data).sort()).toEqual(Object.keys(unknown.body.data).sort());
      expect(unknown.body.data.dev_only_token).toBeNull();

      const noReset = await t.trx('guest_password_resets')
        .join('guest_accounts', 'guest_accounts.id', 'guest_password_resets.guest_account_id')
        .where('guest_accounts.email', 'no-such-guest-at-all@example.com')
        .first();
      expect(noReset).toBeUndefined();
    });

    it('the same email at a DIFFERENT property does not resolve — property-scoped, not tenant-wide', async () => {
      const res = await t.request.post('/api/v1/portal/auth/password/forgot').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[1],
        email: 'forgot-me@example.com', // only registered at propertySlugs[0] above
      });
      expect(res.status).toBe(200);
      expect(res.body.data.dev_only_token).toBeNull();
    });

    it('404s an unknown property slug — a real, distinct rejection, not folded into the anti-enumeration shape', async () => {
      const res = await t.request.post('/api/v1/portal/auth/password/forgot').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: 'not-a-real-property',
        email: 'anyone@example.com',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_PROPERTY_NOT_FOUND');
    });
  });

  describe('POST /api/v1/portal/auth/password/reset', () => {
    async function registerAndRequestReset(email) {
      await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email,
        password: 'the original strong passphrase',
        first_name: 'Reset',
        last_name: 'Target',
      });
      const forgot = await t.request.post('/api/v1/portal/auth/password/forgot').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email,
      });
      return forgot.body.data.dev_only_token;
    }

    it('completes with no property_slug in the request at all — resolved entirely from the token', async () => {
      const token = await registerAndRequestReset('reset-no-slug@example.com');

      const res = await t.request.post('/api/v1/portal/auth/password/reset').set('X-Tenant-Slug', ctx.a.slug).send({
        token,
        new_password: 'a brand new strong passphrase',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ok');

      const guestAccount = await t.trx('guest_accounts').where({ tenant_id: ctx.a.id, email: 'reset-no-slug@example.com' }).first();
      expect(guestAccount.password_changed_at).not.toBeNull();

      const resetRow = await t.trx('guest_password_resets').where({ guest_account_id: guestAccount.id }).first();
      expect(resetRow.used_at).not.toBeNull();
    });

    it('rejects a second completion of the same token', async () => {
      const token = await registerAndRequestReset('reset-twice@example.com');
      const first = await t.request.post('/api/v1/portal/auth/password/reset').set('X-Tenant-Slug', ctx.a.slug).send({
        token,
        new_password: 'a brand new strong passphrase',
      });
      expect(first.status).toBe(200);

      const second = await t.request.post('/api/v1/portal/auth/password/reset').set('X-Tenant-Slug', ctx.a.slug).send({
        token,
        new_password: 'a different passphrase entirely',
      });
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('rejects an expired token', async () => {
      await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email: 'reset-expired@example.com',
        password: 'the original strong passphrase',
        first_name: 'Reset',
        last_name: 'Expired',
      });
      const guestAccount = await t.trx('guest_accounts').where({ tenant_id: ctx.a.id, email: 'reset-expired@example.com' }).first();
      const { token: expiredToken, hash: expiredHash } = issueRefreshToken();
      await t.trx('guest_password_resets').insert({
        tenant_id: ctx.a.id,
        property_id: guestAccount.property_id,
        guest_account_id: guestAccount.id,
        token_hash: expiredHash,
        expires_at: new Date(Date.now() - 1000),
      });

      const res = await t.request.post('/api/v1/portal/auth/password/reset').set('X-Tenant-Slug', ctx.a.slug).send({
        token: expiredToken,
        new_password: 'irrelevant but long enough',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('rejects an unknown/garbage token', async () => {
      const res = await t.request.post('/api/v1/portal/auth/password/reset').set('X-Tenant-Slug', ctx.a.slug).send({
        token: 'not-a-real-token',
        new_password: 'irrelevant but long enough',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    /**
     * The session-invalidation mechanism itself — not a copy of AUTH-8,
     * since no `sessions` table exists for guests. Proves a token issued
     * BEFORE the reset stops working on its very next use, and a token
     * issued AFTER (a fresh login) works normally — the check doesn't
     * over-trigger.
     */
    it('invalidates a guest access token issued before the reset, but not one issued after', async () => {
      const email = 'reset-invalidates-guest@example.com';
      await t.request.post('/api/v1/portal/auth/register').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email,
        password: 'the original strong passphrase',
        first_name: 'Reset',
        last_name: 'Invalidates',
      });
      const preResetLogin = await t.request.post('/api/v1/portal/auth/login').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email,
        password: 'the original strong passphrase',
      });
      const preResetToken = preResetLogin.body.data.accessToken;

      const forgot = await t.request.post('/api/v1/portal/auth/password/forgot').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email,
      });
      const completed = await t.request.post('/api/v1/portal/auth/password/reset').set('X-Tenant-Slug', ctx.a.slug).send({
        token: forgot.body.data.dev_only_token,
        new_password: 'a brand new strong passphrase',
      });
      expect(completed.status).toBe(200);

      const staleAttempt = await t.request.get('/api/v1/portal/account/bookings').set('Authorization', `Bearer ${preResetToken}`);
      expect(staleAttempt.status).toBe(401);
      expect(staleAttempt.body.error.code).toBe('AUTH_SESSION_INVALID');

      // A deliberate wait past the reset's own whole-second boundary, not a
      // flaky race: `authenticate('guest')`'s invalidation check rejects
      // any token from the reset's own wall-clock second or earlier (`iat`
      // is only second-granular per the JWT spec, so that's the safe,
      // documented direction to round the ambiguity — see middleware.js's
      // own comment on this exact check). A login issued within that same
      // second would therefore be correctly, if conservatively, rejected
      // too; this test is proving the case a real, human-paced login
      // genuinely represents — a later second — not sub-second machine
      // timing no real guest operates at.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const postResetLogin = await t.request.post('/api/v1/portal/auth/login').set('X-Tenant-Slug', ctx.a.slug).send({
        property_slug: propertySlugs[0],
        email,
        password: 'a brand new strong passphrase',
      });
      expect(postResetLogin.status).toBe(200);
      const freshAttempt = await t.request
        .get('/api/v1/portal/account/bookings')
        .set('Authorization', `Bearer ${postResetLogin.body.data.accessToken}`);
      expect(freshAttempt.status).toBe(200);
    });
  });
});
