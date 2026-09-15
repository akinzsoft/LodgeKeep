'use strict';

/**
 * Expense-tracking permissions — confirmed decision: `expenses.view`/
 * `expenses.manage`, both manager/admin/super_admin only, no front-desk/
 * cashier/housekeeping/pos_operator access at all. Matches Night Audit's
 * and Billing's shape exactly: a back-office financial decision, not an
 * operational moment-of-sale action — the people closest to day-to-day
 * cash handling don't necessarily need to see the P&L.
 *
 * Same two-part pattern every real permission key since self-service
 * signup has needed (e.g. `20261020095000_seed_door_access_permissions_and_entitlement.js`):
 * the catalogue rows AND a backfill onto every EXISTING tenant's roles.
 *
 * No plan-entitlement gate (confirmed decision) — Night Audit, AR, and
 * Cashiering, equally "core financial" modules, have none either.
 */

const PERMISSIONS = [
  { permission_key: 'expenses.view', name: 'View expenses, categories, and recurring schedules', domain: 'expenses' },
  { permission_key: 'expenses.manage', name: 'Record, void, and configure expenses, categories, and recurring schedules', domain: 'expenses' },
];
const KEYS = PERMISSIONS.map((row) => row.permission_key);
const BACKFILL_ROLE_CODES = ['manager', 'admin', 'super_admin'];

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
};

exports.down = async function down(knex) {
  const permissionRows = await knex('permissions').whereIn('permission_key', KEYS).select('id');
  const permissionIds = permissionRows.map((row) => row.id);
  if (permissionIds.length) await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  await knex('permissions').whereIn('permission_key', KEYS).delete();
};
