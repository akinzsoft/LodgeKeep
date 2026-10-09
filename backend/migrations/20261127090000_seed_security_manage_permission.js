'use strict';

/**
 * `security.manage` — change a property's security settings (today: whether admin/super_admin
 * sign-in needs the emailed verification code). super_admin ONLY, never admin (the third place
 * the matrix's Admin and Super-admin cells diverge, after room_types.update and reports.view_chain).
 * Seeds the catalogue row and backfills existing tenants' super_admin roles, skipping tenants being purged.
 */

const SECURITY_MANAGE_PERMISSIONS = [
  { permission_key: 'security.manage', name: 'Change security settings (e.g. the admin verification-code requirement)', domain: 'setup' },
];

const SECURITY_MANAGE_KEYS = SECURITY_MANAGE_PERMISSIONS.map((row) => row.permission_key);
const BACKFILL_ROLE_CODES = ['super_admin'];

exports.up = async function up(knex) {
  const existingKeys = await knex('permissions').whereIn('permission_key', SECURITY_MANAGE_KEYS).select('permission_key');
  const alreadyCatalogued = new Set(existingKeys.map((row) => row.permission_key));
  const toInsert = SECURITY_MANAGE_PERMISSIONS.filter((row) => !alreadyCatalogued.has(row.permission_key));
  if (toInsert.length) await knex('permissions').insert(toInsert);

  const permissionRows = await knex('permissions').whereIn('permission_key', SECURITY_MANAGE_KEYS).select('id', 'permission_key');
  const permissionIdByKey = new Map(permissionRows.map((row) => [row.permission_key, row.id]));

  const leaving = await knex('tenants').whereIn('status', ['purging', 'purged']).select('id');
  const leavingIds = new Set(leaving.map((row) => String(row.id)));
  const roleRows = (await knex('roles').whereIn('code', BACKFILL_ROLE_CODES).select('id', 'tenant_id', 'code')).filter((row) => !leavingIds.has(String(row.tenant_id)));
  if (roleRows.length === 0) return;

  const roleIds = roleRows.map((row) => row.id);
  const existingGrants = await knex('role_permissions')
    .whereIn('role_id', roleIds)
    .whereIn('permission_id', Array.from(permissionIdByKey.values()))
    .select('role_id', 'permission_id');
  const alreadyGranted = new Set(existingGrants.map((row) => `${row.role_id}:${row.permission_id}`));

  const grantsToInsert = [];
  for (const role of roleRows) {
    for (const key of SECURITY_MANAGE_KEYS) {
      const permissionId = permissionIdByKey.get(key);
      const grantKey = `${role.id}:${permissionId}`;
      if (alreadyGranted.has(grantKey)) continue;
      grantsToInsert.push({ tenant_id: role.tenant_id, role_id: role.id, permission_id: permissionId });
    }
  }

  if (grantsToInsert.length) await knex('role_permissions').insert(grantsToInsert);
};

exports.down = async function down(knex) {
  const permissionRows = await knex('permissions').whereIn('permission_key', SECURITY_MANAGE_KEYS).select('id');
  const permissionIds = permissionRows.map((row) => row.id);
  if (permissionIds.length) {
    await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  }
  await knex('permissions').whereIn('permission_key', SECURITY_MANAGE_KEYS).delete();
};
