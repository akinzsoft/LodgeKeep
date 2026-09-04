'use strict';

/**
 * Reservation daily rates — DATABASE.md §1: "reservation_daily_rates |
 * reservation_id, stay_date, rate, currency | Rate can vary per night;
 * storing it prevents retroactive rate changes altering a booked stay."
 *
 * Scope: PROPERTY_SCOPED.
 *
 * The rate for every night of a stay is resolved once, at booking time
 * (`resolveRate` — the same pure function Phase 1's setup module already
 * built and tested), and copied into one row per night here. TESTING.md
 * RES-7/RES-8: this is what makes "rate code changed after booking ->
 * existing reservation's nightly rates unchanged" true without the
 * reservation needing to re-resolve anything against a live `rate_codes`/
 * `rate_calendar` row ever again — the same "snapshot at commitment,
 * unaffected by what changes later" shape ARCHITECTURE.md §12.2 requires of
 * FX rates, applied here to room rates instead.
 *
 * `UNIQUE(reservation_id, stay_date)`: exactly one rate per reservation per
 * night — DATABASE.md §2's own required-uniqueness list.
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
  await knex.schema.createTable('reservation_daily_rates', (table) => {
    table.comment(
      'The rate captured for one reservation, one night, at booking time. Scope: PROPERTY_SCOPED. Never updated by a later rate-code change (DATABASE.md section 1).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('reservation_id').unsigned().notNullable();

    table.date('stay_date').notNullable();
    table.decimal('rate', 12, 2).notNullable();
    table.string('currency', 3).notNullable();

    timestamps(knex, table);

    table.unique(['reservation_id', 'stay_date'], {
      indexName: 'reservation_daily_rates_reservation_id_stay_date_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'reservation_daily_rates_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(
        ['tenant_id', 'property_id', 'reservation_id'],
        'reservation_daily_rates_tenant_property_reservation_foreign'
      )
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('reservations')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(
      ['tenant_id', 'property_id', 'reservation_id'],
      'reservation_daily_rates_tenant_property_reservation_index'
    );
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('reservation_daily_rates');
};
