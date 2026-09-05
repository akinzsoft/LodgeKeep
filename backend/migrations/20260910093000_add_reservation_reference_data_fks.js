'use strict';

/**
 * Closes the forward reference `reservations` (20260906093000) left open on
 * `market_segment_id`/`booking_source_id`/`cancellation_policy_id` — those
 * three parent tables now exist (this migration set's three prior files).
 * `group_block_id` stays FK-less; `group_blocks` is Phase 4 (§3.7), still
 * unbuilt.
 *
 * All three are the same 3-column composite FK pattern
 * `rooms.room_type_id` established in Phase 1: a reservation's market
 * segment/booking source/cancellation policy must belong to the SAME
 * property, not just the same tenant. Every one of the three referenced
 * columns is nullable, and MySQL's default MATCH SIMPLE semantics skip FK
 * enforcement entirely when any column in a composite FK is NULL — the
 * identical reasoning the `outbox_events` property_id FK fix (Phase 3)
 * already relied on for its own nullable attribution column.
 *
 * The cancellation-policy FK's fully-spelled-out name would be 65
 * characters — one over MySQL's 64-character identifier limit, the same
 * class of bug Phase 1's `rate_calendar` migration and Phase 2's
 * `reservation_daily_rates` migration both already hit — so it's shortened
 * to `..._cancel_policy_id_foreign` below.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.alterTable('reservations', (table) => {
    table
      .foreign(['tenant_id', 'property_id', 'market_segment_id'], 'reservations_tenant_id_property_id_market_segment_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('market_segments')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'booking_source_id'], 'reservations_tenant_id_property_id_booking_source_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('booking_sources')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(
        ['tenant_id', 'property_id', 'cancellation_policy_id'],
        'reservations_tenant_id_property_id_cancel_policy_id_foreign'
      )
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('cancellation_policies')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('reservations', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'market_segment_id'], 'reservations_tenant_id_property_id_market_segment_id_foreign');
    table.dropForeign(['tenant_id', 'property_id', 'booking_source_id'], 'reservations_tenant_id_property_id_booking_source_id_foreign');
    table.dropForeign(
      ['tenant_id', 'property_id', 'cancellation_policy_id'],
      'reservations_tenant_id_property_id_cancel_policy_id_foreign'
    );
  });
};
