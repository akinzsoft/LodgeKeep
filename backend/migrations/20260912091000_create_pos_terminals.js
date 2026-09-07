'use strict';

/**
 * `pos_terminals` — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md §3.4:
 * "Terminals assigned to an outlet; count varies per customer, never
 * hardcoded." DATABASE.md's own `pos_terminals | outlet_id, device_ref,
 * supports_contactless` row.
 *
 * Scope: PROPERTY_SCOPED, following `pos_outlets` (its parent) for the
 * same reason every outlet-adjacent table does.
 *
 * `device_ref` is a free string identifying the physical/logical terminal
 * (a device id, a browser-tab session name, whatever the deployment uses)
 * — `UNIQUE(outlet_id, device_ref)` per DATABASE.md §2, so the same ref
 * can be reused across different outlets/properties without a global
 * collision.
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
  await knex.schema.createTable('pos_terminals', (table) => {
    table.comment('A physical/logical POS terminal assigned to one outlet. Scope: PROPERTY_SCOPED. Archive, never delete.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();

    table.string('device_ref', 100).notNullable().comment('Free string identifying the device — never hardcode a terminal count.');
    table
      .boolean('supports_contactless')
      .notNullable()
      .defaultTo(false)
      .comment('PRODUCT_REQUIREMENTS.md §2: a hardware fact to confirm at procurement, not something this layer can add later.');
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    table.unique(['outlet_id', 'device_ref'], { indexName: 'pos_terminals_outlet_id_device_ref_unique' });
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'pos_terminals_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'pos_terminals_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_terminals_tenant_id_property_id_outlet_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'outlet_id'], 'pos_terminals_tenant_id_property_id_outlet_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_terminals');
};
