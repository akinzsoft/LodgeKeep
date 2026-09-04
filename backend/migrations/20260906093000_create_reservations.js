'use strict';

/**
 * Reservations — PLAN.md Phase 2, PRODUCT_REQUIREMENTS.md §3.2/§3.3,
 * ARCHITECTURE.md §11 (the authoritative state machine — see below),
 * DATABASE.md §1 ("reservations | guest_id, group_block_id, rate_code_id,
 * market_segment_id, booking_source_id, arrival_date, departure_date,
 * adults, children, status, confirmation_number, checked_in_at,
 * checked_out_at, cancellation_policy_id").
 *
 * Scope: PROPERTY_SCOPED. Its own `(tenant_id, property_id, id)` unique key
 * is the parent for `reservation_rooms`, `reservation_daily_rates`,
 * `reservation_notes`, and `folios` (all in migrations that follow this
 * one), the same 3-column composite pattern every PROPERTY_SCOPED-
 * table-references-PROPERTY_SCOPED-table case has used since Phase 1.
 *
 * ── STATUS ENUM — ARCHITECTURE.md §11 PLUS ONE, PLUS ONE MORE ─────────────
 *
 * §11's graph: INQUIRY -> TENTATIVE -> CONFIRMED -> CHECKED_IN ->
 * CHECKED_OUT, with CONFIRMED -> CANCELLED/NO_SHOW and TENTATIVE ->
 * EXPIRED/CANCELLED. `INQUIRY` is not modelled as a stored status here — §11
 * itself calls it optional ("a direct booking or a staff-entered confirmed
 * reservation can skip straight to CONFIRMED"), and nothing in
 * PRODUCT_REQUIREMENTS.md's UI screens or TESTING.md's RES and FD test cases
 * names an inquiry-stage screen or test — modelling a status with no
 * transition ever tested or shown would be exactly the ahead-of-phase
 * mistake `rbac.js`'s literal-catalogue note warns against elsewhere in this
 * codebase. `waitlisted` is added as its own real, distinct value (this
 * session's confirmed decision) even though §11's table doesn't enumerate
 * it: PRODUCT_REQUIREMENTS.md §3.2 gives waitlist its own UI screen and
 * TESTING.md's status-filter language treats it as separate from
 * `confirmed`, so aliasing it onto `tentative` would contradict both.
 *
 * `no_show` and `expired` are both real §11 terminal states and are in the
 * enum; the service layer's `isValidTransition` pure function (see
 * `src/modules/reservations/service.js`) is what actually enforces the
 * graph — this column only bounds the possible values, exactly like every
 * other status enum in this schema.
 *
 * ── ROOM ASSIGNMENT: NOT ON THIS TABLE ──────────────────────────────────
 *
 * There is deliberately no `room_id` column here (this session's confirmed
 * decision): a reservation books a room TYPE and a date range, and a
 * specific physical room is assigned only at check-in, recorded in
 * `reservation_rooms` (next-but-one migration). Pre-assignment at booking
 * time was considered and explicitly declined for this pass.
 *
 * ── PARENTS THAT ARE DELIBERATELY NULLABLE, NO FK ───────────────────────
 *
 * `market_segment_id`, `booking_source_id`, `cancellation_policy_id`,
 * `group_block_id` are all present as columns (matching DATABASE.md's field
 * list and saving a later migration from having to ADD them) but nullable
 * and carry no foreign key: their parent tables (`market_segments`,
 * `booking_sources`, `cancellation_policies`, `group_blocks`) don't exist —
 * the first three were explicitly deferred out of Phase 1 already, and
 * group bookings are Phase 4 (§3.7) territory. A later migration that
 * creates one of those tables adds the FK then, the same pattern
 * `guest_accounts.guest_id` used from Phase 0 until this very migration
 * filled in its `guests` FK.
 *
 * `guest_id` DOES carry a real FK — `guests` (this migration set's own
 * prerequisite, 20260906091000) already exists.
 *
 * `confirmation_number` is a ULID (ARCHITECTURE.md §10: "UUID/ULID ... safe
 * to expose without revealing sequence/volume information"), generated in
 * the service layer, never a sequential integer.
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
  await knex.schema.createTable('reservations', (table) => {
    table.comment(
      'A booked stay for one guest at one property. Scope: PROPERTY_SCOPED. Status transitions follow ARCHITECTURE.md section 11 exactly; never a bare status-column update.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.bigInteger('guest_id').unsigned().notNullable();
    table.bigInteger('room_type_id').unsigned().notNullable();
    table.bigInteger('rate_code_id').unsigned().notNullable();

    table
      .bigInteger('market_segment_id')
      .unsigned()
      .nullable()
      .comment('No FK yet — market_segments does not exist (deferred out of Phase 1). See file header.');
    table
      .bigInteger('booking_source_id')
      .unsigned()
      .nullable()
      .comment('No FK yet — booking_sources does not exist (deferred out of Phase 1). See file header.');
    table
      .bigInteger('cancellation_policy_id')
      .unsigned()
      .nullable()
      .comment('No FK yet — cancellation_policies does not exist (deferred out of Phase 1). See file header.');
    table
      .bigInteger('group_block_id')
      .unsigned()
      .nullable()
      .comment('No FK yet — group_blocks is Phase 4 (PLAN.md section 3.7). See file header.');

    table.date('arrival_date').notNullable();
    table.date('departure_date').notNullable();
    table.integer('adults').unsigned().notNullable().defaultTo(1);
    table.integer('children').unsigned().notNullable().defaultTo(0);

    table
      .enu('status', [
        'waitlisted',
        'tentative',
        'confirmed',
        'checked_in',
        'checked_out',
        'cancelled',
        'no_show',
        'expired',
      ])
      .notNullable();

    table
      .string('confirmation_number', 26)
      .notNullable()
      .comment('ULID (ARCHITECTURE.md section 10) — safe to expose, reveals no sequence/volume.');

    table.datetime('checked_in_at').nullable();
    table.datetime('checked_out_at').nullable();
    table.datetime('cancelled_at').nullable();
    table.text('cancellation_reason').nullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'confirmation_number'], {
      indexName: 'reservations_tenant_id_confirmation_number_unique',
    });

    // Parent key for reservation_rooms / reservation_daily_rates /
    // reservation_notes / folios' composite FKs.
    table.unique(['tenant_id', 'property_id', 'id'], {
      indexName: 'reservations_tenant_id_property_id_id_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'reservations_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // 2-column: guests is TENANT_SCOPED, not property-scoped (file header).
    table
      .foreign(['tenant_id', 'guest_id'], 'reservations_tenant_id_guest_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('guests')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // 3-column: room_types/rate_codes are PROPERTY_SCOPED — must be the SAME
    // property (the established Phase 1 reasoning, repeated at every one of
    // these since room_types' own migration header).
    table
      .foreign(['tenant_id', 'property_id', 'room_type_id'], 'reservations_tenant_id_property_id_room_type_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('room_types')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'rate_code_id'], 'reservations_tenant_id_property_id_rate_code_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rate_codes')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // DATABASE.md's own indexing note: "reservations on
    // (property_id, arrival_date, status) for the arrivals board."
    table.index(['tenant_id', 'property_id', 'arrival_date', 'status'], 'reservations_arrivals_board_index');
    table.index(['tenant_id', 'property_id', 'departure_date', 'status'], 'reservations_departures_board_index');
    table.index(['tenant_id', 'property_id', 'guest_id'], 'reservations_tenant_id_property_id_guest_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('reservations');
};
