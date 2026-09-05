'use strict';

/**
 * RBAC middleware — SECURITY.md §5, PLAN.md's Phase 0 gate ("RBAC: each role
 * against each seeded endpoint, asserting the negative cases").
 *
 * No real business endpoints exist yet (Reservations, Front Desk, Cashiering,
 * ... are Phase 1/2), so this file seeds its own representative permission
 * catalogue and mounts synthetic routes standing in for each §5 domain — the
 * same pattern `tests/isolation/scoped-accessor.test.js` already uses for the
 * tenancy layer with no real tables. It is not the literal §5 matrix (see
 * `src/auth/rbac.js`'s header for why that would be building ahead of the
 * modules that are supposed to define it); it is every ACCESS SHAPE the
 * matrix uses — full (✓), partial (Limited/Read), and none (✗) — proven
 * against the real `permissions` / `role_permissions` / `user_property_access`
 * schema, for all seven SECURITY.md §5 roles.
 *
 * Access tokens are minted directly (`signAccessToken`), not through
 * `/auth/login` — login's own behaviour (including the MFA challenge that
 * admin/super_admin would hit) is `tests/auth/auth.test.js`'s job. This file
 * tests one thing: given a valid, authenticated context, does
 * `requirePermission` enforce the matrix.
 */

const express = require('express');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants, PASSWORD_HASH } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { requestId } = require('../../src/shared/request-id');
const { errorHandler } = require('../../src/shared/error-handler');
const { authenticate, requirePermission } = require('../../src/auth');

/**
 * The representative catalogue — one or two keys per §5 domain, enough to
 * exercise every access shape without inventing "Limited" business rules a
 * real module doc is supposed to own.
 */
const PERMISSIONS = [
  { key: 'reservations.read', domain: 'reservations' },
  { key: 'reservations.manage', domain: 'reservations' },
  { key: 'front_desk.manage', domain: 'front_desk' },
  { key: 'cashiering.post_charge', domain: 'cashiering' },
  { key: 'cashiering.void_line', domain: 'cashiering' },
  { key: 'housekeeping.manage', domain: 'housekeeping' },
  { key: 'pos.manage', domain: 'pos' },
  { key: 'reports.view_financial', domain: 'reports' },
  { key: 'setup.view', domain: 'setup' },
  { key: 'setup.manage', domain: 'setup' },
];

/** One synthetic route per key, mounted under /_test. */
const ROUTE_OF = Object.fromEntries(
  PERMISSIONS.map(({ key }) => [key, `/_test/${key.replace('.', '/')}`])
);

/**
 * The grant matrix for this pass — SECURITY.md §5's shape, not its literal
 * cell-by-cell content (see the file header). Every role gets at least one
 * full-domain ✓, one ✗, and the two multi-key domains (cashiering, setup)
 * carry a genuine partial grant each, which is the one case that actually
 * proves a role isn't just "on" or "off" per domain.
 */
const GRANTS = {
  front_desk: [
    'reservations.read',
    'reservations.manage',
    'front_desk.manage',
    'cashiering.post_charge', // Limited — SECURITY.md §5's own example: "post-a-charge, not void-a-line"
    'reports.view_financial',
  ],
  cashier: ['reservations.read', 'cashiering.post_charge', 'cashiering.void_line', 'reports.view_financial'],
  housekeeping: ['housekeeping.manage'],
  pos_operator: ['pos.manage'],
  manager: [
    'reservations.read',
    'reservations.manage',
    'front_desk.manage',
    'cashiering.post_charge',
    'cashiering.void_line',
    'housekeeping.manage',
    'pos.manage',
    'reports.view_financial',
    'setup.view', // Limited — manager does not get setup.manage
  ],
  admin: PERMISSIONS.map((p) => p.key), // ✓ across every domain
  super_admin: PERMISSIONS.map((p) => p.key), // ✓ (+ billing/cross-property — no such keys exist yet)
};

const ROLES = Object.keys(GRANTS);

/**
 * The one deliberate departure from GRANTS: tenant A's cashier ALSO gets
 * setup.view (seeded in beforeAll, granted to tenant A only), so the matrix
 * below expects it for `usersByRole.cashier` — a tenant A user — while the
 * shared per-tenant grant loop leaves both tenants' cashier role identical
 * otherwise. "does not let a cross-tenant divergence leak the other way"
 * proves tenant B's cashier does NOT have it, with its own separate user.
 */
