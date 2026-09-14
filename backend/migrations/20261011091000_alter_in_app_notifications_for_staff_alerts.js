'use strict';

/**
 * Two additions to the bell's backing store for real staff alerts:
 *
 * - `dedup_key` + UNIQUE(tenant_id, user_id, dedup_key): the periodic
 *   "guest departing today with an outstanding balance" sweep runs every few
 *   minutes and must alert each recipient ONCE per reservation per business
 *   date (confirmed with the user). A real constraint, never a
 *   check-then-insert (ARCHITECTURE.md §5). Every ordinary notification
 *   leaves it NULL, and InnoDB treats every NULL as distinct, so they never
 *   collide.
 * - `popup`: whether the frontend should also raise an on-screen card for
 *   this row (confirmed: new guest QR orders only). Data-driven rather than
 *   a hardcoded type check in the browser.
 *
 * Backward compatible: existing rows default to `popup: false`,
 * `dedup_key: NULL`.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('in_app_notifications', (table) => {
    table.string('dedup_key', 191).nullable();
    table.boolean('popup').notNullable().defaultTo(false);
    table.unique(['tenant_id', 'user_id', 'dedup_key'], { indexName: 'in_app_notifications_dedup_unique' });
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('in_app_notifications', (table) => {
    table.dropUnique(['tenant_id', 'user_id', 'dedup_key'], 'in_app_notifications_dedup_unique');
    table.dropColumn('popup');
    table.dropColumn('dedup_key');
  });
};
