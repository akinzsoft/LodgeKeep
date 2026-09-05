'use strict';

/**
 * A raised, first-class discrepancy record — PLAN.md Phase 3's own test gate
 * ("Housekeeping discrepancy raised when front-desk and reported status
 * diverge; not silently overwritten either way") and
 * PRODUCT_REQUIREMENTS.md §3.6/its own UI screens section: "Discrepancy
 * report — dedicated view listing rooms where front-desk status ≠
 * housekeeper-reported status, each row showing both values side by side and
 * a resolve action. This must be a first-class screen, not buried in a
 * report dropdown."
 *
 * A boolean flag on `rooms` (`has_discrepancy`, Phase 1) can show a room is
 * CURRENTLY discrepant but cannot answer "what were the two values, when was
 * it raised, and who resolved it" — exactly what the dedicated screen and
 * PLAN.md's "requiring front-desk follow-up" language need. This table is
 * that record; `rooms.has_discrepancy` remains the fast live flag
 * (`src/modules/housekeeping/service.js` keeps both in sync in the same
 * transaction), matching the two-columns-for-two-purposes pattern
 * `reservations.status` + `folios.status` already use elsewhere.
 *
 * Scope: PROPERTY_SCOPED, following `rooms`.
 *
 * No UNIQUE constraint: a room can accumulate more than one resolved
 * discrepancy over its lifetime (a new one after a later stay), so
 * uniqueness is enforced in the SERVICE layer only for the "one open
 * (unresolved) discrepancy per room" invariant — the same class of
 * business-rule-not-schema-constraint `reservation_rooms`' "one open
 * assignment per room" already is, since a resolved-then-reopened case is a
 * legitimate new row here, not a collision.
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
  await knex.schema.createTable('housekeeping_discrepancies', (table) => {
    table.comment(
      'A raised front-desk-vs-housekeeping occupancy status mismatch, requiring explicit front-desk resolution. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('room_id').unsigned().notNullable();
    table.date('business_date').notNullable();

    table
      .enu('front_desk_status', ['vacant', 'occupied'])
      .notNullable()
      .comment('rooms.front_desk_status at the moment the discrepancy was raised.');
    table
      .enu('housekeeping_status', ['vacant', 'occupied'])
      .notNullable()
      .comment('rooms.housekeeping_occupancy_observed at the moment the discrepancy was raised.');

    table.datetime('raised_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('resolved_at').nullable();
    table.bigInteger('resolved_by_user_id').unsigned().nullable();
    table.text('resolution_note').nullable();

    timestamps(knex, table);

    table
      .foreign(['tenant_id', 'property_id'], 'housekeeping_discrepancies_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // Shortened to stay clear of MySQL's 64-char identifier limit — the same
    // class of truncation Phase 1's `rate_calendar` migration already hit.
    table
      .foreign(['tenant_id', 'property_id', 'room_id'], 'hk_discrepancies_tenant_property_room_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'resolved_by_user_id'], 'hk_discrepancies_tenant_resolved_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The discrepancy report's own primary read: unresolved rows for a property.
    table.index(['tenant_id', 'property_id', 'resolved_at'], 'housekeeping_discrepancies_open_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('housekeeping_discrepancies');
};
