'use strict';

/**
 * `group_block_rooms` — the per (room type, night) target a `group_blocks`
 * row is negotiated for. See `20260920090000_create_group_blocks.js`'s own
 * header for the full tracking-only reasoning.
 *
 * Deliberately carries NO `rooms_picked_up` column, unlike DATABASE.md's
 * original aspirational draft (rewritten in this same pass to match). Real
 * pickup is always computed live by `src/modules/group-blocks/pickup.js`'s
 * `computePickupRows`, from the actual `reservations` rows tagged with this
 * block's id — never a second, independently-maintained running total that
 * could drift from what was really booked. The identical discipline this
 * codebase already applies to `ar_accounts.current_balance` and
 * `folios.balance`.
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
  await knex.schema.createTable('group_block_rooms', (table) => {
    table.comment(
      'The negotiated rooms_blocked target for one room type on one night of a group block. Pickup is always derived live, never stored here. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('group_block_id').unsigned().notNullable();
    table.bigInteger('room_type_id').unsigned().notNullable();
    table.date('stay_date').notNullable();
    table.integer('rooms_blocked').unsigned().notNullable();

    timestamps(knex, table);

    table.unique(
      ['tenant_id', 'property_id', 'group_block_id', 'room_type_id', 'stay_date'],
      { indexName: 'group_block_rooms_block_type_date_unique' }
    );

    table
      .foreign(['tenant_id', 'property_id'], 'group_block_rooms_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'group_block_id'], 'group_block_rooms_tenant_property_block_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('group_blocks')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'room_type_id'], 'group_block_rooms_tenant_property_room_type_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('room_types')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'group_block_id'], 'group_block_rooms_tenant_property_block_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('group_block_rooms');
};
