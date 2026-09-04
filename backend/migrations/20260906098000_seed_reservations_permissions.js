'use strict';

/**
 * The second real (non-test-fixture) entries in the `permissions` catalogue
 * — PLAN.md Phase 2's reservations module, following the exact pattern
 * `20260905095000_seed_setup_permissions.js` established for Phase 1's
 * setup module: seeded once, globally, here; per-tenant `role_permissions`
 * grants happen in `tests/helpers/fixtures.js` and
 * `seeds/01_dev_tenants.js`, not in this migration.
 *
 * Four keys, not two, because SECURITY.md §5's RBAC matrix draws separate
 * rows for Reservations and Front Desk with a real difference between them:
 * `cashier` gets Read on Reservations but nothing at all on Front Desk. One
 * `reservations.*` pair could not express that split, so Front Desk gets
 * its own pair even though both live in one backend module
 * (`src/modules/reservations`) — see that module's own header for why it is
 * one module, not two.
 */

exports.up = async function up(knex) {
  const keys = ['reservations.view', 'reservations.manage', 'front_desk.view', 'front_desk.manage'];
  const existing = await knex('permissions').whereIn('permission_key', keys).select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'reservations.view', name: 'View reservations', domain: 'reservations' },
    { permission_key: 'reservations.manage', name: 'Manage reservations', domain: 'reservations' },
    { permission_key: 'front_desk.view', name: 'View front desk boards', domain: 'front_desk' },
    { permission_key: 'front_desk.manage', name: 'Perform front desk actions', domain: 'front_desk' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions')
    .whereIn('permission_key', ['reservations.view', 'reservations.manage', 'front_desk.view', 'front_desk.manage'])
    .delete();
};