const EXPECTED_OVERRIDES = { cashier: { 'setup.view': true } };

function expectedFor(role, key) {
  return EXPECTED_OVERRIDES[role]?.[key] ?? GRANTS[role].includes(key);
}

function buildRbacTestApp() {
  const app = express();
  app.use(requestId());
  const router = express.Router();
  for (const { key } of PERMISSIONS) {
    router.get(ROUTE_OF[key], authenticate('staff'), requirePermission(key), (req, res) => {
      res.status(200).json({ data: { ok: true, role: req.role }, meta: {}, error: null });
    });
  }
  app.use(router);
  app.use((req, res) => res.status(404).json({ data: null, meta: {}, error: null }));
  app.use(errorHandler);
  return app;
}

describe('RBAC middleware (SECURITY.md §5)', () => {
  const t = useTestApp();
  let ctx;
  let usersByRole; // { [role]: { id, token } }, tenant A only unless noted
  let request;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    request = require('supertest')(buildRbacTestApp());

    // seedTwoTenants already seeds several of these keys as its own
    // GLOBAL_REFERENCE fixture data (cashiering.post_charge,
    // cashiering.void_line, reports.view_financial) and already grants
    // tenant.roles.manager -> cashiering.void_line for both tenants — reused
    // rather than re-inserted, since `permissions.permission_key` and
    // `role_permissions(role_id, permission_id)` are both globally/per-tenant
    // unique and a second insert of the same row is exactly the collision
    // those constraints exist to catch.
    //
    // `ctx.permissions` alone is not a reliable "already exists" check,
    // though: `housekeeping.manage` is neither a fixtures.js lookup key nor
    // this test's own prior insert, but a REAL migration
    // (20260907095000_seed_housekeeping_permissions.js) now seeds it
    // globally before this test ever runs — the exact class of collision
    // `20260905095000_seed_setup_permissions.js`'s own header already
    // describes fixing for `setup.view`/`.manage`. Select-or-insert against
    // the database directly, not just against the fixture's own return
    // value, so this composes with any permission key a real module's
    // migration seeds, present or future.
    const permissionIds = { ...ctx.permissions };
    for (const { key, domain } of PERMISSIONS) {
      if (permissionIds[key]) continue;
      const existing = await t.trx('permissions').where({ permission_key: key }).first('id');
      permissionIds[key] = existing ? existing.id : (await t.trx('permissions').insert({ permission_key: key, name: key, domain }))[0];
    }
    ctx.rbacPermissionIds = permissionIds;

    async function grantRole(tenant, roleCode, keys) {
      const roleId = tenant.roles[roleCode];
      const existing = await t
        .trx('role_permissions')
        .where({ tenant_id: tenant.id, role_id: roleId })
        .whereIn('permission_id', keys.map((key) => permissionIds[key]));
      // String comparison, not numeric: bigNumberStrings (knexfile.js) means a
      // SELECT returns permission_id as a string, while the ids this file
      // tracked from an INSERT's return value are plain JS numbers — a Set
      // built from one and checked against the other would never match.
      const already = new Set(existing.map((row) => String(row.permission_id)));

      const rows = keys
        .filter((key) => !already.has(String(permissionIds[key])))
        .map((key) => ({ tenant_id: tenant.id, role_id: roleId, permission_id: permissionIds[key] }));
      if (rows.length) await t.trx('role_permissions').insert(rows);
    }

    for (const role of ROLES) {
      await grantRole(ctx.a, role, GRANTS[role]);
      await grantRole(ctx.b, role, GRANTS[role]);
    }

    // One deliberate cross-tenant divergence: tenant A's cashier ALSO gets
    // setup.view, tenant B's does not — proves the join is genuinely
    // tenant-scoped, not keyed by role code alone (two tenants both define a
    // 'cashier' role; only one of them grants this).
    await grantRole(ctx.a, 'cashier', ['setup.view']);

    usersByRole = {};
    for (const role of ROLES) {
      const [userId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email: `${role}@rbac.example.com`,
        password_hash: PASSWORD_HASH,
        first_name: role,
        last_name: 'User',
        status: 'active',
      });
      await t.trx('user_property_access').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        user_id: userId,
        role,
      });
      const token = signAccessToken({
        aud: 'staff',
        sub: String(userId),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
      usersByRole[role] = { id: userId, token };
    }
  });

  const asRole = (role) => `Bearer ${usersByRole[role].token}`;

  // ==================================================================
  // The full matrix: every role against every seeded endpoint.
  // ==================================================================
  describe('every role against every seeded endpoint', () => {
    const cases = ROLES.flatMap((role) =>
      PERMISSIONS.map(({ key }) => [role, key, expectedFor(role, key)])
    );

    it.each(cases)('%s -> %s: granted=%s', async (role, key, granted) => {
      const res = await request.get(ROUTE_OF[key]).set('Authorization', asRole(role));
      if (granted) {
        expect(res.status).toBe(200);
        expect(res.body.data.role).toBe(role);
      } else {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
        expect(res.body.error.details).toMatchObject({ permission: key });
      }
    });
  });

  // ==================================================================
  // Negative cases named explicitly, not just implied by the matrix above.
  // ==================================================================
  describe('negative cases', () => {
    it('refuses a caller with no active property, before checking any grant', async () => {
      const [userId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email: 'no-property@rbac.example.com',
        password_hash: PASSWORD_HASH,
        first_name: 'No',
        last_name: 'Property',
        status: 'active',
      });
      await t.trx('user_property_access').insert([
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, user_id: userId, role: 'manager' },
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[1].id, user_id: userId, role: 'manager' },
      ]);
      // No property_id claim — two properties, none chosen (SECURITY.md §3).
      const token = signAccessToken({
        aud: 'staff',
        sub: String(userId),
        tenant_id: String(ctx.a.id),
        property_id: null,
      });

      const res = await request.get(ROUTE_OF['reservations.read']).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_NO_ACTIVE_PROPERTY');
    });

    it('does not let a cross-tenant divergence leak the other way', async () => {
      // Tenant B's cashier was NOT granted setup.view (only tenant A's was).
      const [userId] = await t.trx('users').insert({
        tenant_id: ctx.b.id,
        email: 'cashier-b@rbac.example.com',
        password_hash: PASSWORD_HASH,
        first_name: 'Cashier',
        last_name: 'B',
        status: 'active',
      });
      await t.trx('user_property_access').insert({
        tenant_id: ctx.b.id,
        property_id: ctx.b.properties[0].id,
        user_id: userId,
        role: 'cashier',
      });
      const token = signAccessToken({
        aud: 'staff',
        sub: String(userId),
        tenant_id: String(ctx.b.id),
        property_id: String(ctx.b.properties[0].id),
      });

      const res = await request.get(ROUTE_OF['setup.view']).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('revokes access on the very next request once a grant is removed mid-session', async () => {
      const before = await request
        .get(ROUTE_OF['housekeeping.manage'])
        .set('Authorization', asRole('housekeeping'));
      expect(before.status).toBe(200);

      await t.trx('role_permissions')
        .where({ tenant_id: ctx.a.id, role_id: ctx.a.roles.housekeeping })
        .del();

      const after = await request
        .get(ROUTE_OF['housekeeping.manage'])
        .set('Authorization', asRole('housekeeping'));
      expect(after.status).toBe(403);

      // Restore, so this test does not leak into the matrix cases around it —
      // Jest does not guarantee this file's `it`s run in a strict order every
      // reader can assume, and the matrix block above depends on the seeded
      // grant still being there.
      await t.trx('role_permissions').insert({
        tenant_id: ctx.a.id,
        role_id: ctx.a.roles.housekeeping,
        permission_id: ctx.rbacPermissionIds['housekeeping.manage'],
      });
    });

    it('stops granting through an archived role definition, even though the grant row still exists', async () => {
      await t.trx('roles').where({ id: ctx.a.roles.pos_operator }).update({ status: 'archived' });

      const res = await request.get(ROUTE_OF['pos.manage']).set('Authorization', asRole('pos_operator'));
      expect(res.status).toBe(403);

      await t.trx('roles').where({ id: ctx.a.roles.pos_operator }).update({ status: 'active' });
    });

    it('rejects an unauthenticated request before ever reaching the permission check', async () => {
      const res = await request.get(ROUTE_OF['reservations.read']);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_UNAUTHENTICATED');
    });
  });
});
