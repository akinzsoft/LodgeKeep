'use strict';

/**
 * `stock_takes` — PLAN.md Phase 6. The header row of a physical inventory
 * count at one outlet — opened, counted blind (per `stock_take_lines`'
 * own header), then completed (revealing variance and posting
 * `count_adjustment` movements) or cancelled outright.
 *
 * Scope: PROPERTY_SCOPED, following `pos_outlets`.
 *
 * `status`: `open` (counting in progress) -> `completed` (variance
 * computed, adjustments posted, terminal) or `cancelled` (abandoned before
 * completion, no stock effect at all). Cancel/complete fields mirror
 * `pos_orders`' own void-field shape — the identical "attributable,
 * reasoned, timestamped" pattern for a terminal state transition.
 *
 * `business_date` is set only at completion (from `properties.current_business_date`
 * at that moment) — an open take has no business date of its own yet, the
 * same "the fact isn't known until the action happens" reasoning
 * `pos_orders.closed_at` already follows.
 *
 * This migration also adds the ONE foreign key `20261001092000`'s own
 * `stock_movements` table deliberately deferred — `stock_movements.stock_take_id`
 * -> `stock_takes` — since knex/MySQL cannot reference a table that does
 * not exist yet at the point that earlier migration ran.
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
  await knex.schema.createTable('stock_takes', (table) => {
    table.comment('One physical inventory count at an outlet — open, blind-counted, then completed or cancelled. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();

    table.enu('status', ['open', 'completed', 'cancelled']).notNullable().defaultTo('open');

    table.bigInteger('opened_by_user_id').unsigned().notNullable();
    table.datetime('opened_at').notNullable().defaultTo(knex.fn.now());

    table.bigInteger('completed_by_user_id').unsigned().nullable();
    table.datetime('completed_at').nullable();
    table.date('business_date').nullable().comment('Set only at completion — see migration header.');

    table.datetime('cancelled_at').nullable();
    table.string('cancel_reason', 255).nullable();
    table.bigInteger('cancelled_by_user_id').unsigned().nullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'stock_takes_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'stock_takes_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'stock_takes_outlet_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'opened_by_user_id'], 'stock_takes_opened_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'completed_by_user_id'], 'stock_takes_completed_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'cancelled_by_user_id'], 'stock_takes_cancelled_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'outlet_id', 'status'], 'stock_takes_by_outlet_status_index');
  });

  // The FK `20261001092000_create_stock_movements.js` deliberately
  // deferred — stock_takes did not exist yet at that point.
  await knex.schema.alterTable('stock_movements', (table) => {
    table
      .foreign(['tenant_id', 'property_id', 'stock_take_id'], 'stock_movements_stock_take_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('stock_takes')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('stock_movements', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'stock_take_id'], 'stock_movements_stock_take_foreign');
  });
  await knex.schema.dropTableIfExists('stock_takes');
};
