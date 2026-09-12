'use strict';

/**
 * POS stock/inventory permission keys — PLAN.md Phase 6's "POS inventory &
 * stock control" (PRODUCT_REQUIREMENTS.md §3.4).
 *
 * Two keys, filed under the existing `pos` domain (an inventory capability
 * of the POS module, not a new business domain):
 *   - `pos.stock_view` — pos_operator/manager/admin/super_admin. Read
 *     stock levels/low-stock alerts, and record wastage (a floor action
 *     with a mandatory reason, the same tier as running the register).
 *   - `pos.stock_manage` — manager/admin/super_admin only. Stock item
 *     CRUD, recipe/BOM configuration, goods-received, the full stock-take
 *     lifecycle, and cost/variance reporting.
 *
 * Same two-part pattern `20260928090000_seed_chain_overview_permission.js`
 * established: self-service signup means real, already-provisioned
 * tenants exist NOW, so this migration both seeds the catalogue rows AND
 * backfills the matching grants onto every EXISTING tenant's target roles
 * — `default-rbac.js`'s own additions (this same pass) only reach a
 * tenant signing up AFTER this ships.
 */

const STOCK_PERMISSIONS = [
  { permission_key: 'pos.stock_view', name: 'View stock levels and record wastage', domain: 'pos' },
  { permission_key: 'pos.stock_manage', name: 'Manage stock items, recipes, goods-received, and stock takes', domain: 'pos' },
];

const STOCK_KEYS = STOCK_PERMISSIONS.map((row) => row.permission_key);
const VIEW_ROLE_CODES = ['pos_operator', 'manager', 'admin', 'super_admin'];
const MANAGE_ROLE_CODES = ['manager', 'admin', 'super_admin'];

exports.up = async function up(knex) {
  const existingKeys = await knex('permissions').whereIn('permission_key', STOCK_KEYS).select('permission_key');
  const alreadyCatalogued = new Set(existingKeys.map((row) => row.permission_key));
  const toInsert = STOCK_PERMISSIONS.filter((row) => !alreadyCatalogued.has(row.permission_key));
  if (toInsert.length) await knex('permissions').insert(toInsert);

  const permissionRows = await knex('permissions').whereIn('permission_key', STOCK_KEYS).select('id', 'permission_key');
  const permissionIdByKey = new Map(permissionRows.map((row) => [row.permission_key, row.id]));

  const roleRows = await knex('roles')
    .whereIn('code', [...new Set([...VIEW_ROLE_CODES, ...MANAGE_ROLE_CODES])])
    .select('id', 'tenant_id', 'code');
  if (roleRows.length === 0) return;

  const roleIds = roleRows.map((row) => row.id);
  const existingGrants = await knex('role_permissions')
    .whereIn('role_id', roleIds)
    .whereIn('permission_id', Array.from(permissionIdByKey.values()))
    .select('role_id', 'permission_id');
  const alreadyGranted = new Set(existingGrants.map((row) => `${row.role_id}:${row.permission_id}`));

  const grantsToInsert = [];
  for (const role of roleRows) {
    const keysForRole = [
      ...(VIEW_ROLE_CODES.includes(role.code) ? ['pos.stock_view'] : []),
      ...(MANAGE_ROLE_CODES.includes(role.code) ? ['pos.stock_manage'] : []),
    ];
    for (const key of keysForRole) {
      const permissionId = permissionIdByKey.get(key);
      const grantKey = `${role.id}:${permissionId}`;
      if (alreadyGranted.has(grantKey)) continue;
      grantsToInsert.push({ tenant_id: role.tenant_id, role_id: role.id, permission_id: permissionId });
    }
  }

  if (grantsToInsert.length) await knex('role_permissions').insert(grantsToInsert);
};

exports.down = async function down(knex) {
  const permissionRows = await knex('permissions').whereIn('permission_key', STOCK_KEYS).select('id');
  const permissionIds = permissionRows.map((row) => row.id);
  if (permissionIds.length) {
    await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  }
  await knex('permissions').whereIn('permission_key', STOCK_KEYS).delete();
};
