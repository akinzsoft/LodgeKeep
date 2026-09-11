'use strict';

/**
 * Platform-staff tiering — PLAN.md Phase 5, SECURITY.md §2's "Platform staff
 * RBAC" paragraph, revisited now that self-service tenant signup means
 * `platform_users` can reach REAL customer data, not just internally-seeded
 * test tenants. Previously: "any active, MFA-verified platform account can
 * list tenants and start an impersonation grant" — a deliberate, documented
 * decision, correct while every tenant was internal. That trust boundary no
 * longer matches the blast radius once uncurated signups land in the same
 * database as everything else.
 *
 * Deliberately minimal — not a permission catalogue, not a `role_permissions`
 * equivalent for platform staff. Two values: `support` (read the tenant
 * roster and impersonation history, cannot act) and `admin` (can also
 * impersonate, suspend, and reactivate a tenant — the three actions that
 * reach or change real tenant state). `requirePlatformRole('admin')` gates
 * exactly those three routes; every read-only platform route stays open to
 * both tiers.
 *
 * Existing rows backfilled to `admin` in this same migration — a platform
 * account that already existed (the one dev-seeded `platform_users` row)
 * must not silently lose capability it already had the moment this ships.
 * New rows default to `support`, the safer default: an engineer manually
 * provisioning a new platform account (no self-service platform signup
 * exists, or is being built here) must opt a row INTO the more privileged
 * tier explicitly, never receive it by omission.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('platform_users', (table) => {
    table
      .enu('role', ['support', 'admin'])
      .notNullable()
      .defaultTo('support')
      .comment('support: read-only roster/history. admin: also impersonate, suspend, reactivate a tenant (SECURITY.md §2).');
  });

  await knex('platform_users').update({ role: 'admin' });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('platform_users', (table) => {
    table.dropColumn('role');
  });
};
