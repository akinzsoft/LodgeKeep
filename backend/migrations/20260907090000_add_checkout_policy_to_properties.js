'use strict';

/**
 * Property-level checkout policy — PLAN.md Phase 3 ("early/late check-out
 * fees, 3.3"), PRODUCT_REQUIREMENTS.md §3.3: "every reservation has a
 * scheduled departure time (property-configurable, e.g. 12:00 noon)."
 *
 * `computeEarlyLateFee` (`src/modules/reservations/service.js`, PLAN.md
 * Phase 2) has always been a pure function taking these values as explicit
 * parameters, because no property-level configuration source existed —
 * every check-out request had to supply its own cutoffs and fee amounts.
 * These four columns are that missing configuration source. `checkOut`
 * (same file, this pass) now reads them as defaults when a caller does not
 * override them explicitly, closing the gap flagged in that function's own
 * comment since Phase 2.
 *
 * Nullable, no defaults on the two times: a property that has not configured
 * a checkout policy yet should behave exactly as before (no fee computed at
 * all if `scheduledCheckoutTime` is absent), not silently apply an invented
 * "12:00 noon" nobody chose — the same "no default that bakes in an
 * assumption" reasoning `properties.timezone`/`base_currency` already used
 * in Phase 0. The two fee columns default to '0.00' — a configured cutoff
 * with no configured fee is a real (if unusual) choice, not an error.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('properties', (table) => {
    table
      .time('scheduled_checkout_time')
      .nullable()
      .comment('The property\'s standard checkout time, e.g. "12:00:00". Null = no checkout policy configured yet.');
    table
      .time('early_checkout_cutoff_time')
      .nullable()
      .comment('Checking out at or before this time triggers the early-departure fee. Null = early-departure fee disabled.');
    table
      .decimal('early_departure_fee', 10, 2)
      .notNullable()
      .defaultTo('0.00')
      .comment('Posted to the folio when a checkout is at or before early_checkout_cutoff_time.');
    table
      .decimal('late_checkout_fee', 10, 2)
      .notNullable()
      .defaultTo('0.00')
      .comment('Posted to the folio when a checkout is after scheduled_checkout_time.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('properties', (table) => {
    table.dropColumn('scheduled_checkout_time');
    table.dropColumn('early_checkout_cutoff_time');
    table.dropColumn('early_departure_fee');
    table.dropColumn('late_checkout_fee');
  });
};
