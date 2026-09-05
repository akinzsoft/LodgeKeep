'use strict';

/**
 * Housekeeping permission keys — PLAN.md Phase 3, following the exact
 * pattern `20260905095000_seed_setup_permissions.js` and
 * `20260906098000_seed_reservations_permissions.js` established: seeded once,
 * globally, here; per-tenant `role_permissions` grants happen in
 * `tests/helpers/fixtures.js` and `seeds/01_dev_tenants.js`.
 *
 * SECURITY.md §5's matrix row for Housekeeping: the `housekeeping` role gets
 * full (✓) access, `front_desk` gets Read only, manager/admin/super_admin
 * get full access, cashier/pos_operator get none (✗).
 */

exports.up = async function up(knex) {
  const keys = ['housekeeping.view', 'housekeeping.manage'];
  const existing = await knex('permissions').whereIn('permission_key', keys).select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'housekeeping.view', name: 'View housekeeping boards', domain: 'housekeeping' },
    { permission_key: 'housekeeping.manage', name: 'Manage housekeeping assignments and status', domain: 'housekeeping' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions').whereIn('permission_key', ['housekeeping.view', 'housekeeping.manage']).delete();
};
