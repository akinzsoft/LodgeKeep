'use strict';

/**
 * Closes the forward reference `reservations` (20260906093000) left open on
 * `group_block_id` — the last of the four deliberately FK-less columns that
 * migration named; the other three (`market_segment_id`, `booking_source_id`,
 * `cancellation_policy_id`) were already closed by
 * `20260910093000_add_reservation_reference_data_fks.js`. `group_blocks` now
 * exists (this migration set's two prior files).
 *
 * Same 3-column composite FK pattern as its three siblings: a reservation's
 * group block must belong to the SAME property, not just the same tenant.
 * The column is nullable, and MySQL's default MATCH SIMPLE semantics skip FK
 * enforcement entirely when any column in a composite FK is NULL — the
 * identical reasoning `20260910093000`'s own header already relies on.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.alterTable('reservations', (table) => {
    table
      .foreign(['tenant_id', 'property_id', 'group_block_id'], 'reservations_tenant_property_group_block_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('group_blocks')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('reservations', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'group_block_id'], 'reservations_tenant_property_group_block_id_foreign');
  });
};
