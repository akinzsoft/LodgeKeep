'use strict';

/**
 * `users.last_active_property_id` — bug fix, user-reported on production:
 * after adding a second property and setting up its POS, "this morning
 * nothing is showing." Nothing was lost: signing in (or reloading) with
 * access to more than one property started the session with NO active
 * property, because nothing remembered which one the user last worked in,
 * so every property-scoped screen came up empty.
 *
 * This column is that memory: written when the user switches property,
 * read when a session starts. It is a preference, not a grant — it is only
 * ever honoured while the user still holds access at that property
 * (`user_property_access`), re-checked every time. The composite FK keeps
 * it inside the user's own tenant. Nullable: nothing remembered yet.
 */

const FK_NAME = 'users_tenant_id_last_active_property_id_foreign';

exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table
      .bigInteger('last_active_property_id')
      .unsigned()
      .nullable()
      .comment('The property this user last switched to; restored when a session starts, only while they still have access there.');
    table
      .foreign(['tenant_id', 'last_active_property_id'], FK_NAME)
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropForeign(['tenant_id', 'last_active_property_id'], FK_NAME);
    table.dropIndex(['tenant_id', 'last_active_property_id'], FK_NAME);
    table.dropColumn('last_active_property_id');
  });
};
