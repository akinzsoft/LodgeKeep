'use strict';

/**
 * Market segments — PLAN.md Phase 1 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.19 ("Market segments & booking sources: needed for meaningful revenue
 * reporting later; if these aren't set up at the start, historical reports
 * can't be reconstructed"), DATABASE.md §1.
 *
 * Scope: PROPERTY_SCOPED, same reasoning as `room_types`/`rate_codes`
 * (ARCHITECTURE.md §3) — two properties in the same tenant segment their
 * business differently and must not share a code list.
 *
 * `reservations.market_segment_id` has existed since the reservations
 * migration (20260906093000) as a nullable, FK-less column with a comment
 * explaining exactly this deferral. This table is that deferred parent;
 * see 20260910093000_add_reservation_reference_data_fks.js for the FK that
 * closes the forward reference, the same two-step pattern
 * `guest_accounts.guest_id` used from Phase 0 until Phase 2 filled it in.
 *
 * Lifecycle: `active -> archived`, never deleted — a reservation may
 * reference a segment retired years later, and reporting needs that
 * historical row to still resolve.
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
  await knex.schema.createTable('market_segments', (table) => {
    table.comment(
      'A revenue-reporting segment a reservation books under (e.g. "Corporate", "Leisure"). Scope: PROPERTY_SCOPED. Archive, never delete.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.string('code', 30).notNullable().comment('Short machine key, unique per property, not globally.');
    table.string('name', 150).notNullable();
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    table.unique(['property_id', 'code'], { indexName: 'market_segments_property_id_code_unique' });

    // Parent key for the composite FK reservations.market_segment_id adds.
    table.unique(['tenant_id', 'property_id', 'id'], {
      indexName: 'market_segments_tenant_id_property_id_id_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'market_segments_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'status'], 'market_segments_tenant_id_property_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('market_segments');
};
