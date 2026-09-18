'use strict';

/**
 * Self-service "My Profile" screen (user-requested) — `GET`/`PATCH
 * /api/v1/auth/me`. HTTP-level, against the shared rolled-back fixture
 * transaction (`useTestApp()`), mirroring `tests/auth/auth.test.js`'s own
 * conventions (`X-Tenant-Slug` dev override, a real inserted user with a
 * known password hash).
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { hashPassword } = require('../../src/auth/password');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Self-service "My Profile" — GET/PATCH /api/v1/auth/me', () => {
  const t = useTestApp();
  let ctx;
  let userA; // { id, email }
  let userAToken;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    const hash = await hashPassword('a genuinely long enough password');

    const [userAId] = await t.trx('users').insert({
      tenant_id: ctx.a.id,
      email: 'profile-owner@example.com',
      password_hash: hash,
      first_name: 'Ada',
      last_name: 'Okafor',
      phone: '+2348012345678',
      status: 'active',
    });
    await t.trx('user_property_access').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      user_id: userAId,
      role: 'manager',
    });
    userA = { id: userAId, email: 'profile-owner@example.com' };
    userAToken = signAccessToken({ aud: 'staff', sub: String(userA.id), tenant_id: String(ctx.a.id), property_id: String(ctx.a.properties[0].id) });
  });

  function asUserA(req) {
    return req.set('Authorization', `Bearer ${userAToken}`);
  }

  it('GET /auth/me returns the real, own profile fields', async () => {
    const res = await asUserA(t.request.get('/api/v1/auth/me'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      userId: String(userA.id),
      email: 'profile-owner@example.com',
      firstName: 'Ada',
      lastName: 'Okafor',
      phone: '+2348012345678',
    });
  });

  it('PATCH /auth/me updates first_name/last_name/phone together', async () => {
    const res = await asUserA(t.request.patch('/api/v1/auth/me')).send({
      first_name: 'Adaeze',
      last_name: 'Nwosu',
      phone: '+2348099999999',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.firstName).toBe('Adaeze');
    expect(res.body.data.lastName).toBe('Nwosu');
    expect(res.body.data.phone).toBe('+2348099999999');

    const row = await t.trx('users').where({ id: userA.id }).first();
    expect(row.first_name).toBe('Adaeze');
    expect(row.last_name).toBe('Nwosu');
    expect(row.phone).toBe('+2348099999999');

    // Restore for the tests below, which assume the original fixture values.
    await t.trx('users').where({ id: userA.id }).update({ first_name: 'Ada', last_name: 'Okafor', phone: '+2348012345678' });
  });

  it('a partial body changes only the field(s) supplied', async () => {
    const res = await asUserA(t.request.patch('/api/v1/auth/me')).send({ phone: '+2348055555555' });
    expect(res.status).toBe(200);
    expect(res.body.data.firstName).toBe('Ada'); // unchanged
    expect(res.body.data.phone).toBe('+2348055555555');
    await t.trx('users').where({ id: userA.id }).update({ phone: '+2348012345678' });
  });

  it('phone: null clears an existing value', async () => {
    const res = await asUserA(t.request.patch('/api/v1/auth/me')).send({ phone: null });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBeNull();
    await t.trx('users').where({ id: userA.id }).update({ phone: '+2348012345678' });
  });

  it('rejects an empty first_name', async () => {
    const res = await asUserA(t.request.patch('/api/v1/auth/me')).send({ first_name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FIRST_NAME_REQUIRED');
  });

  it('rejects a first_name over 100 characters', async () => {
    const res = await asUserA(t.request.patch('/api/v1/auth/me')).send({ first_name: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FIRST_NAME_TOO_LONG');
  });

  it('rejects a phone number over 30 characters', async () => {
    const res = await asUserA(t.request.patch('/api/v1/auth/me')).send({ phone: 'x'.repeat(31) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_PHONE_TOO_LONG');
  });

  it(
    'ignores email/id/user_id/tenant_id even if a caller supplies them, pointing at a real different user — ' +
      'proving the ownership boundary: there is no id anywhere in this request for a caller to smuggle another user through',
    async () => {
      const otherTenantAdminId = ctx.b.users[0].id; // a real user in a DIFFERENT tenant
      const beforeOther = await t.trx('users').where({ id: otherTenantAdminId }).first();

      const res = await asUserA(t.request.patch('/api/v1/auth/me')).send({
        first_name: 'StillMine',
        email: 'attacker-controlled@example.com',
        id: otherTenantAdminId,
        user_id: otherTenantAdminId,
        tenant_id: ctx.b.id,
      });

      expect(res.status).toBe(200);
      // The caller's OWN email is unchanged — the smuggled `email` field was never read.
      expect(res.body.data.email).toBe('profile-owner@example.com');
      expect(res.body.data.userId).toBe(String(userA.id));

      // The OTHER tenant's real user row is completely untouched.
      const afterOther = await t.trx('users').where({ id: otherTenantAdminId }).first();
      expect(afterOther).toEqual(beforeOther);

      await t.trx('users').where({ id: userA.id }).update({ first_name: 'Ada' });
    }
  );

  it('writes a real audit_log row for a genuine profile update', async () => {
    await asUserA(t.request.patch('/api/v1/auth/me')).send({ last_name: 'Audited' });

    const row = await t.trx('audit_log').where({ entity_type: 'users', entity_id: userA.id, action: 'update_profile' }).orderBy('id', 'desc').first();
    expect(row).toBeDefined();
    expect(String(row.user_id)).toBe(String(userA.id));
    expect(row.source).toBe('web');
    const before = typeof row.before_state === 'string' ? JSON.parse(row.before_state) : row.before_state;
    const after = typeof row.after_state === 'string' ? JSON.parse(row.after_state) : row.after_state;
    expect(before.last_name).toBe('Okafor');
    expect(after.last_name).toBe('Audited');

    await t.trx('users').where({ id: userA.id }).update({ last_name: 'Okafor' });
  });

  it('writes no audit_log row when the PATCH body has nothing recognized in it', async () => {
    const before = await t.trx('audit_log').count({ n: '*' });
    const res = await asUserA(t.request.patch('/api/v1/auth/me')).send({ nonsense_field: 'ignored' });
    expect(res.status).toBe(200);
    const after = await t.trx('audit_log').count({ n: '*' });
    expect(after).toEqual(before);
  });

  it('rejects a request with no access token at all', async () => {
    const res = await t.request.get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a garbage access token', async () => {
    const res = await t.request.get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});
