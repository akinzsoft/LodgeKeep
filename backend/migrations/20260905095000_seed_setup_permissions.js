'use strict';

/**
 * The first real (non-test-fixture) entries in the `permissions` catalogue —
 * `src/auth/rbac.js`'s own header: "the literal §5 catalogue ... arrives one
 * key at a time as each real module lands and writes down its own 'Limited'
 * rule." Phase 1's setup module is that first real module.
 *
 * `permissions` is GLOBAL_REFERENCE (ARCHITECTURE.md §3) — "defined by the
 * codebase, seeded, and never editable by a tenant" — so it is seeded here,
 * in a migration, not per-tenant. `role_permissions` grants (which role gets
 * which key) stay per-tenant and are NOT seeded here: `roles` themselves are
 * created at tenant-provisioning time (the dev seed script, or a real
 * onboarding flow later), not by a migration, so there is no tenant-owned
 * `roles` row yet for a migration to grant against.
 *
 * `setup.view` / `setup.manage` is the same two-key split
 * `tests/auth/rbac.test.js` already used as its representative "setup"
 * domain example (manager -> setup.view only, admin/super_admin ->
 * setup.manage too) — this migration makes that split real rather than
 * fixture-only, per this session's own confirmed decision: Manager gets
 * read-only Setup access, Admin/Super-admin get full access.
 */

exports.up = async function up(knex) {
  const existing = await knex('permissions')
    .whereIn('permission_key', ['setup.view', 'setup.manage'])
    .select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'setup.view', name: 'View property setup', domain: 'setup' },
    { permission_key: 'setup.manage', name: 'Manage property setup', domain: 'setup' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions').whereIn('permission_key', ['setup.view', 'setup.manage']).delete();
};
