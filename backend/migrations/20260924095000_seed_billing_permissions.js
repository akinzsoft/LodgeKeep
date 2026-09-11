'use strict';

/**
 * Billing permission keys — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22.
 * `billing.view` (see the tenant's own subscription status, payment method
 * display metadata, and invoice/payment history) and `billing.manage` (add
 * or replace the payment method, retry a failed charge) — both admin/
 * super_admin only. This is the tenant's own commercial relationship with
 * Planmsys, not a guest- or company-facing concern any operational role
 * (front_desk/cashier/housekeeping/pos_operator) or even `manager` has a
 * reason to see, so unlike `ar.*`/`group_blocks.*` (which grant `manager` and
 * some operational roles a `.view`), billing follows `room_types.update`'s
 * own narrower precedent — admin/super_admin only, both keys.
 *
 * ── WHY THIS MIGRATION DOES MORE THAN EVERY PRIOR "SEED A PERMISSION" ONE ──
 *
 * Every earlier permission-seeding migration in this codebase (setup,
 * reservations, housekeeping, notifications, reports, cashiering, night
 * audit, pos, ar, group_blocks) only ever inserted into the GLOBAL_REFERENCE
 * `permissions` catalogue — never into `role_permissions` — because every
 * tenant that existed at the time each one ran was a dev-seed or test
 * fixture, and `default-rbac.js`'s `DEFAULT_ROLE_PERMISSIONS` (the seed a
 * BRAND NEW tenant gets via `provisionTenant()`, added in the tenant-signup
 * pass) simply had a new key added to `ALL_PERMISSION_KEYS`, which
 * `admin`/`super_admin` derive their grants from automatically.
 *
 * That's no longer sufficient. Self-service tenant signup (PLAN.md Phase 5)
 * means real, already-provisioned tenants exist NOW, each with its own
 * already-created `role_permissions` rows for `admin`/`super_admin` frozen
 * at whatever `DEFAULT_ROLE_PERMISSIONS` looked like the day they signed up
 * — adding `billing.view`/`billing.manage` to `default-rbac.js`'s
 * `ALL_PERMISSION_KEYS` only affects a tenant signing up AFTER this ships.
 * Every tenant that signed up before it needs this migration to actually
 * backfill the grant onto their `admin`/`super_admin` roles, or their own
 * admin genuinely cannot see their own subscription. `seeds/01_dev_tenants.js`
 * needs no change — its own `ensureAdminSuperAdminFullAccess` already grants
 * every catalogue row to both roles on every seed run, so it picks up these
 * two keys automatically the next time `npm run seed` runs.
 */

const BILLING_PERMISSIONS = [
  { permission_key: 'billing.view', name: 'View subscription status, payment method, and invoice history', domain: 'billing' },
  { permission_key: 'billing.manage', name: 'Manage payment method and retry failed subscription charges', domain: 'billing' },
];

const BILLING_KEYS = BILLING_PERMISSIONS.map((row) => row.permission_key);
const BACKFILL_ROLE_CODES = ['admin', 'super_admin'];

exports.up = async function up(knex) {
  // 1. The catalogue rows, select-or-insert like every prior permission
  //    migration (a fresh test/dev schema running every migration from
  //    scratch must not collide with itself).
  const existingKeys = await knex('permissions').whereIn('permission_key', BILLING_KEYS).select('permission_key');
  const alreadyCatalogued = new Set(existingKeys.map((row) => row.permission_key));
  const toInsert = BILLING_PERMISSIONS.filter((row) => !alreadyCatalogued.has(row.permission_key));
  if (toInsert.length) await knex('permissions').insert(toInsert);

  const permissionRows = await knex('permissions').whereIn('permission_key', BILLING_KEYS).select('id', 'permission_key');
  const permissionIdByKey = new Map(permissionRows.map((row) => [row.permission_key, row.id]));

  // 2. The backfill: every EXISTING tenant's admin/super_admin roles, not
  //    just a fresh signup's. See the migration header for why this pass
  //    specifically needs this, unlike every prior permission migration.
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
    for (const key of BILLING_KEYS) {
      const permissionId = permissionIdByKey.get(key);
      const grantKey = `${role.id}:${permissionId}`;
      if (alreadyGranted.has(grantKey)) continue;
      grantsToInsert.push({ tenant_id: role.tenant_id, role_id: role.id, permission_id: permissionId });
    }
  }

  if (grantsToInsert.length) await knex('role_permissions').insert(grantsToInsert);
};

exports.down = async function down(knex) {
  const permissionRows = await knex('permissions').whereIn('permission_key', BILLING_KEYS).select('id');
  const permissionIds = permissionRows.map((row) => row.id);
  if (permissionIds.length) {
    await knex('role_permissions').whereIn('permission_id', permissionIds).delete();
  }
  await knex('permissions').whereIn('permission_key', BILLING_KEYS).delete();
};
