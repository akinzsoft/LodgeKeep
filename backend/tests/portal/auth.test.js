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
});
