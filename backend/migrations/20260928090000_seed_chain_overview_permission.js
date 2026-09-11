'use strict';

/**
 * Chain overview permission key — PLAN.md Phase 6, PRODUCT_REQUIREMENTS.md
 * §3.13's role-landing table ("Super-admin (tenant) → Multi-property
 * roll-up → All of that tenant's properties, chain-wide reporting").
 *
 * `reports.view_chain`, `super_admin` only — the second place this
 * matrix's own Admin `✓` genuinely diverges from Super-admin's `✓`, the
 * same shape `room_types.update` established first (SECURITY.md §5).
 * Filed under the existing `reports` domain (this is a reporting
 * capability, not a new business domain like AR/Billing/Offboarding), but
 * kept as its own key rather than folded into `reports.view_financial` —
 * that key is already held by manager/admin too, and PRODUCT_REQUIREMENTS.md's
 * own role-landing table names this as super_admin's distinguishing
 * experience specifically.
 *
 * Same two-part pattern `20260925092000_seed_offboarding_permissions.js`
 * established: self-service signup means real, already-provisioned
 * tenants exist NOW, so this migration both seeds the catalogue row AND
 * backfills the grant onto every EXISTING tenant's `super_admin` role
 * (NOT `admin` — that's the whole point of the divergence)
 * — `default-rbac.js`'s own `ALL_PERMISSION_KEYS` addition (this same
 * pass) only reaches a tenant signing up AFTER this ships.
 */

const CHAIN_OVERVIEW_PERMISSIONS = [
  { permission_key: 'reports.view_chain', name: 'View chain-wide, cross-property reporting roll-up', domain: 'reports' },
];

const CHAIN_OVERVIEW_KEYS = CHAIN_OVERVIEW_PERMISSIONS.map((row) => row.permission_key);
const BACKFILL_ROLE_CODES = ['super_admin'];

exports.up = async function up(knex) {
  const existingKeys = await knex('permissions').whereIn('permission_key', CHAIN_OVERVIEW_KEYS).select('permission_key');
  const alreadyCatalogued = new Set(existingKeys.map((row) => row.permission_key));
  const toInsert = CHAIN_OVERVIEW_PERMISSIONS.filter((row) => !alreadyCatalogued.has(row.permission_key));
  if (toInsert.length) await knex('permissions').insert(toInsert);

  const permissionRows = await knex('permissions').whereIn('permission_key', CHAIN_OVERVIEW_KEYS).select('id', 'permission_key');
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
    for (const key of CHAIN_OVERVIEW_KEYS) {
      const permissionId = permissionIdByKey.get(key);
      const grantKey = `${role.id}:${permissionId}`;
      if (alreadyGranted.has(grantKey)) continue;
      grantsToInsert.push({ tenant_id: role.tenant_id, role_id: role.id, permission_id: permissionId });
    }
  }

  if (grantsToInsert.length) await knex('role_permissions').insert(grantsToInsert);
};

exports.down = async function down(knex) {
  const permissionRows = await knex('permissions').whereIn('permission_key', CHAIN_OVERVIEW_KEYS).select('id');
  const permissionIds = permissionRows.map((row) => row.id);
  if (permissionIds.length) {
    await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  }
  await knex('permissions').whereIn('permission_key', CHAIN_OVERVIEW_KEYS).delete();
};
