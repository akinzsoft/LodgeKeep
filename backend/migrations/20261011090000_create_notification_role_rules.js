'use strict';

/**
 * Staff notification recipients, configured by role, per property — gap
 * closure (user-reported: "the notification bell is not working ... add in
 * setup to set user that can get that notifications and the kind of
 * notifications"). Confirmed with the user: recipients are chosen BY ROLE
 * (a notification type x role grid in Setup), not per individual user, so a
 * newly-invited staff member inherits the right alerts from their role.
 *
 * Stores explicit overrides only. `notifyStaff`
 * (`src/modules/notifications/staff-notifications.js`) starts from the
 * event catalogue's built-in default roles and applies whichever rows exist
 * here on top — a missing (event_type, role) row means "use the default,"
 * never "off." That keeps a future new event type correctly defaulted for
 * every property that has already saved the grid once, rather than silently
 * off everywhere.
 *
 * Scope: PROPERTY_SCOPED, the same reasoning as `email_settings` — two
 * properties in one tenant can staff their bar/front desk differently.
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
  await knex.schema.createTable('notification_role_rules', (table) => {
    table.comment('Per-property override of which roles receive a staff notification type. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.string('event_type', 60).notNullable();
    table.string('role', 30).notNullable();
    table.boolean('enabled').notNullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'event_type', 'role'], {
      indexName: 'notification_role_rules_event_role_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'notification_role_rules_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('notification_role_rules');
};
