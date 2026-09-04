'use strict';

/**
 * Room type inventory — the row the last-room race locks. PLAN.md Phase 2
 * ("pull forward deliberately: the last-room race"), ARCHITECTURE.md §5
 * (the named canonical concurrency example), PRODUCT_REQUIREMENTS.md §3.2
 * ("overbooking threshold per room type/date... sell up to 102% of physical
 * inventory... availability search must check against this threshold, not
 * raw physical inventory").
 *
 * Filed by DATABASE.md §1 under the Setup module (§3.19), but not among the
 * five items Phase 1 actually built — Reservations' entire availability and
 * last-room-race mechanism depends on it, so it lands here as a Reservations
 * prerequisite instead (this session's confirmed decision).
 *
 * Scope: PROPERTY_SCOPED, following its parent `room_types` for the same
 * reason `rooms`/`rate_calendar` did in Phase 1.
 *
 * ── ROWS_SOLD, NOT physical_rooms — SEE THE SERVICE LAYER FOR THE FULL RULE ──
 *
 * DATABASE.md's own §1 row for this table currently names a stored
 * `physical_rooms` column. That column is NOT created here, and DATABASE.md
 * is updated in this same pass to match what is actually built: physical
 * availability is computed LIVE at lock time — `COUNT(rooms WHERE
 * room_type_id = X AND status = 'active')` — using the `rooms.status`
 * column Phase 1 already built, rather than cached into this table.
 *
 * The reason is staleness, not effort: a stored `physical_rooms` count would
 * need every room create/archive/out-of-service transition in the `rooms`
 * table to also write here, for every future date that already has a row —
 * a second source of truth that drifts the moment those two writes are not
 * perfectly kept in lockstep. Computing it live means a room going
 * out_of_service today is reflected in every future date's availability
 * immediately, with nothing to keep in sync.
 *
 * The real cost, flagged rather than hidden: this only reflects a room's
 * CURRENT status, not a scheduled future window — there is no way yet to
 * say "room 204 will be out of service from the 10th to the 15th" in
 * advance. That is date-ranged out-of-order tracking (DATABASE.md's
 * `out_of_order_periods`, filed under Rooms/Housekeeping §3.6), which does
 * not exist and is not in this pass's scope.
 *
 * `rooms_sold` is the row this table actually owns: an atomic counter,
 * incremented inside the reservation-creation transaction under
 * `SELECT ... FOR UPDATE`, decremented on cancellation/no-show release. The
 * row is created lazily (INSERT IGNORE-then-lock, see the service layer) on
 * the first booking attempt for a given (room_type, date) rather than
 * pre-generated for every future date, since pre-generating a calendar of
 * empty rows for every room type indefinitely into the future is pure
 * waste until a date actually has a sale against it.
 *
 * `overbooking_threshold_pct` lives per (room_type, date) row rather than as
 * a room_types-level default, because PRODUCT_REQUIREMENTS.md §3.2
 * literally says "per room type/date" — a property may want a higher
 * threshold over a specific high-demand weekend than its everyday policy.
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
  await knex.schema.createTable('room_type_inventory', (table) => {
    table.comment(
      'Sellable-inventory counter for one room type on one stay date — the row the last-room race locks. Scope: PROPERTY_SCOPED. See file header for why there is no stored physical_rooms column.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('room_type_id').unsigned().notNullable();
    table.date('stay_date').notNullable();

    table
      .integer('rooms_sold')
      .unsigned()
      .notNullable()
      .defaultTo(0)
      .comment('Atomic counter — incremented/decremented only inside a SELECT ... FOR UPDATE transaction (ARCHITECTURE.md section 5).');

    table
      .decimal('overbooking_threshold_pct', 6, 2)
      .notNullable()
      .defaultTo(100.0)
      .comment('e.g. 102.00 = sell up to 102% of live physical count. Per (room type, date) per PRODUCT_REQUIREMENTS.md section 3.2.');

    timestamps(knex, table);

    table.unique(['property_id', 'room_type_id', 'stay_date'], {
      indexName: 'room_type_inventory_property_id_room_type_id_stay_date_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'room_type_inventory_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // 3-column composite: a room type must belong to the SAME property
    // (room_types migration's own established header reasoning).
    table
      .foreign(
        ['tenant_id', 'property_id', 'room_type_id'],
        'room_type_inventory_tenant_id_property_id_room_type_id_foreign'
      )
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('room_types')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(
      ['tenant_id', 'property_id', 'room_type_id', 'stay_date'],
      'room_type_inventory_lookup_index'
    );
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('room_type_inventory');
};
