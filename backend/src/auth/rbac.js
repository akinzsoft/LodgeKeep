'use strict';

/**
 * RBAC middleware — SECURITY.md §5's authorization matrix.
 *
 *   "Every endpoint is checked against this matrix, not against role name
 *    alone — a role check without a matrix behind it tends to drift as
 *    endpoints are added."
 *
 * `authenticate(audience)` (`middleware.js`) answers "who is this, and is
 * their account still live" — that is all it does today, and PLAN.md's Phase
 * 0 gate is explicit that authentication alone is not authorization. This
 * file is the other half: `requirePermission(key)` answers "does the role
 * this user holds *at the active property* actually grant this specific
 * permission," checked fresh against `role_permissions` on every request.
 *
 * ── WHY A PERMISSION KEY, NOT A ROLE NAME ──────────────────────────────────
 *
 * `if (role === 'manager')` is exactly the shortcut CLAUDE.md and SECURITY.md
 * §5 both rule out — it hardcodes today's matrix into every call site, so the
 * matrix can only ever change by hunting down every `if`. A permission key
 * checked against data (`role_permissions`) means the matrix lives in one
 * place and a role's access changes by changing a grant, not a deploy. There
 * is deliberately no `requireRole()` alongside this — a role check without
 * the matrix behind it is the anti-pattern §5 names.
 *
 * ── WHAT "SEEDED" MEANS RIGHT NOW ──────────────────────────────────────────
 *
 * §5's "Limited" access is explicitly "defined per endpoint at implementation
 * time... written down in that module's own doc" — and six of the matrix's
 * seven domains (Reservations, Front Desk, Housekeeping, POS, Reports, Setup)
 * have no endpoints or module doc yet (PLAN.md Phase 1+). This file is
 * therefore the enforcement *mechanism*, proven against a representative
 * permission catalogue seeded by `tests/auth/rbac.test.js` itself — not the
 * literal, final §5 catalogue, which arrives one key at a time as each real
 * module lands and writes down its own "Limited" rule. Building that catalogue
 * now would mean inventing business rules a real module doc is supposed to
 * own, ahead of the module (CLAUDE.md: "building ahead of PLAN.md's current
 * phase is the most likely way to waste effort here").
 */

const { scopedDb } = require('../db');
const { roleAtProperty } = require('./roles');
const { NoActivePropertyError, PermissionDeniedError } = require('./errors');

/**
 * Whether `roleCode` grants `permissionKey` for the tenant the context
 * belongs to. A three-table join, not three round trips: `role_permissions`
 * (TENANT_SCOPED) joined to `roles` (TENANT_SCOPED, for the human-readable
 * code and its own `active` check) joined to `permissions` (GLOBAL_REFERENCE,
 * the shared catalogue). `joinScoped` applies each joined table's own scope
 * requirement in the ON clause — `roles` gets `tenant_id = context.tenantId`
 * there, `permissions` gets nothing, because a GLOBAL_REFERENCE table has no
 * tenant dimension to add (`src/modules/tenancy/scoped-db.js`).
 *
 * Exported so a future RBAC-aware admin screen ("what can this role do") can
 * ask the same question `requirePermission` does, rather than a parallel
 * reimplementation drifting from it.
 */
async function hasPermission(db, roleCode, permissionKey) {
  const grant = await db
    .table('role_permissions')
    .joinScoped('roles', (join) => join.on('role_permissions.role_id', '=', 'roles.id'))
    .joinScoped('permissions', (join) => join.on('role_permissions.permission_id', '=', 'permissions.id'))
    .where('roles.code', roleCode)
    .where('roles.status', 'active')
    .where('permissions.permission_key', permissionKey)
    .first('role_permissions.id');

  return Boolean(grant);
}

