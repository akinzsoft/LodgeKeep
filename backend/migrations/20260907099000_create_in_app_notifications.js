'use strict';

/**
 * The top-bar bell's backing store — DATABASE.md §1's `in_app_notifications`
 * row, PRODUCT_REQUIREMENTS.md §3.21: "the top-bar bell for operational
 * events — new online booking received, payment received, housekeeping
 * discrepancy raised (3.6), night audit due or overdue."
 *
 * Scope: TENANT_SCOPED, following `users` — a notification belongs to one
 * staff member, and `user_id` alone (a TENANT_SCOPED column) is enough to
 * resolve it; no property dimension is needed on this table itself the way
 * `user_property_access` needs one for its role grant, since a notification
 * always already carries whatever property context it needs inside its own
 * `payload`.
 *
 * Written directly inside the SAME transaction as the event that causes it
 * (`src/modules/housekeeping/service.js`'s discrepancy-raise, this pass) —
 * NOT through the outbox. ARCHITECTURE.md §13's outbox pattern exists
 * specifically to keep an unreliable EXTERNAL call (an email send) out of a
 * business transaction; an in-app notification is just another durable
 * internal row, no slower or less reliable than the write it accompanies, so
 * it needs no separate dispatch step.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('in_app_notifications', (table) => {
    table.comment('One row per bell notification for one staff user. Scope: TENANT_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();

    table.string('type', 60).notNullable().comment('e.g. "housekeeping.discrepancy_raised" — mirrors an outbox event_type where one exists, but this table has no direct FK to outbox_events (different lifecycle: read/unread, not sent/failed).');
    table.json('payload').notNullable();
    table.datetime('read_at').nullable();

    timestamps(knex, table);

    table
      .foreign(['tenant_id', 'user_id'], 'in_app_notifications_tenant_id_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The bell's own read: unread-first, newest-first, for one user.
    table.index(['tenant_id', 'user_id', 'read_at', 'created_at'], 'in_app_notifications_bell_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('in_app_notifications');
};
