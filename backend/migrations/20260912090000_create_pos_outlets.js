'use strict';

/**
 * `pos_outlets` — PLAN.md Phase 4's POS core (PRODUCT_REQUIREMENTS.md
 * §3.4: "Multiple outlets per property (bar, restaurant, room service,
 * spa, poolside), each with its own menu, tax treatment, and opening
 * hours"), DATABASE.md's own `pos_outlets | property_id, name, type` row.
 *
 * Scope: PROPERTY_SCOPED — two properties in the same tenant run entirely
 * separate bars/restaurants, the same reasoning `room_types` established
 * in Phase 1. `code` is added beyond DATABASE.md's literal two-column
 * draft, matching every other reference-data table in this codebase
 * (`room_types`, `market_segments`, ...) rather than leaving outlets
 * addressable only by a free-text name.
 *
 * `type` is a short free-text label, not an enum — DATABASE.md's own
 * example list ("bar, restaurant, room_service, spa, poolside") is
 * illustrative, not exhaustive (PRODUCT_REQUIREMENTS.md's own phrasing:
 * "bar, restaurant, room service, spa, poolside"), and a property may run
 * an outlet type this list didn't anticipate — the same "free string, not
 * an enum" reasoning `payments.provider` already uses for exactly this
 * kind of open-ended category.
 *
 * "Tax treatment" and "opening hours" (both named in the product
 * requirement) are NOT columns here — tax is resolved the same way every
 * other charge in this codebase resolves it, through the property-wide
 * effective tax versions in `taxes` (`taxes.applies_to` already supports a
 * `'pos_charge'` category with zero schema change — see
 * `cashiering/tax-engine.js`), not a second, outlet-scoped tax mechanism.
 * Opening hours are correctly out of this pass's scope — nothing in POS
 * core enforces or displays them yet; flagged, not silently invented.
 *
 * Lifecycle: `active -> archived`, never deleted — historical orders
 * reference an outlet years later.
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
  await knex.schema.createTable('pos_outlets', (table) => {
    table.comment(
      'A bar/restaurant/room-service/spa/poolside point-of-sale outlet. Scope: PROPERTY_SCOPED. Archive, never delete.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.string('code', 30).notNullable().comment('Short machine key, unique per property, not globally.');
    table.string('name', 150).notNullable();
    table.string('type', 30).notNullable().comment('Free string, e.g. "bar", "restaurant" — not an enum, see migration header.');
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    table.unique(['property_id', 'code'], { indexName: 'pos_outlets_property_id_code_unique' });

    // Parent key for every child table's composite FK (pos_terminals,
    // pos_menu_items, pos_orders all reference an outlet within the SAME
    // property, per DATABASE.md §2's rule for a PROPERTY_SCOPED table
    // referencing another PROPERTY_SCOPED table).
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'pos_outlets_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'pos_outlets_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'status'], 'pos_outlets_tenant_id_property_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_outlets');
};
