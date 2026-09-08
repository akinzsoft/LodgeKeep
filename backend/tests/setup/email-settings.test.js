'use strict';

/**
 * Gap closure (user-reported): "add the mail setup on in SETUP menu" —
 * user-confirmed decision (AskUserQuestion): per-property, stored in the
 * database. Covers `GET/PUT /api/v1/email-settings` and
 * `POST /api/v1/email-settings/test`, real encryption at rest, and RBAC
 * (setup.view/setup.manage — the same gate every other Setup screen uses).
 *
 * Deliberately uses `properties[1]`, not the default `properties[0]` —
 * `fixtures.js`'s own `seedTwoTenants` now seeds a real `email_settings`
 * row on `properties[0]` for both tenants (for the generic `ISO-*`
 * isolation suite's own "every registered table already has interleaved
 * rows for both tenants" assumption), so `properties[1]` is the one
 * genuinely still-unconfigured property this file needs for its own
 * "nothing configured yet" cases.
 *
 * Cross-tenant isolation is covered separately by the generic `ISO-*` suite
 * (`tests/helpers/entities.js`'s new `email_settings` entry) — not repeated
 * here.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { decrypt } = require('../../src/shared/encryption');

describe('Email settings (gap closure: mail setup in Setup menu)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    // fixtures.js's own grant plan gives `users[0]` `front_desk` at
    // `properties[1]` (no `setup.view`) — this file's whole point is
    // `properties[1]`, the one property with no fixture-seeded
    // `email_settings` row, so `users[0]` needs a setup-capable role there
    // too, for both tenants.
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('user_property_access')
        .where({ user_id: tenant.users[0].id, property_id: tenant.properties[1].id })
        .update({ role: 'manager' });
    }
  });

  function tokenFor({ tenant, userIndex = 0, propertyId }) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[userIndex].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[1].id),
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

  async function adminToken() {
    await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 1, role: 'admin' });
    return tokenFor({ tenant: ctx.a, userIndex: 1 });
  }

  describe('GET /api/v1/email-settings', () => {
    it('returns null when the property has never configured email settings', async () => {
      const res = await t.request.get('/api/v1/email-settings').set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a })}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it('setup.view (manager, the fixture-seeded default) can read', async () => {
      const res = await t.request.get('/api/v1/email-settings').set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a })}`);
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /api/v1/email-settings', () => {
    it('rejects a setup.view-only caller (manager) with a real 403', async () => {
      const res = await t.request
        .put('/api/v1/email-settings')
        .set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a })}`)
        .send({ provider: 'smtp', smtp_host: 'smtp.example.com', smtp_user: 'a@example.com', smtp_password: 'secret' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('creates settings for a property that had none, never echoing the raw password back', async () => {
      const token = await adminToken();
      const res = await t.request
        .put('/api/v1/email-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          provider: 'smtp',
          smtp_host: 'smtp.example.com',
          smtp_port: 465,
          smtp_user: 'billing@example.com',
          smtp_password: 'super-secret-password',
          smtp_from: 'noreply@example.com',
          smtp_from_name: 'Example Hotel',
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        provider: 'smtp',
        smtp_host: 'smtp.example.com',
        smtp_port: 465,
        smtp_user: 'billing@example.com',
        smtp_from: 'noreply@example.com',
        smtp_from_name: 'Example Hotel',
        smtp_password_set: true,
      });
      expect(res.body.data.smtp_password).toBeUndefined();
      expect(JSON.stringify(res.body.data)).not.toContain('super-secret-password');
    });

    it('genuinely encrypts the password at rest — not plaintext, and correctly recoverable', async () => {
      const row = await t.trx('email_settings').where({ property_id: ctx.a.properties[1].id }).first();
      expect(row.smtp_password_encrypted).toBeDefined();
      expect(row.smtp_password_encrypted).not.toContain('super-secret-password');
      expect(decrypt(row.smtp_password_encrypted)).toBe('super-secret-password');
    });

    it('a blank/omitted password on a later update preserves the existing encrypted password', async () => {
      const token = await adminToken();
      const before = await t.trx('email_settings').where({ property_id: ctx.a.properties[1].id }).first('smtp_password_encrypted');

      const res = await t.request
        .put('/api/v1/email-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'smtp', smtp_host: 'smtp2.example.com', smtp_user: 'billing@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.data.smtp_host).toBe('smtp2.example.com');
      expect(res.body.data.smtp_password_set).toBe(true);

      const after = await t.trx('email_settings').where({ property_id: ctx.a.properties[1].id }).first('smtp_password_encrypted');
      expect(after.smtp_password_encrypted).toBe(before.smtp_password_encrypted);
      expect(decrypt(after.smtp_password_encrypted)).toBe('super-secret-password');
    });

    it('cross-tenant: tenant B still sees no settings on its own equivalent (never-configured) property', async () => {
      const res = await t.request.get('/api/v1/email-settings').set('Authorization', `Bearer ${tokenFor({ tenant: ctx.b })}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });
  });

  describe('POST /api/v1/email-settings/test', () => {
    it('rejects a setup.view-only caller with a real 403', async () => {
      const res = await t.request
        .post('/api/v1/email-settings/test')
        .set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a })}`)
        .send({ to: 'someone@example.com' });
      expect(res.status).toBe(403);
    });

    it("sends via the console adapter when no property override is configured (tenant B's own still-unconfigured property)", async () => {
      await grantRoleToUser({ tenant: ctx.b, userIndex: 1, propertyIndex: 1, role: 'admin' });
      const token = tokenFor({ tenant: ctx.b, userIndex: 1 });

      const res = await t.request.post('/api/v1/email-settings/test').set('Authorization', `Bearer ${token}`).send({ to: 'someone@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ sent: true, provider: 'console' });
    });

    it('surfaces a real send failure as a real 400, not a bare 500, when the configured host does not resolve', async () => {
      const token = await adminToken();
      await t.request
        .put('/api/v1/email-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'smtp', smtp_host: 'this-host-genuinely-does-not-exist.invalid', smtp_user: 'a@example.com', smtp_password: 'x' });

      const res = await t.request.post('/api/v1/email-settings/test').set('Authorization', `Bearer ${token}`).send({ to: 'someone@example.com' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_EMAIL_TEST_SEND_FAILED');
    }, 15000);
  });
});
