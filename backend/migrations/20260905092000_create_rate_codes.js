'use strict';

/**
 * Rate codes — PLAN.md Phase 1, DATABASE.md §1 ("rate_codes | code,
 * description, base_rate, currency, valid_from, valid_to").
 *
 * Scope: PROPERTY_SCOPED.
 *
 * A rate code's `base_rate` is the price for a night under that code before
 * any per-room-type or per-date override applies (`rate_calendar`, next
 * migration) — TESTING.md SET-6: "date override wins over rate-code base
 * rate". `currency` is carried per rate code, not assumed from the
 * property's `base_currency` (ARCHITECTURE.md §12.2 lists "Reservation
 * currency — what was quoted to the guest at booking" as a distinct
 * dimension from the property's own accounting currency; a rate code is
 * where that quoted currency is configured).
 *
 * `valid_from`/`valid_to` bound when this *rate code itself* (a plan like
 * "Summer Promo 2026") is offerable — distinct from `taxes`' effective-dating
 * in the next-but-one migration, which governs which *tax version* applied
 * to a historical charge. A rate code going out of `valid_to` does not retroactively
 * change what a past reservation was charged, since `reservations` (Phase 2)
 * will store the resolved rate at booking time, not a live reference to this row.
 *
 * Lifecycle (DATABASE.md §3): `active -> archived`.
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
  await knex.schema.createTable('rate_codes', (table) => {
    table.comment(
      'A rate plan a property sells under (e.g. "BAR", "Summer Promo 2026"). Scope: PROPERTY_SCOPED. Deactivate via status, never delete — reservations and rate history reference this row (DATABASE.md §3).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table
      .string('code', 30)
      .notNullable()
      .comment('Short machine key, e.g. "BAR" (Best Available Rate). Unique per property.');

    table.text('description').nullable();

    // The base nightly price this code quotes before any room-type-specific
    // or date-specific override (rate_calendar) applies.
    table.decimal('base_rate', 12, 2).notNullable();

    table
      .string('currency', 3)
      .notNullable()
      .comment('ISO 4217 — the currency this rate code quotes in (ARCHITECTURE.md §12.2\'s "reservation currency"), not necessarily the property\'s own base_currency.');

    table
      .date('valid_from')
      .notNullable()
      .comment('When this rate code becomes offerable. A DATE, not a datetime — an availability/offer boundary, not a posted transaction (contrast with taxes.effective_from in the next migration).');
    table
      .date('valid_to')
      .nullable()
      .comment('Nullable: an open-ended rate code with no planned end date.');

    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    // UNIQUE(property_id, code) — DATABASE.md §2.
    table.unique(['property_id', 'code'], { indexName: 'rate_codes_property_id_code_unique' });

    // Parent key for rate_calendar's composite FK.
    table.unique(['tenant_id', 'property_id', 'id'], {
      indexName: 'rate_codes_tenant_id_property_id_id_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'rate_codes_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'status'], 'rate_codes_tenant_id_property_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('rate_codes');
};