/**
 * `requirePermission(permissionKey)` — mount after `authenticate('staff')`,
 * which is what supplies `req.context`.
 *
 * Three checks, each a distinct 403 (API.md §3's `FORBIDDEN_` prefix), each
 * re-verified from the database on every request rather than trusted from a
 * token claim — the same "nothing about authorization survives past the
 * moment it's checked" discipline `roles.js` and `middleware.js`'s live
 * status check already apply:
 *
 *   1. Is there an active property at all? (SECURITY.md §3)
 *   2. Does this user hold a role there? (SECURITY.md §3 — re-verified,
 *      never trusted from the token, exactly like a property switch)
 *   3. Does that role grant this permission? (SECURITY.md §5)
 */
/**
 * Every permission key a role holds — the same role_permissions → roles →
 * permissions join `hasPermission` checks one key against, so the list the
 * UI filters its navigation by can never disagree with what the API
 * actually enforces. An archived role grants nothing, exactly as above.
 */
async function listGrantedPermissions(db, roleCode) {
  const rows = await db
    .table('role_permissions')
    .joinScoped('roles', (join) => join.on('role_permissions.role_id', '=', 'roles.id'))
    .joinScoped('permissions', (join) => join.on('role_permissions.permission_id', '=', 'permissions.id'))
    .where('roles.code', roleCode)
    .where('roles.status', 'active')
    .select('permissions.permission_key');

  return [...new Set(rows.map((row) => row.permission_key))].sort();
}

/**
 * What the signed-in staff member may do at their active property — role
 * plus granted permission keys. UI-level RBAC (a filtered sidebar) is
 * convenience only; `requirePermission` above stays the real enforcement.
 *
 * - No active property yet (a multi-property user who hasn't picked one):
 *   no role, no permissions — every gated item hides, matching the
 *   `NoActivePropertyError` the API itself would return.
 * - Platform impersonation: `requirePermission` lets every check through
 *   (the impersonation guard separately blocks all writes), so the honest
 *   answer is the whole catalogue.
 */
async function resolveMyPermissions(context) {
  const db = scopedDb().for(context);

  if (context.isImpersonation) {
    const rows = await db.table('permissions').select('permission_key');
    return { role: 'platform_impersonation', permissions: rows.map((row) => row.permission_key).sort() };
  }

  if (!context.propertyId) return { role: null, permissions: [] };

  const role = await roleAtProperty(db, context, context.userId, context.propertyId);
  if (!role) return { role: null, permissions: [] };

  return { role, permissions: await listGrantedPermissions(db, role) };
}

/**
 * The three checks `requirePermission`'s middleware runs, factored out so a
 * caller that already holds `req`/`res`/`next` (the ordinary route-gating
 * case) and a caller that needs the same answer as a plain boolean-or-throw
 * inside business logic (`setup/service.js`'s `createProperty` — see that
 * function's own header for why a fixed route-level gate can't express its
 * "before any grant can exist" bootstrap case) share one implementation
 * rather than drifting apart. Returns the resolved role on success; throws
 * `NoActivePropertyError`/`PermissionDeniedError` exactly as documented on
 * `requirePermission` below.
 */
async function assertPermission(context, permissionKey) {
  // PLAN.md Phase 5 (Platform Foundation): an impersonating platform admin
  // holds no `user_property_access` row in the impersonated tenant at all —
  // see `requirePermission`'s own comment for the full reasoning.
  if (context.isImpersonation) return 'platform_impersonation';

  if (!context.propertyId) throw new NoActivePropertyError();

  const db = scopedDb().for(context);
  const role = await roleAtProperty(db, context, context.userId, context.propertyId);
  // Not merely defensive: a grant can be revoked between login and this
  // request, and SECURITY.md §3 requires that to bite immediately.
  if (!role) throw new PermissionDeniedError(permissionKey, null);

  const granted = await hasPermission(db, role, permissionKey);
  if (!granted) throw new PermissionDeniedError(permissionKey, role);

  return role;
}

function requirePermission(permissionKey) {
  return async function requirePermissionMiddleware(req, res, next) {
    try {
      req.role = await assertPermission(req.context, permissionKey);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { requirePermission, assertPermission, hasPermission, listGrantedPermissions, resolveMyPermissions };
