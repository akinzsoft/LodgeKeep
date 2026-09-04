'use strict';

/**
 * Reservation rooms — the physical-room assignment history for a
 * reservation. DATABASE.md §1: "reservation_rooms | reservation_id,
 * room_id, effective_from, effective_to | Room moves keep history — never
 * overwrite."
 *
 * Scope: PROPERTY_SCOPED.
 *
 * First row is written at check-in, not at booking (this session's
 * confirmed decision — see `reservations` migration's header: there is no
 * `room_id` on `reservations` itself). A room move (front desk, §3.3) closes
 * the current row's `effective_to` and opens a new row, inside one
 * transaction (ARCHITECTURE.md §4's transaction-boundary table names "room
 * move" explicitly) — never an UPDATE to `room_id` in place, which is
 * exactly the history DATABASE.md's own note says must survive.
 *
 * `room_id` FKs against `rooms` with the 3-column composite
 * `(tenant_id, property_id, id)` key that table has carried since Phase 1 —
 * no prerequisite ALTER needed here, unlike `room_type_inventory`'s and
 * `reservations`' own new parent keys.
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
  await knex.schema.createTable('reservation_rooms', (table) => {
    table.comment(
      'One period a reservation occupied one physical room. Scope: PROPERTY_SCOPED. Never overwritten — a room move closes this row and opens a new one (DATABASE.md section 1).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('reservation_id').unsigned().notNullable();
    table.bigInteger('room_id').unsigned().notNullable();

    table.datetime('effective_from').notNullable();
    table.datetime('effective_to').nullable().comment('NULL = this is the current assignment.');

    table.text('reason').nullable().comment('Room-move reason — feeds the audit trail (PRODUCT_REQUIREMENTS.md section 3.3\'s room move/upgrade screen).');

    timestamps(knex, table);

    table
      .foreign(['tenant_id', 'property_id'], 'reservation_rooms_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'reservation_id'], 'reservation_rooms_tenant_id_property_id_reservation_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('reservations')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'room_id'], 'reservation_rooms_tenant_id_property_id_room_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'reservation_id'], 'reservation_rooms_tenant_id_property_id_reservation_id_index');
    // "Is this room currently occupied by a live assignment" — the room
    // status board's own lookup.
    table.index(['tenant_id', 'property_id', 'room_id', 'effective_to'], 'reservation_rooms_current_assignment_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('reservation_rooms');
};
