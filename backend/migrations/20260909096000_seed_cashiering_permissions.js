'use strict';

/**
 * Cashiering permission keys — PLAN.md Phase 2.5. Following the exact
 * pattern `20260907095000_seed_housekeeping_permissions.js` established.
 *
 * These two keys are NOT new names invented for this migration — they were
 * already load-bearing, fixture-only forward references since Phase 0:
 * `tests/auth/rbac.test.js`'s own synthetic RBAC catalogue and
 * `tests/helpers/fixtures.js`'s GLOBAL_REFERENCE permission list both
 * already use exactly `cashiering.post_charge`/`cashiering.void_line`
 * (fixtures.js even already grants `manager` -> `cashiering.void_line` for
 * both tenants). This migration is what promotes them from fixture-only to
 * real, migration-seeded rows — both test files' own select-or-insert
 * lookups (`const existing = await trx('permissions').where({
 * permission_key: key })...`) already handle this composition without
 * needing any change, the exact same "fixture-only key promoted to
 * migration-seeded" shape `20260905095000_seed_setup_permissions.js`'s own
 * header documents happening for `setup.view`/`.manage`.
 *
 * SECURITY.md §5's matrix row for Cashiering, "Limited" now defined per
 * that section's own example: front_desk gets `cashiering.post_charge`
 * only ("post-a-charge, not void-a-line"); cashier/manager/admin/
 * super_admin get both keys; housekeeping/pos_operator get neither.
 */

exports.up = async function up(knex) {
  const keys = ['cashiering.post_charge', 'cashiering.void_line'];
  const existing = await knex('permissions').whereIn('permission_key', keys).select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'cashiering.post_charge', name: 'Post a folio charge', domain: 'cashiering' },
    { permission_key: 'cashiering.void_line', name: 'Manage payments, refunds, voids and split billing', domain: 'cashiering' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions').whereIn('permission_key', ['cashiering.post_charge', 'cashiering.void_line']).delete();
};
