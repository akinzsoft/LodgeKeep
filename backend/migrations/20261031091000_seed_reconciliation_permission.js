'use strict';

/**
 * `reconciliation.view` — the new payment reconciliation report
 * (`src/modules/reconciliation`), which unions folio-settled and
 * POS/QR-settled payments across the whole property, including
 * `provider_reference`/`provider_payment_id` and computed gross-vs-net
 * figures. Confirmed decision (AskUserQuestion): a genuinely new,
 * narrowly-scoped key rather than reusing `cashiering.void_line` or
 * `pos.manage` — this report spans both of those modules' own money data
 * at once, and reusing either would tie this report's access to a future
 * RBAC change in an unrelated module as a side effect. Matches the exact
 * precedent `reports.view_financial`/`night_audit.view`/`expenses.view`
 * each already established: a back-office financial-oversight capability
 * gets its own key, manager/admin/super_admin only, no front-desk/cashier/
 * housekeeping/pos_operator access — nobody handling money at the point of
 * sale needs to see the property-wide bank-reconciliation ledger.
 *
 * Same two-part pattern every real permission key since self-service
 * signup has needed (e.g. `20261024093000_seed_expenses_permissions.js`):
 * the catalogue row AND a backfill onto every EXISTING tenant's
 * manager/admin/super_admin roles.
 */

const PERMISSIONS = [
  { permission_key: 'reconciliation.view', name: 'View the payment reconciliation report', domain: 'reconciliation' },
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
