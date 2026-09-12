'use strict';

/**
 * `stock_take_lines` — PLAN.md Phase 6. One counted stock item within one
 * `stock_takes` header row.
 *
 * Scope: PROPERTY_SCOPED, following `stock_takes`.
 *
 * ── BLIND COUNTING IS A STRUCTURAL GUARANTEE, NOT A UI CONVENTION ────────
 *
 * The exact same discipline `pos_shifts`' own header already establishes
 * for cash-up: `counted_quantity` is the operator's INPUT, upsertable any
 * number of times while the take is `open` (a genuine recount before
 * submission is normal, hence real `updated_at` usage here — unlike every
 * other table in this pass, which is either append-only or plain config).
 * `theoretical_quantity`/`variance` are nullable and written ONLY by
 * `stock/service.js`'s `completeStockTake`, at completion, reading the
 * item's live `current_quantity` under its own lock at that moment — no
 * earlier read of an open line ever exposes what the system expects, so
 * there is no code path for a client to peek before finishing the count.
 *
 * `UNIQUE(tenant_id, property_id, stock_take_id, stock_item_id)` is both
 * the isolation guard and the literal upsert key `recordStockTakeCount`
 * targets — a second count submission for the same item on the same take
 * updates the existing row rather than creating a duplicate.
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
  await knex.schema.createTable('stock_take_lines', (table) => {
    table.comment('One counted stock item within a stock take. Scope: PROPERTY_SCOPED. Blind — theoretical_quantity/variance written only at completion.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('stock_take_id').unsigned().notNullable();
    table.bigInteger('stock_item_id').unsigned().notNullable();

    table.decimal('counted_quantity', 14, 3).notNullable().comment('The operator\'s blind input — upsertable while the take is open.');
    table.decimal('theoretical_quantity', 14, 3).nullable().comment('The item\'s live current_quantity at the moment of completion — never written before then.');
    table.decimal('variance', 14, 3).nullable().comment('counted_quantity - theoretical_quantity, written only at completion.');

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'stock_take_id', 'stock_item_id'], { indexName: 'stock_take_lines_take_item_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'stock_take_lines_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'stock_take_id'], 'stock_take_lines_stock_take_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('stock_takes')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'stock_item_id'], 'stock_take_lines_stock_item_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('stock_items')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('stock_take_lines');
};
