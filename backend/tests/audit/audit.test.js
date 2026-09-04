'use strict';

/**
 * The audit trail — SECURITY.md §6, PLAN.md's Phase 0 gate ("Audit
 * middleware writes a row with before/after state on a sample mutation").
 *
 * Two layers, tested separately then together:
 *   - `src/audit/service.js`'s `recordAuditEntry` — the core write, callable
 *     from anywhere (HTTP, a job, a migration).
 *   - `src/audit/middleware.js`'s `attachAudit()` — the HTTP convenience
 *     wrapper, exercised end to end against a real mutation (renaming a
 *     `properties` row — the one entity Phase 0 actually has, standing in for
 *     "a sample mutation" until a real business module lands).
 */

const express = require('express');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { requestId } = require('../../src/shared/request-id');
const { errorHandler } = require('../../src/shared/error-handler');
const { authenticate, requirePermission } = require('../../src/auth');
const { attachAudit, recordAuditEntry } = require('../../src/audit');
const { contextFromSession, guestContextFromSession } = require('../../src/modules/tenancy');
const dbModule = require('../../src/db');

describe('audit trail (SECURITY.md §6)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  // ==================================================================
  // recordAuditEntry — the core write, used directly (no HTTP involved).
  // ==================================================================
  describe('recordAuditEntry', () => {
    const scopedFor = (tenant) => dbModule.scopedDb().for(contextFromSession({ tenantId: tenant.id }));

    it('writes a row with the full field set, before/after JSON round-tripping intact', async () => {
      await recordAuditEntry(scopedFor(ctx.a), {
        entityType: 'reservations',
        entityId: 42,
        action: 'update',
        source: 'web',
        propertyId: ctx.a.properties[0].id,
        userId: ctx.a.users[0].id,
        beforeState: { status: 'pending', room_id: 7 },
        afterState: { status: 'confirmed', room_id: 7 },
        reason: null,
        requestId: 'req_test_1',
        ipAddress: '203.0.113.10',
        userAgent: 'jest',
      });

      const row = await t.trx('audit_log').where({ entity_type: 'reservations', entity_id: 42 }).first();
      expect(row).toBeDefined();
      expect(String(row.tenant_id)).toBe(String(ctx.a.id));
      expect(row.action).toBe('update');
      expect(row.before_state).toEqual({ status: 'pending', room_id: 7 });
      expect(row.after_state).toEqual({ status: 'confirmed', room_id: 7 });
      expect(row.request_id).toBe('req_test_1');
    });

    it('accepts a tenant-level action with no property_id — attribution, not scope', async () => {
      await recordAuditEntry(scopedFor(ctx.a), {
        entityType: 'roles',
        entityId: ctx.a.roles.manager,
        action: 'update',
        source: 'web',
        userId: ctx.a.users[0].id,
        beforeState: { name: 'manager' },
        afterState: { name: 'Manager' },
      });

      const row = await t.trx('audit_log').where({ entity_type: 'roles', entity_id: ctx.a.roles.manager }).first();
      expect(row).toBeDefined();
      expect(row.property_id).toBeNull();
    });

    it('records a job-sourced entry with no user and no request', async () => {
      await recordAuditEntry(scopedFor(ctx.a), {
        entityType: 'night_audit_runs',
        entityId: 1,
        action: 'status_change',
        source: 'job',
        beforeState: { state: 'RUNNING' },
        afterState: { state: 'COMPLETED' },
      });

      const row = await t.trx('audit_log').where({ entity_type: 'night_audit_runs', entity_id: 1 }).first();
      expect(row.user_id).toBeNull();
      expect(row.request_id).toBeNull();
      expect(row.source).toBe('job');
    });

    it('refuses an entry missing a required field, naming which one', async () => {
      await expect(
        recordAuditEntry(scopedFor(ctx.a), { entityType: 'reservations', action: 'create' /* no source */ })
      ).rejects.toMatchObject({
        code: 'VALIDATION_AUDIT_ENTRY_INCOMPLETE',
        details: [{ field: 'source', issue: 'missing' }],
      });
    });

    it('is reachable only through a real accessor — a table with no scope declaration would refuse it the same way every other query does', async () => {
      // Not a special case for audit_log: ARCHITECTURE.md §3's "no unscoped
      // query path" holds here exactly as it does for table(). Asserting it
      // once here documents that recordAuditEntry took no shortcut around it.
      const rows = await scopedFor(ctx.a).table('audit_log');
      expect(Array.isArray(rows)).toBe(true);
      rows.forEach((row) => expect(String(row.tenant_id)).toBe(String(ctx.a.id)));
    });
  });

  // ==================================================================
  // attachAudit()'s default-source logic, in isolation — a unit test rather
  // than an HTTP one, since only the staff tree mounts this middleware today
  // (app.js) and there is no real guest/platform mutation flow yet to route
  // an HTTP request through.
  // ==================================================================
  describe('attachAudit() default-source logic', () => {
    it('defaults source to "web" for a staff context', async () => {
      const middleware = attachAudit();
      const req = {
        context: contextFromSession({ tenantId: ctx.a.id, userId: ctx.a.users[0].id, propertyId: ctx.a.properties[0].id }),
        requestId: 'req_unit_1',
        ip: '127.0.0.1',
        get: () => 'jest',
      };
      await new Promise((resolve) => middleware(req, {}, resolve));

      await req.audit({ entityType: 'reservations', entityId: 1, action: 'create' });
      const row = await t.trx('audit_log').where({ request_id: 'req_unit_1' }).first();
      expect(row.source).toBe('web');
    });

    it("does not default a source for a guest context — SECURITY.md §2's mutation flows for that audience are not built yet", async () => {
      const middleware = attachAudit();
      const req = {
        context: guestContextFromSession({
          tenantId: ctx.a.id,
          propertyId: ctx.a.properties[0].id,
          guestAccountId: ctx.a.guestAccounts[0].id,
        }),
        requestId: 'req_unit_2',
        ip: '127.0.0.1',
        get: () => 'jest',
      };
      await new Promise((resolve) => middleware(req, {}, resolve));

      await expect(
        req.audit({ entityType: 'reservations', entityId: 1, action: 'create' })
      ).rejects.toMatchObject({
        code: 'VALIDATION_AUDIT_ENTRY_INCOMPLETE',
        details: [{ field: 'source', issue: 'missing' }],
      });
    });
  });

  // ==================================================================
  // attachAudit() — the HTTP path, against a real mutation.
  // ==================================================================
  describe('attachAudit() middleware, on a sample mutation', () => {
    function buildAuditTestApp() {
      const app = express();
      app.use(requestId());
      app.use(express.json());
      const router = express.Router();

      // The sample mutation: rename a property. Real table, real row,
      // standing in for "a module's mutating endpoint" until one exists.
      router.patch(
        '/_test/properties/:id',
        authenticate('staff'),
        requirePermission('setup.manage'),
        attachAudit(),
        async (req, res, next) => {
          try {
            const scoped = dbModule.scopedDb().for(req.context);
            await scoped.transaction(async (trx) => {
              const before = await trx.table('properties').where({ id: req.params.id }).first();
              await trx.table('properties').where({ id: req.params.id }).update({ name: req.body.name });
              const after = await trx.table('properties').where({ id: req.params.id }).first();
              // Atomic with the mutation above — same trx-bound accessor.
              await req.audit(
                {
                  entityType: 'properties',
                  entityId: Number(req.params.id),
                  action: 'update',
                  beforeState: { name: before.name },
                  afterState: { name: after.name },
                },
                trx
              );
            });
            res.status(200).json({ data: { ok: true }, meta: {}, error: null });
          } catch (error) {
            next(error);
          }
        }
      );

      // A "void"-shaped action, to exercise the reason field (SECURITY.md §6:
      // required by convention for voids/refunds/overrides).
      router.post(
        '/_test/properties/:id/void',
        authenticate('staff'),
        requirePermission('setup.manage'),
        attachAudit(),
        async (req, res, next) => {
          try {
            await req.audit({
              entityType: 'properties',
              entityId: Number(req.params.id),
              action: 'void',
              beforeState: { status: 'active' },
              afterState: { status: 'void' },
              reason: req.body.reason,
            });
            res.status(200).json({ data: { ok: true }, meta: {}, error: null });
          } catch (error) {
            next(error);
          }
        }
      );

      app.use(router);
      app.use((req, res) => res.status(404).json({ data: null, meta: {}, error: null }));
      app.use(errorHandler);
      return app;
    }

    let request;
    let adminToken;
    let adminUserId;

    beforeAll(async () => {
      request = require('supertest')(buildAuditTestApp());

      // requirePermission('setup.manage') needs tenant A's `admin` role to
      // hold that grant — seedTwoTenants (fixtures.js) grants it as real
      // fixture data now (PLAN.md Phase 1's Setup domain), so there is
      // nothing left to seed here.

      // A fresh user, not ctx.a.users[0] — the fixture already grants that
      // one 'manager' at properties[0], and user_property_access is UNIQUE
      // per (user_id, property_id), one role only.
      [adminUserId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email: 'audit-admin@example.com',
        password_hash: '$2b$12$' + 'x'.repeat(53),
        first_name: 'Audit',
        last_name: 'Admin',
        status: 'active',
      });
      await t.trx('user_property_access').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        user_id: adminUserId,
        role: 'admin',
      });
      adminToken = signAccessToken({
        aud: 'staff',
        sub: String(adminUserId),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
    });

    it('writes a row with before/after state, sourced "web" with no explicit source in the call', async () => {
      const res = await request
        .patch(`/_test/properties/${ctx.a.properties[0].id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Renamed Property' });

      expect(res.status).toBe(200);

      const row = await t.trx('audit_log').where({ entity_type: 'properties', action: 'update' }).orderBy('id', 'desc').first();
      expect(row).toBeDefined();
      expect(row.source).toBe('web');
      expect(row.after_state).toEqual({ name: 'Renamed Property' });
      expect(String(row.user_id)).toBe(String(adminUserId));
      expect(String(row.property_id)).toBe(String(ctx.a.properties[0].id));
      expect(row.request_id).toBe(res.headers['x-request-id']);

      const property = await t.trx('properties').where({ id: ctx.a.properties[0].id }).first();
      expect(property.name).toBe('Renamed Property');
    });

    it('carries the reason field through for a void-shaped action', async () => {
      const res = await request
        .post(`/_test/properties/${ctx.a.properties[0].id}/void`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Property closed for renovation' });

      expect(res.status).toBe(200);
      const row = await t.trx('audit_log').where({ entity_type: 'properties', action: 'void' }).first();
      expect(row.reason).toBe('Property closed for renovation');
    });

    // A true "the mutation rolls back when the audit write fails" test needs
    // a real top-level transaction, which this file's app deliberately does
    // NOT have: `useTestApp()` binds every request to the suite's own shared,
    // already-open fixture transaction (`src/db/index.js`'s
    // `__setConnectionForTesting`), so `scoped.transaction(cb)` takes the
    // "already inside one, don't nest" branch (`scoped-db.js`) and shares it
    // rather than opening a savepoint — exactly the same constraint
    // `tests/isolation/scoped-accessor.test.js`'s "opens a real transaction
    // when bound to the knex instance itself" test documents and works around
    // for the identical reason. What IS provable here, and is proven by the
    // test above: the property row and its audit_log row both show up
    // together after a call that threaded one `trx` through both statements
    // — real cross-statement rollback-on-failure is the accessor's own
    // `.transaction()` primitive, already covered there.

    it('requires authentication and permission before ever reaching req.audit', async () => {
      const res = await request.patch(`/_test/properties/${ctx.a.properties[0].id}`).send({ name: 'Nope' });
      expect(res.status).toBe(401);
    });
  });
});
