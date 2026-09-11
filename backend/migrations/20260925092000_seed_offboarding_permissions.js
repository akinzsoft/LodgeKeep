'use strict';

/**
 * Offboarding permission key — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md
 * §3.22. `offboarding.manage`, admin/super_admin only — a single key, not
 * a view/manage split like AR/Group Blocks/Billing: there is no
 * operational read here for any role to need (nobody except the account
 * owner has a reason to see "is my tenant scheduled for deletion"), the
 * identical reasoning `billing.view`/`billing.manage` already established
 * for the closest analog in this codebase, narrowed one step further
 * since even a read-only view of this is admin-tier information.
 *
 * Same two-part pattern `20260924095000_seed_billing_permissions.js`
 * established, for the identical reason: self-service signup means real,
 * already-provisioned tenants exist NOW, so this migration both seeds the
 * catalogue row AND backfills the grant onto every EXISTING tenant's
 * admin/super_admin roles — `default-rbac.js`'s own `ALL_PERMISSION_KEYS`
 * addition (this same pass) only reaches a tenant signing up AFTER this
 * ships.
 */

const OFFBOARDING_PERMISSIONS = [
  { permission_key: 'offboarding.manage', name: 'Request offboarding and manage the resulting data export', domain: 'offboarding' },
];

const OFFBOARDING_KEYS = OFFBOARDING_PERMISSIONS.map((row) => row.permission_key);
const BACKFILL_ROLE_CODES = ['admin', 'super_admin'];

exports.up = async function up(knex) {
  const existingKeys = await knex('permissions').whereIn('permission_key', OFFBOARDING_KEYS).select('permission_key');
  const alreadyCatalogued = new Set(existingKeys.map((row) => row.permission_key));
  const toInsert = OFFBOARDING_PERMISSIONS.filter((row) => !alreadyCatalogued.has(row.permission_key));
  if (toInsert.length) await knex('permissions').insert(toInsert);

  const permissionRows = await knex('permissions').whereIn('permission_key', OFFBOARDING_KEYS).select('id', 'permission_key');
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
    for (const key of OFFBOARDING_KEYS) {
      const permissionId = permissionIdByKey.get(key);
      const grantKey = `${role.id}:${permissionId}`;
      if (alreadyGranted.has(grantKey)) continue;
      grantsToInsert.push({ tenant_id: role.tenant_id, role_id: role.id, permission_id: permissionId });
    }
  }

  if (grantsToInsert.length) await knex('role_permissions').insert(grantsToInsert);
};

exports.down = async function down(knex) {
  const permissionRows = await knex('permissions').whereIn('permission_key', OFFBOARDING_KEYS).select('id');
  const permissionIds = permissionRows.map((row) => row.id);
  if (permissionIds.length) {
    await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  }
  await knex('permissions').whereIn('permission_key', OFFBOARDING_KEYS).delete();
};
