'use strict';

/**
 * Door access permissions and plan entitlement — PLAN.md Phase 7,
 * PRODUCT_REQUIREMENTS.md §3.23 ("Manager/admin only — these screens must
 * not render for front desk or housekeeping roles") and §3.22 (door access
 * monitoring is a named plan-gated capability).
 *
 * `door_access.view` (alert inbox, stay confirmations, lock config read)
 * and `door_access.manage` (lock config write, import, acknowledge,
 * resolve) — both manager/admin/super_admin only. Front desk and
 * housekeeping get neither: "the people with the most opportunity to
 * commit this fraud shouldn't be the ones notified it was detected."
 *
 * Same two-part pattern `20260928090000_seed_chain_overview_permission.js`
 * established: the catalogue rows AND a backfill onto every EXISTING
 * tenant's roles, since self-service signup means already-provisioned
 * tenants exist.
 *
 * The `door_access_monitoring` entitlement is seeded ENABLED on the
 * `standard` plan in the same migration, so this pass changes no existing
 * tenant's access — the identical shape `plan_entitlements`' own migration
 * used for `multi_property`.
 */

const PERMISSIONS = [
  { permission_key: 'door_access.view', name: 'View door-access alerts and stay confirmations', domain: 'door_access' },
  { permission_key: 'door_access.manage', name: 'Import lock audit trails and manage door-access alerts', domain: 'door_access' },
];
const KEYS = PERMISSIONS.map((row) => row.permission_key);
const BACKFILL_ROLE_CODES = ['manager', 'admin', 'super_admin'];
const FEATURE_KEY = 'door_access_monitoring';

exports.up = async function up(knex) {
  const existingKeys = await knex('permissions').whereIn('permission_key', KEYS).select('permission_key');
  const alreadyCatalogued = new Set(existingKeys.map((row) => row.permission_key));
  const toInsert = PERMISSIONS.filter((row) => !alreadyCatalogued.has(row.permission_key));
  if (toInsert.length) await knex('permissions').insert(toInsert);

  const permissionRows = await knex('permissions').whereIn('permission_key', KEYS).select('id', 'permission_key');
  const roleRows = await knex('roles').whereIn('code', BACKFILL_ROLE_CODES).select('id', 'tenant_id');

  if (roleRows.length) {
    const existingGrants = await knex('role_permissions')
      .whereIn('role_id', roleRows.map((row) => row.id))
      .whereIn('permission_id', permissionRows.map((row) => row.id))
      .select('role_id', 'permission_id');
    const alreadyGranted = new Set(existingGrants.map((row) => `${row.role_id}:${row.permission_id}`));

    const grants = [];
    for (const role of roleRows) {
      for (const permission of permissionRows) {
        if (alreadyGranted.has(`${role.id}:${permission.id}`)) continue;
        grants.push({ tenant_id: role.tenant_id, role_id: role.id, permission_id: permission.id });
      }
    }
    if (grants.length) await knex('role_permissions').insert(grants);
  }

  const standardPlan = await knex('plans').where({ code: 'standard' }).first('id');
  if (standardPlan) {
    const existing = await knex('plan_entitlements').where({ plan_id: standardPlan.id, feature_key: FEATURE_KEY }).first();
    if (!existing) {
      await knex('plan_entitlements').insert({ plan_id: standardPlan.id, feature_key: FEATURE_KEY, enabled: true });
    }
  }
};

exports.down = async function down(knex) {
  await knex('plan_entitlements').where({ feature_key: FEATURE_KEY }).delete();
  const permissionRows = await knex('permissions').whereIn('permission_key', KEYS).select('id');
  const permissionIds = permissionRows.map((row) => row.id);
  if (permissionIds.length) await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  await knex('permissions').whereIn('permission_key', KEYS).delete();
};
