'use strict';

/**
 * Per-outlet service charge.
 *
 * - `pos_outlets.service_charge_percent`: the Register's service charge rate (was a fixed 7.5 in code),
 *   0 to 30 with 2 decimals. Default 7.50, so every existing outlet charges exactly what it did.
 * - `pos_outlets.qr_service_charge_mode`: 'charge' (guest QR orders add that percent) or 'none'.
 *   Default 'none', so existing QR bills do not change.
 * - `pos_guest_order_service_charges` (PROPERTY_SCOPED): the rate frozen when a guest places a QR order at
 *   an outlet in 'charge' mode, so a later rate change never alters what that guest was shown or pays. One
 *   row per tab, written only in 'charge' mode: an ordinary QR order writes nothing new.
 */
const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_outlets', (table) => {
    table.decimal('service_charge_percent', 5, 2).notNullable().defaultTo('7.50');
    table.string('qr_service_charge_mode', 10).notNullable().defaultTo('none');
  });

  await knex.schema.createTable('pos_guest_order_service_charges', (table) => {
    table.comment('The service charge rate frozen when a guest QR order was placed. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('pos_order_id').unsigned().notNullable();
    table.decimal('service_charge_percent', 5, 2).notNullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'property_id', 'pos_order_id'], { indexName: 'pos_guest_order_sc_tenant_property_order_unique' });
    table
      .foreign(['tenant_id', 'property_id'], 'pos_guest_order_sc_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'pos_order_id'], 'pos_guest_order_sc_tenant_property_order_fk')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_orders')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_guest_order_service_charges');
  await knex.schema.alterTable('pos_outlets', (table) => {
    table.dropColumn('qr_service_charge_mode');
    table.dropColumn('service_charge_percent');
  });
};
