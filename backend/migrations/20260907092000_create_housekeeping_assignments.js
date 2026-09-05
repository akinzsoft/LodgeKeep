'use strict';

/**
 * Housekeeping attendant assignments — PLAN.md Phase 3 ("attendant
 * assignments, mobile status board"), DATABASE.md §1's
 * `housekeeping_assignments` row, PRODUCT_REQUIREMENTS.md §3.6.
 *
 * Scope: PROPERTY_SCOPED, following `rooms`.
 *
 * One row per (room, business_date) — UNIQUE(property_id, room_id,
 * business_date), DATABASE.md §2's required set. A room reassigned to a
 * different attendant on the same day is an UPDATE of `attendant_user_id`
 * on the existing row, not a new one: the status board shows one row per
 * room per day, and there is exactly one "who is responsible for this room
 * today" answer at any moment — a second row would make that ambiguous.
 *
 * `business_date`, not `created_at`'s date: assignments are planned against
 * the property's accounting day (ARCHITECTURE.md §6), not wall-clock "today",
 * the same reasoning `reservations.arrival_date`/`departure_date` already
 * follow.
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
  await knex.schema.createTable('housekeeping_assignments', (table) => {
    table.comment(
      'Which attendant is responsible for cleaning one room on one business date. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('room_id').unsigned().notNullable();
    table.bigInteger('attendant_user_id').unsigned().notNullable();
    table.date('business_date').notNullable();

    table.enu('status', ['assigned', 'in_progress', 'completed']).notNullable().defaultTo('assigned');
    table.datetime('started_at').nullable();
    table.datetime('completed_at').nullable();

    timestamps(knex, table);

    // Shortened to stay under MySQL's 64-char identifier limit — the same
    // class of truncation Phase 1's `rate_calendar` migration already hit.
    table.unique(['property_id', 'room_id', 'business_date'], {
      indexName: 'hk_assignments_property_room_date_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'housekeeping_assignments_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'room_id'], 'housekeeping_assignments_tenant_id_property_id_room_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // attendant_user_id -> users(tenant_id, id): 2-column, TENANT_SCOPED
    // parent, same pattern user_property_access.user_id already uses.
    table
      .foreign(['tenant_id', 'attendant_user_id'], 'housekeeping_assignments_tenant_id_attendant_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'business_date'], 'housekeeping_assignments_board_index');
    table.index(['tenant_id', 'property_id', 'attendant_user_id', 'business_date'], 'housekeeping_assignments_attendant_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('housekeeping_assignments');
};
