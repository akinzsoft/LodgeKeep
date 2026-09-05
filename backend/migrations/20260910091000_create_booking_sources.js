'use strict';

/**
 * Booking sources — PLAN.md Phase 1 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.19 (paired with `market_segments`, see that migration's header for the
 * full reasoning — this table is the identical shape and closes the
 * identical forward reference on `reservations.booking_source_id`).
 *
 * Scope: PROPERTY_SCOPED. Lifecycle: `active -> archived`, never deleted.
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
  await knex.schema.createTable('booking_sources', (table) => {
    table.comment(
      'Where a reservation originated (e.g. "Direct", "OTA", "Travel Agent"). Scope: PROPERTY_SCOPED. Archive, never delete.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.string('code', 30).notNullable().comment('Short machine key, unique per property, not globally.');
    table.string('name', 150).notNullable();
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    table.unique(['property_id', 'code'], { indexName: 'booking_sources_property_id_code_unique' });

    table.unique(['tenant_id', 'property_id', 'id'], {
      indexName: 'booking_sources_tenant_id_property_id_id_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'booking_sources_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'status'], 'booking_sources_tenant_id_property_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('booking_sources');
};
