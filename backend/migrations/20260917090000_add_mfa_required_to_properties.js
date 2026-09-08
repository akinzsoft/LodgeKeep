'use strict';

/**
 * Per-property MFA toggle — user-confirmed decision (AskUserQuestion,
 * "per-property toggle: require MFA for admin/super_admin or not").
 * `src/auth/roles.js`'s `roleRequiresMfa` has made MFA mandatory,
 * unconditionally, for admin/super_admin since Phase 0
 * (PRODUCT_REQUIREMENTS.md §3.16) — a real, deliberate security default,
 * but with no way for a property to turn it off if they don't want the
 * extra login step. This column is that override, read alongside
 * `roleRequiresMfa` at login rather than replacing it — the safer default
 * (`true`, matching today's unconditional behavior) so an EXISTING
 * property's login behavior does not silently change the moment this
 * migration runs.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('properties', (table) => {
    table
      .boolean('mfa_required_for_admin_roles')
      .notNullable()
      .defaultTo(true)
      .comment('Whether admin/super_admin logins at this property must complete an MFA challenge. Defaults true, matching the prior unconditional behavior.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('properties', (table) => {
    table.dropColumn('mfa_required_for_admin_roles');
  });
};
