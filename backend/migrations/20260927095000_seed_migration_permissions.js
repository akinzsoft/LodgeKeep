'use strict';

/**
 * Data migration permission key — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md
 * §3.20 ("Admin only, and typically used once. Optimise for confidence, not
 * convenience."). `migration.manage`, admin/super_admin only — a single
 * key, not a view/manage split, the identical reasoning
 * `20260925092000_seed_offboarding_permissions.js` already established for
 * the closest analog in this codebase: there is no operational read here
 * for any other role to need (nobody but an admin importing a customer's
 * legacy data has any reason to see an import run's history), narrower
 * than every view/manage-split module (AR, Group Blocks, Billing).
 *
 * Same two-part pattern every permission-seed migration since self-service
 * signup uses: seeds the catalogue row AND backfills the grant onto every
 * EXISTING tenant's admin/super_admin roles — `default-rbac.js`'s own
 * `ALL_PERMISSION_KEYS` addition (this same pass) only reaches a tenant
 * signing up AFTER this ships.
 */

const MIGRATION_PERMISSIONS = [
  { permission_key: 'migration.manage', name: 'Import and roll back data-migration runs', domain: 'migration' },
];

const MIGRATION_KEYS = MIGRATION_PERMISSIONS.map((row) => row.permission_key);
const BACKFILL_ROLE_CODES = ['admin', 'super_admin'];

exports.up = async function up(knex) {
  const existingKeys = await knex('permissions').whereIn('permission_key', MIGRATION_KEYS).select('permission_key');
  const alreadyCatalogued = new Set(existingKeys.map((row) => row.permission_key));
  const toInsert = MIGRATION_PERMISSIONS.filter((row) => !alreadyCatalogued.has(row.permission_key));
  if (toInsert.length) await knex('permissions').insert(toInsert);

  const permissionRows = await knex('permissions').whereIn('permission_key', MIGRATION_KEYS).select('id', 'permission_key');
  const permissionIdByKey = new Map(permissionRows.map((row) => [row.permission_key, row.id]));

  const roleRows = await knex('roles').whereIn('code', BACKFILL_ROLE_CODES).select('id', 'tenant_id', 'code');
  if (roleRows.length === 0) return;

  const roleIds = roleRows.map((row) => row.id);
  const existingGrants = await knex('role_permissions')
    .whereIn('role_id', roleIds)
    .whereIn('permission_id', Array.from(permissionIdByKey.values()))
    .select('role_id', 'permission_id');
  const alreadyGranted = new Set(existingGrants.map((row) => `${row.role_id}:${row.permission_id}`));

  const grantsToInsert = [];
  for (const role of roleRows) {
    for (const key of MIGRATION_KEYS) {
      const permissionId = permissionIdByKey.get(key);
      const grantKey = `${role.id}:${permissionId}`;
      if (alreadyGranted.has(grantKey)) continue;
      grantsToInsert.push({ tenant_id: role.tenant_id, role_id: role.id, permission_id: permissionId });
    }
  }

  if (grantsToInsert.length) await knex('role_permissions').insert(grantsToInsert);
};

exports.down = async function down(knex) {
  const permissionRows = await knex('permissions').whereIn('permission_key', MIGRATION_KEYS).select('id');
  const permissionIds = permissionRows.map((row) => row.id);
  if (permissionIds.length) {
    await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  }
  await knex('permissions').whereIn('permission_key', MIGRATION_KEYS).delete();
};
