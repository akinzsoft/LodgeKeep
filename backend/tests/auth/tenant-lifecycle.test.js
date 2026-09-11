'use strict';

/**
 * The trial/suspended read-only enforcement gate — PLAN.md Phase 5,
 * PRODUCT_REQUIREMENTS.md §3.22 ("read-only degradation with a grace
 * period is safer than a hard cutoff"). One project-wide policy
 * (`src/shared/tenant-lifecycle.js`) enforced by one HTTP-level gate
 * (`src/auth/tenant-lifecycle-guard.js`), mirroring
 * `src/auth/impersonation-guard.js`'s own proven shape exactly.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Tenant lifecycle read-only enforcement (PLAN.md Phase 5)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    const setupManage = await t.trx('permissions').where({ permission_key: 'setup.manage' }).first('id');
    await t.trx('role_permissions').insert({ tenant_id: ctx.a.id, role_id: ctx.a.roles.manager, permission_id: setupManage.id });
    await t.trx('role_permissions').insert({ tenant_id: ctx.b.id, role_id: ctx.b.roles.manager, permission_id: setupManage.id });
  });

  function staffToken({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function setStatus(tenant, status, trialEndsAt = null) {
    await t.trx('tenants').where({ id: tenant.id }).update({ status, trial_ends_at: trialEndsAt });
  }

  afterEach(async () => {
    await setStatus(ctx.a, 'active');
    await setStatus(ctx.b, 'active');
  });

  // A real bug found and fixed in this session, not a mystery — this is
  // almost certainly the actual root cause of the CI flake CLAUDE.md's own
  // Phase 5 subscription-billing section documents as "66+ reproduction
  // attempts, zero reproductions": `market_segments.code` is
  // `VARCHAR(30)`, and this helper used to build
  // `gate-${Date.now()}-${Math.random().toString(36).slice(2)}` — a
  // 13-digit future-dated timestamp plus a RANDOM-LENGTH suffix
  // (`Math.random().toString(36)` produces anywhere from a handful of
  // characters up to ~13) that occasionally overflowed 30 characters,
  // producing a genuine `ER_DATA_TOO_LONG` and a bare `500` on this exact
  // endpoint. Reproduced directly in this session (twice, on two different
  // tests that both call this same helper) after the original CI
  // investigation's 66+ attempts all targeted environmental factors
  // (Node version, DB freshness, CPU load, execution order) rather than
  // this helper's own non-deterministic string length — none of which
  // affect `Math.random()`'s output distribution, which is exactly why
  // every environmental knob came back clean. Fixed with a
  // fixed-maximum-length id instead of an unbounded random one.
  function writeRequest(tenant = ctx.a) {
    return t.request
      .post('/api/v1/market-segments')
      .set('Authorization', `Bearer ${staffToken({ tenant })}`)
      .send({ name: 'Gate test', code: `gt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` });
  }

  function readRequest(tenant = ctx.a) {
    return t.request.get('/api/v1/room-types').set('Authorization', `Bearer ${staffToken({ tenant })}`);
  }

  it('an active tenant writes and reads normally', async () => {
    expect((await readRequest()).status).toBe(200);
    expect((await writeRequest()).status).toBe(201);
  });

  it('a trial tenant with no expiry set is fully usable — reads and writes both succeed', async () => {
    await setStatus(ctx.a, 'trial', null);
    expect((await readRequest()).status).toBe(200);
    expect((await writeRequest()).status).toBe(201);
  });

  it('a trial tenant whose trial has not yet ended is fully usable', async () => {
    await setStatus(ctx.a, 'trial', new Date(Date.now() + 60_000 * 60 * 24 * 7));
    expect((await readRequest()).status).toBe(200);
    expect((await writeRequest()).status).toBe(201);
  });

  it('a trial tenant whose trial has already ended is read-only', async () => {
    await setStatus(ctx.a, 'trial', new Date(Date.now() - 60_000));
    const readRes = await readRequest();
    expect(readRes.status).toBe(200);
    const writeRes = await writeRequest();
    expect(writeRes.status).toBe(403);
    expect(writeRes.body.error.code).toBe('FORBIDDEN_TENANT_READ_ONLY');
    expect(writeRes.body.error.details.tenantStatus).toBe('trial');
  });

  it('a suspended tenant is read-only', async () => {
    await setStatus(ctx.a, 'suspended');
    expect((await readRequest()).status).toBe(200);
    const writeRes = await writeRequest();
    expect(writeRes.status).toBe(403);
    expect(writeRes.body.error.code).toBe('FORBIDDEN_TENANT_READ_ONLY');
  });

  it('existing reservation data remains fully readable while suspended', async () => {
    await setStatus(ctx.a, 'suspended');
    const listRes = await t.request.get('/api/v1/reservations').set('Authorization', `Bearer ${staffToken()}`);
    expect(listRes.status).toBe(200);
    const found = listRes.body.data.find((r) => String(r.id) === String(ctx.a.reservations[0].id));
    expect(found).toBeTruthy();

    const oneRes = await t.request.get(`/api/v1/reservations/${ctx.a.reservations[0].id}`).set('Authorization', `Bearer ${staffToken()}`);
    expect(oneRes.status).toBe(200);
    expect(String(oneRes.body.data.id)).toBe(String(ctx.a.reservations[0].id));
  });

  it('a suspended reservation cannot be modified (a real business write, not just the reference market-segments one)', async () => {
    await setStatus(ctx.a, 'suspended');
    const res = await t.request
      .post(`/api/v1/reservations/${ctx.a.reservations[0].id}/cancel`)
      .set('Authorization', `Bearer ${staffToken()}`)
      .set('Idempotency-Key', `gate-cancel-${Date.now()}`)
      .send({ reason: 'Should be blocked' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_TENANT_READ_ONLY');
  });

  it('suspending tenant A never affects tenant B — cross-tenant isolation holds', async () => {
    await setStatus(ctx.a, 'suspended');
    expect((await readRequest(ctx.b)).status).toBe(200);
    expect((await writeRequest(ctx.b)).status).toBe(201);
  });

  it('reactivation (status flipped back to active) restores writes on the very next request', async () => {
    await setStatus(ctx.a, 'suspended');
    expect((await writeRequest()).status).toBe(403);
    await setStatus(ctx.a, 'active');
    expect((await writeRequest()).status).toBe(201);
  });

  // ------------------------------------------------------------------
  // tenant-resolution.js: reachability vs. write access are separate
  // questions (see that file's own header). Every one of `trial`/
  // `suspended`/`offboarding` must still be able to log in — reads and
  // writes are gated separately, below.
  // ------------------------------------------------------------------

  describe('login reachability by tenant status', () => {
    const DEV_PASSWORD = 'a fixture password long enough to pass validation';

    async function loginAs(tenant) {
      return t.request
        .post('/api/v1/auth/login')
        .set('X-Tenant-Slug', tenant.slug)
        .send({ email: tenant.users[0].email, password: DEV_PASSWORD });
    }

    it('a trial tenant can log in', async () => {
      await setStatus(ctx.a, 'trial', null);
      const res = await loginAs(ctx.a);
      expect(res.status).not.toBe(404);
    });

    it('a suspended tenant can log in (read-only, but reachable)', async () => {
      await setStatus(ctx.a, 'suspended');
      const res = await loginAs(ctx.a);
      expect(res.status).not.toBe(404);
    });

    // PLAN.md Phase 5 (tenant offboarding): `offboarding` used to be the
    // one status this describe block documented as a hard 404 block —
    // confirmed with the user before changing it, since a tenant mid-
    // offboarding must still be able to log in to see their request's
    // status and download their data export. Read-only enforcement is
    // proven separately, below (`isTenantWriteBlocked` has treated
    // `offboarding` as write-blocked since it was added; this is the
    // first path that actually exercises that branch with a real
    // `offboarding` tenant).
    it('an offboarding tenant can log in (read-only, but reachable — same as suspended)', async () => {
      await setStatus(ctx.a, 'offboarding');
      const res = await loginAs(ctx.a);
      expect(res.status).not.toBe(404);
    });
  });

  it('an offboarding tenant is read-only, exactly like suspended', async () => {
    await setStatus(ctx.a, 'offboarding');
    expect((await readRequest()).status).toBe(200);
    const writeRes = await writeRequest();
    expect(writeRes.status).toBe(403);
    expect(writeRes.body.error.code).toBe('FORBIDDEN_TENANT_READ_ONLY');
  });
});
