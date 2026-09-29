'use strict';

/**
 * Handing a tab over at shift change (user-requested: "add a transfer tab
 * action for shift handover"). Void and rename belong to a tab's owner;
 * until now that was always `opened_by_user_id`. A transfer must change
 * who owns the tab without rewriting who opened it (that stays a fact),
 * so ownership moves to a separate nullable column:
 *
 *   owner = owner_user_id ?? opened_by_user_id
 *
 * NULL for every existing row (owner = opener, exactly as before), set
 * only by a transfer. A guest QR tab has no opener and is never
 * transferred, so its owner stays NULL (anyone at the outlet). A composite
 * `(tenant_id, owner_user_id)` key onto `users`, RESTRICT, like the
 * opener's own key.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_orders', (table) => {
    table
      .bigInteger('owner_user_id')
      .unsigned()
      .nullable()
      .after('opened_by_user_id')
      .comment('Set by a tab transfer: the operator who now owns the tab. NULL = the opener still owns it.');
    table
      .foreign(['tenant_id', 'owner_user_id'], 'pos_orders_tenant_id_owner_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_orders', (table) => {
    table.dropForeign(['tenant_id', 'owner_user_id'], 'pos_orders_tenant_id_owner_user_id_foreign');
    table.dropColumn('owner_user_id');
  });
};
