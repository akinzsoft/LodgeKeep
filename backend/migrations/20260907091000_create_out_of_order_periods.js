'use strict';

/**
 * Date-ranged out-of-order/out-of-service windows — DATABASE.md §1's
 * `out_of_order_periods` row (Rooms/Housekeeping, PRODUCT_REQUIREMENTS.md
 * §3.6/§3.7), and the exact gap the `room_type_inventory` migration's own
 * header flagged in PLAN.md Phase 2: "there is no way yet to say 'room 204
 * will be out of service from the 10th to the 15th' in advance — only a
 * room's CURRENT `rooms.status` is reflected." This table is that missing
 * mechanism, and PLAN.md Phase 3's own test gate ("out-of-order room is
 * excluded from sellable inventory") is written against it, not merely
 * against `rooms.status='out_of_service'` today.
 *
 * Scope: PROPERTY_SCOPED, following `rooms` for the same reason
 * `room_type_inventory` did.
 *
 * `type` distinguishes out-of-order (`ooo`, a housekeeping/maintenance
 * condition — the room could be sold again once fixed) from out-of-service
 * (`oos`, typically a longer or more serious withdrawal) per DATABASE.md's
 * own column note; this pass treats both identically for inventory-exclusion
 * purposes; only the label differs.
 *
 * No `status` column: a period that has passed (`end_date` in the past) is
 * simply no longer relevant to any date range being queried, and one that
 * should end early is closed by updating `end_date` to today rather than a
 * soft-cancel flag — there is no history requirement here the way there is
 * for a financial record (ARCHITECTURE.md §8 does not apply; this is
 * operational scheduling data, not a ledger).
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
  await knex.schema.createTable('out_of_order_periods', (table) => {
    table.comment(
      'A scheduled future or current window during which a room is withdrawn from sellable inventory. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('room_id').unsigned().notNullable();

    table.enu('type', ['ooo', 'oos']).notNullable().comment('ooo = out of order (e.g. housekeeping/minor repair), oos = out of service (longer withdrawal).');
    table.text('reason').notNullable();
    table.date('start_date').notNullable();
    table.date('end_date').notNullable();

    table.bigInteger('created_by_user_id').unsigned().notNullable();

    timestamps(knex, table);

    table
      .foreign(['tenant_id', 'property_id'], 'out_of_order_periods_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // 3-column composite: the room must belong to the SAME property.
    table
      .foreign(['tenant_id', 'property_id', 'room_id'], 'out_of_order_periods_tenant_id_property_id_room_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The range-overlap lookup `livePhysicalCount` runs per stay date.
    table.index(
      ['tenant_id', 'property_id', 'room_id', 'start_date', 'end_date'],
      'out_of_order_periods_lookup_index'
    );
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('out_of_order_periods');
};
