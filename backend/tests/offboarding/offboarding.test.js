'use strict';

/**
 * Tenant self-service offboarding — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md
 * §3.22. The tenant-initiated half of `src/modules/offboarding/service.js`;
 * the platform-initiated half (`offboardTenant`) is covered by
 * `tests/platform/lifecycle.test.js`'s own "offboard" describe block.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants, seedPlatformUser } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Tenant offboarding — self-service (PLAN.md Phase 5)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);

    // The base fixture's own grantPlan gives user 0 `manager` (property 0)
    // and `front_desk` (property 1), and user 1 `housekeeping` (property 0)
    // — no `admin`/`super_admin` grant exists yet for either tenant. User 1
    // holds no grant at all at property 1, so it's free to become this
    // suite's real admin-tier account without colliding with the base
    // fixture's own per-(user, property) uniqueness.
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('user_property_access').insert({
        tenant_id: tenant.id,
        user_id: tenant.users[1].id,
        property_id: tenant.properties[1].id,
        role: 'admin',
      });
    }
  });

  function adminToken(tenant = ctx.a) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[1].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[1].id),
    });
  }

  function managerToken(tenant = ctx.a) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[0].id),
    });
  }

  afterEach(async () => {
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('tenants').where({ id: tenant.id }).update({ status: 'active', offboarding_requested_at: null, retention_expires_at: null });
    }
  });

  it('a manager without offboarding.manage is refused requesting offboarding', async () => {
    const res = await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${managerToken()}`).send({ reason: 'Should be refused' });
    expect(res.status).toBe(403);
  });

  it('an admin can request offboarding — status transitions, the 30-day retention date is set, and an export attempt is created', async () => {
    const res = await t.request
      .post('/api/v1/offboarding/request')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'Moving to a different PMS' });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('offboarding');
    expect(res.body.data.exportId).toBeTruthy();

    const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first();
    expect(tenant.status).toBe('offboarding');
    expect(tenant.offboarding_requested_at).toBeTruthy();
    expect(tenant.retention_expires_at).toBeTruthy();
    const days = (new Date(tenant.retention_expires_at).getTime() - new Date(tenant.offboarding_requested_at).getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(30);

    const exportRow = await t.trx('tenant_data_exports').where({ id: res.body.data.exportId }).first();
    expect(String(exportRow.tenant_id)).toBe(String(ctx.a.id));
    expect(String(exportRow.requested_by_user_id)).toBe(String(ctx.a.users[1].id));
    expect(exportRow.requested_by_platform_user_id).toBeNull();
    expect(exportRow.status).toBe('pending');
    expect(exportRow.reason).toBe('Moving to a different PMS');

    const entry = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'tenants', action: 'offboard_request' }).orderBy('id', 'desc').first();
    expect(entry).toBeTruthy();
    expect(entry.after_state).toEqual({ status: 'offboarding' });
  });

  it('an already-offboarding tenant cannot request offboarding again — invalid transition', async () => {
    await t.trx('tenants').where({ id: ctx.a.id }).update({ status: 'offboarding' });
    const res = await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken()}`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_TENANT_TRANSITION');
  });

  it('a suspended tenant can still self-request offboarding — not stuck fully blocked with no way out', async () => {
    await t.trx('tenants').where({ id: ctx.a.id }).update({ status: 'suspended' });
    const res = await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken()}`).send({});
    expect(res.status).toBe(201);
  });

  it('GET /offboarding/status reports the real state, including the latest export attempt', async () => {
    await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken()}`).send({ reason: 'Testing status read' });
    const res = await t.request.get('/api/v1/offboarding/status').set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('offboarding');
    expect(res.body.data.latestExport).toBeTruthy();
    expect(res.body.data.latestExport.status).toBe('pending');
  });

  it('GET /offboarding/status reflects an active tenant with no export history as a plain, un-alarming read', async () => {
    // Tenant B specifically — every earlier test in this file exercises
    // tenant A's own request/status flow, and this suite shares one
    // transaction per file (not per test), so tenant A already has export
    // rows by this point. Tenant B has none yet.
    const res = await t.request.get('/api/v1/offboarding/status').set('Authorization', `Bearer ${adminToken(ctx.b)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.latestExport).toBeNull();
  });

  it('status, request, and retry all stay reachable once the tenant is already offboarding — the whole reason this module carves out of the read-only gate', async () => {
    const requestRes = await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken()}`).send({});
    const exportId = requestRes.body.data.exportId;
    await t.trx('tenant_data_exports').where({ id: exportId }).update({ status: 'failed' });

    const statusRes = await t.request.get('/api/v1/offboarding/status').set('Authorization', `Bearer ${adminToken()}`);
    expect(statusRes.status).toBe(200);

    const retryRes = await t.request.post(`/api/v1/offboarding/exports/${exportId}/retry`).set('Authorization', `Bearer ${adminToken()}`).send({});
    expect(retryRes.status).toBe(201);

    // A genuine, ordinary business write is still correctly blocked in the same state.
    const blockedRes = await t.request
      .post('/api/v1/market-segments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Should be blocked', code: `offb-${Date.now()}` });
    expect(blockedRes.status).toBe(403);
    expect(blockedRes.body.error.code).toBe('FORBIDDEN_TENANT_READ_ONLY');
  });

  it('retrying a non-failed export is rejected', async () => {
    const requestRes = await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken()}`).send({});
    const exportId = requestRes.body.data.exportId;
    const res = await t.request.post(`/api/v1/offboarding/exports/${exportId}/retry`).set('Authorization', `Bearer ${adminToken()}`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_EXPORT_NOT_RETRYABLE');
  });

  it('retrying a failed export creates a fresh pending attempt carrying the same reason, not a mutation of the old row', async () => {
    const requestRes = await t.request
      .post('/api/v1/offboarding/request')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'Original reason' });
    const exportId = requestRes.body.data.exportId;
    await t.trx('tenant_data_exports').where({ id: exportId }).update({ status: 'failed', failed_reason: 'Simulated failure' });

    const res = await t.request.post(`/api/v1/offboarding/exports/${exportId}/retry`).set('Authorization', `Bearer ${adminToken()}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.id).not.toBe(String(exportId));
    expect(res.body.data.reason).toBe('Original reason');

    const oldRow = await t.trx('tenant_data_exports').where({ id: exportId }).first();
    expect(oldRow.status).toBe('failed'); // untouched — a fresh row, never a mutation
  });

  it('retrying a platform-initiated failed export attributes the fresh attempt to the retrying tenant user, never both actors at once', async () => {
    // Simulates a failed export originally created by the PLATFORM-initiated
    // path (`platform/service.js`'s `offboardTenant`) — the tenant's own
    // admin is the one who sees it fail and retries it, since offboarding
    // stays reachable/read-only regardless of which side triggered it.
    const platformUser = await seedPlatformUser(t.trx, 'ops-retry-test@planmsys.test', 'admin');
    const [platformInitiatedExportId] = await t.trx('tenant_data_exports').insert({
      tenant_id: ctx.a.id,
      status: 'failed',
      requested_by_user_id: null,
      requested_by_platform_user_id: platformUser.id,
      reason: 'Platform-initiated',
    });

    const res = await t.request
      .post(`/api/v1/offboarding/exports/${platformInitiatedExportId}/retry`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(201);

    const freshRow = await t.trx('tenant_data_exports').where({ id: res.body.data.id }).first();
    expect(String(freshRow.requested_by_user_id)).toBe(String(ctx.a.users[1].id));
    expect(freshRow.requested_by_platform_user_id).toBeNull(); // never both — see the invariant this table's own migration documents
  });

  it('retrying a cross-tenant or nonexistent export id is a 404, never a leak', async () => {
    const bRequestRes = await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken(ctx.b)}`).send({});
    const bExportId = bRequestRes.body.data.exportId;
    await t.trx('tenant_data_exports').where({ id: bExportId }).update({ status: 'failed' });

    const crossRes = await t.request.post(`/api/v1/offboarding/exports/${bExportId}/retry`).set('Authorization', `Bearer ${adminToken(ctx.a)}`).send({});
    expect(crossRes.status).toBe(404);

    const missingRes = await t.request.post('/api/v1/offboarding/exports/999999999/retry').set('Authorization', `Bearer ${adminToken(ctx.a)}`).send({});
    expect(missingRes.status).toBe(404);
  });

  describe('download', () => {
    it('a completed export downloads the real file and marks downloaded_at', async () => {
      const requestRes = await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken()}`).send({});
      const exportId = requestRes.body.data.exportId;

      const filePath = path.join(os.tmpdir(), `offboarding-test-export-${exportId}.json`);
      fs.writeFileSync(filePath, JSON.stringify({ tenant: { id: ctx.a.id } }));

      await t.trx('tenant_data_exports').where({ id: exportId }).update({
        status: 'completed',
        file_path: filePath,
        file_size_bytes: fs.statSync(filePath).size,
        completed_at: new Date(),
      });

      const res = await t.request.get(`/api/v1/offboarding/exports/${exportId}/download`).set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.headers['content-disposition']).toMatch(new RegExp(`tenant-${ctx.a.id}-export-${exportId}\\.json`));

      const row = await t.trx('tenant_data_exports').where({ id: exportId }).first();
      expect(row.downloaded_at).toBeTruthy();

      fs.unlinkSync(filePath);
    });

    it('a not-yet-completed export refuses to download', async () => {
      const requestRes = await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken()}`).send({});
      const exportId = requestRes.body.data.exportId;
      const res = await t.request.get(`/api/v1/offboarding/exports/${exportId}/download`).set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_EXPORT_NOT_DOWNLOADABLE');
    });

    it('a cross-tenant or nonexistent export id is a 404', async () => {
      const bRequestRes = await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken(ctx.b)}`).send({});
      const bExportId = bRequestRes.body.data.exportId;

      const crossRes = await t.request.get(`/api/v1/offboarding/exports/${bExportId}/download`).set('Authorization', `Bearer ${adminToken(ctx.a)}`);
      expect(crossRes.status).toBe(404);

      const missingRes = await t.request.get('/api/v1/offboarding/exports/999999999/download').set('Authorization', `Bearer ${adminToken(ctx.a)}`);
      expect(missingRes.status).toBe(404);
    });
  });

  it('offboarding tenant A never affects tenant B — cross-tenant isolation holds', async () => {
    await t.request.post('/api/v1/offboarding/request').set('Authorization', `Bearer ${adminToken(ctx.a)}`).send({});
    const bTenant = await t.trx('tenants').where({ id: ctx.b.id }).first();
    expect(bTenant.status).toBe('active');
    const bStatusRes = await t.request.get('/api/v1/offboarding/status').set('Authorization', `Bearer ${adminToken(ctx.b)}`);
    expect(bStatusRes.body.data.status).toBe('active');
  });
});
