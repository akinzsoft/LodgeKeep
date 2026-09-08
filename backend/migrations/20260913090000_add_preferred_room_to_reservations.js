'use strict';

/**
 * Gap closure (Reservations/Front Desk): a guest-requested room number,
 * stored as a REQUEST recorded at booking time — never a lock. Distinct
 * from the actual room assignment, which still only ever happens at
 * check-in via `reservation_rooms` (Phase 2's confirmed decision, unchanged
 * here). `checkIn` continues to accept any `room_id`; this column is purely
 * informational, read by the front-desk check-in picker to pre-select a
 * suggestion when the guest's preferred room happens to still be free.
 *
 * PRODUCT_REQUIREMENTS.md §3.2/§3.3 never name a "preferred room" concept —
 * confirmed by reading both sections directly, not assumed. This is a
 * genuine gap being designed now, not a spec item that was left unbuilt.
 *
 * 3-column composite FK — `rooms` is PROPERTY_SCOPED, the same
 * `room_type_id`/`rate_code_id` pattern this table already carries: a
 * preferred room must belong to the SAME property. Nullable throughout —
 * MySQL's default MATCH SIMPLE semantics skip FK enforcement when any
 * composite-FK column is NULL, the same reasoning
 * `20260910093000_add_reservation_reference_data_fks.js` already relies on.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.alterTable('reservations', (table) => {
    table
      .bigInteger('preferred_room_id')
      .unsigned()
      .nullable()
      .comment('A guest-requested room number — a preference recorded at booking time, never a lock. Actual assignment still only happens at check-in (reservation_rooms).');
  });

  await knex.schema.alterTable('reservations', (table) => {
    table
      .foreign(['tenant_id', 'property_id', 'preferred_room_id'], 'reservations_tenant_id_property_id_preferred_room_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('reservations', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'preferred_room_id'], 'reservations_tenant_id_property_id_preferred_room_id_foreign');
    table.dropColumn('preferred_room_id');
  });
};
