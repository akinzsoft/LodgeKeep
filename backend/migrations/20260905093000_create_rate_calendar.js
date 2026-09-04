'use strict';

/**
 * Rate calendar — PLAN.md Phase 1 ("rate codes and the rate calendar"),
 * DATABASE.md §1 ("rate_calendar | rate_code_id, room_type_id, stay_date,
 * rate | Date-level overrides").
 *
 * Scope: PROPERTY_SCOPED.
 *
 * A row here is a specific (rate code, room type, date)'s override price.
 * Resolution order (TESTING.md SET-6, "date override wins over rate-code
 * base rate"): look up this table for the exact (rate_code_id, room_type_id,
 * stay_date) first; if no row exists, fall back to `rate_codes.base_rate`.
 * That resolution is a plain read, implemented as a pure function in the
 * setup module's service layer — not a database view or trigger — so it is
 * directly unit-testable against dates that do and don't have an override.
 *
 * No lifecycle/status column, unlike `room_types`/`rate_codes`: an override
 * is pure configuration, not itself a financial record (ARCHITECTURE.md §8's
 * "void, never delete" governs *posted* records — a reservation, once Phase 2
 * builds it, stores its own resolved rate rather than a live reference to
 * this row, so deleting or changing an override here cannot retroactively
 * alter history the way changing a `taxes` row could). Ordinary DELETE/UPDATE
 * both stay available through the scoped accessor.
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
  await knex.schema.createTable('rate_calendar', (table) => {
    table.comment(
      'A date-specific rate override for one (rate code, room type) pair. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.bigInteger('rate_code_id').unsigned().notNullable();
    table.bigInteger('room_type_id').unsigned().notNullable();

    table
      .date('stay_date')
      .notNullable()
      .comment('The night this override applies to. A DATE — matches ARCHITECTURE.md §6\'s business-date convention, never a timestamp.');

    table.decimal('rate', 12, 2).notNullable();

    timestamps(knex, table);

    // One override per (rate code, room type, date) — a second row for the
    // same triple would make resolution ambiguous.
    table.unique(['rate_code_id', 'room_type_id', 'stay_date'], {
      indexName: 'rate_calendar_rate_code_id_room_type_id_stay_date_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'rate_calendar_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // 3-column composite FKs (see room_types migration's header): both parents
    // must belong to this exact property, not just this tenant.
    table
      .foreign(['tenant_id', 'property_id', 'rate_code_id'], 'rate_calendar_tenant_id_property_id_rate_code_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rate_codes')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'room_type_id'], 'rate_calendar_tenant_id_property_id_room_type_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('room_types')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The read this table exists for: "every override for this rate code
    // and room type in a date range" (the rate calendar UI's own query).
    // Named concisely rather than following the usual all-columns naming
    // convention verbatim — that name is 66 characters, over MySQL's 64-byte
    // identifier limit.
    table.index(
      ['tenant_id', 'property_id', 'rate_code_id', 'room_type_id', 'stay_date'],
      'rate_calendar_lookup_index'
    );
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('rate_calendar');
};
