'use strict';

/**
 * Gap closure (user-reported): a housekeeping-role account could create/
 * reassign attendant assignments, resolve discrepancies, and take rooms
 * out of/back into service — all supervisor decisions, per PRODUCT_
 * REQUIREMENTS.md §3.6's own framing of a housekeeper's job as cleaning
 * the rooms assigned to them and reporting status, not coordinating other
 * attendants. `SECURITY.md` §5's own matrix had documented the Housekeeping
 * role's `✓` as deliberate (`20260907095000_seed_housekeeping_permissions.js`'s
 * own header says so) — this was a real, if now-corrected, design decision
 * from Phase 3, not a regression the empty-room-picker fix introduced.
 *
 * `housekeeping.manage` stays exactly what it already gates (assignment
 * create/reassign, discrepancy resolve, out-of-order create/close) — it
 * simply stops being granted to the `housekeeping` role. A new
 * `housekeeping.operate` key (naming mirrors `pos.operate`'s own precedent
 * for "do your own front-line job") covers the narrower, self-service
 * actions a housekeeper keeps: report a room's status, and progress the
 * status of their OWN assignment (`src/modules/housekeeping/service.js`'s
 * new ownership checks — a permission key alone can't express "only your
 * own row," so `reportRoomStatus`/`updateAssignment`'s status path also
 * verify `attendant_user_id === context.userId` for anyone who holds only
 * `.operate`, not `.manage`).
 *
 * `manager`/`admin`/`super_admin` get BOTH keys, the identical shape
 * `pos.operate`+`pos.manage` already established for manager in
 * `default-rbac.js` — a supervisor can still do their own spot-check
 * without needing `.manage`'s broader reach for every route.
 *
 * ── THE GENUINELY NEW PART OF THIS MIGRATION ───────────────────────────
 *
 * Every permission-seed migration in this codebase's history so far has
 * only ever ADDED a grant to a role that didn't have it yet — this is the
 * first that also REVOKES an already-granted permission from a role that
 * already had it, on every existing tenant. `role_permissions` has no
 * softer "reduce scope" concept; the grant row for (housekeeping role,
 * housekeeping.manage) is deleted outright, tenant by tenant, the same
 * way `down()` below reverses a grant this migration itself adds. `down()`
 * restores the original state exactly: drops `housekeeping.operate`
 * (key and every grant of it) and re-grants `housekeeping.manage` back to
 * the `housekeeping` role.
 */

const NEW_PERMISSIONS = [
  {
    permission_key: 'housekeeping.operate',
    name: 'Report room status and progress your own housekeeping assignments',
    domain: 'housekeeping',
  },
];
const NEW_KEYS = NEW_PERMISSIONS.map((row) => row.permission_key);
const OPERATE_BACKFILL_ROLE_CODES = ['housekeeping', 'manager', 'admin', 'super_admin'];
const REVOKE_MANAGE_FROM_ROLE_CODE = 'housekeeping';

exports.up = async function up(knex) {
  const existingKeys = await knex('permissions').whereIn('permission_key', NEW_KEYS).select('permission_key');
  const alreadyCatalogued = new Set(existingKeys.map((row) => row.permission_key));
  const toInsert = NEW_PERMISSIONS.filter((row) => !alreadyCatalogued.has(row.permission_key));
  if (toInsert.length) await knex('permissions').insert(toInsert);

  const operatePermission = await knex('permissions').where({ permission_key: 'housekeeping.operate' }).first('id');
  const manageRoleRows = await knex('roles')
    .whereIn('code', OPERATE_BACKFILL_ROLE_CODES)
    .select('id', 'tenant_id');

  if (manageRoleRows.length) {
    const existingGrants = await knex('role_permissions')
      .whereIn('role_id', manageRoleRows.map((row) => row.id))
      .where('permission_id', operatePermission.id)
      .select('role_id');
    const alreadyGranted = new Set(existingGrants.map((row) => row.role_id));

    const grants = manageRoleRows
      .filter((role) => !alreadyGranted.has(role.id))
      .map((role) => ({ tenant_id: role.tenant_id, role_id: role.id, permission_id: operatePermission.id }));
    if (grants.length) await knex('role_permissions').insert(grants);
  }

  // The revoke: narrows housekeeping.manage off the housekeeping role only
  // — manager/admin/super_admin keep it, untouched.
  const manageePermission = await knex('permissions').where({ permission_key: 'housekeeping.manage' }).first('id');
  if (manageePermission) {
    const housekeepingRoleIds = await knex('roles')
      .where({ code: REVOKE_MANAGE_FROM_ROLE_CODE })
      .select('id');
    if (housekeepingRoleIds.length) {
      await knex('role_permissions')
        .whereIn('role_id', housekeepingRoleIds.map((row) => row.id))
        .where('permission_id', manageePermission.id)
        .delete();
    }
  }
};

exports.down = async function down(knex) {
  // Restore housekeeping.manage on the housekeeping role.
  const manageePermission = await knex('permissions').where({ permission_key: 'housekeeping.manage' }).first('id');
  if (manageePermission) {
    const housekeepingRoleRows = await knex('roles')
      .where({ code: REVOKE_MANAGE_FROM_ROLE_CODE })
      .select('id', 'tenant_id');
    if (housekeepingRoleRows.length) {
      const existingGrants = await knex('role_permissions')
        .whereIn('role_id', housekeepingRoleRows.map((row) => row.id))
        .where('permission_id', manageePermission.id)
        .select('role_id');
      const alreadyGranted = new Set(existingGrants.map((row) => row.role_id));
      const grants = housekeepingRoleRows
        .filter((role) => !alreadyGranted.has(role.id))
        .map((role) => ({ tenant_id: role.tenant_id, role_id: role.id, permission_id: manageePermission.id }));
      if (grants.length) await knex('role_permissions').insert(grants);
    }
  }

  const permissionRows = await knex('permissions').whereIn('permission_key', NEW_KEYS).select('id');
  const permissionIds = permissionRows.map((row) => row.id);
  if (permissionIds.length) await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  await knex('permissions').whereIn('permission_key', NEW_KEYS).delete();
};
