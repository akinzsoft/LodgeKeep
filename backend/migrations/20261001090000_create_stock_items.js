'use strict';

/**
 * `stock_items` — PLAN.md Phase 6's "POS inventory & stock control"
 * (PRODUCT_REQUIREMENTS.md §3.4), the raw ingredient/consumable catalogue
 * a menu item's recipe (`pos_menu_item_components`, next migration) draws
 * against.
 *
 * Scope: PROPERTY_SCOPED, following `pos_outlets` — two properties in the
 * same tenant run entirely separate bars/kitchens with entirely separate
 * stock rooms.
 *
 * ── UNIT TRACKING IS SAME-UNIT-ONLY, DELIBERATELY ────────────────────────
 *
 * `unit` is a free string (e.g. "ml", "bottle", "kg", "each") with NO
 * conversion table anywhere in this schema. A recipe's own `quantity`
 * (`pos_menu_item_components.quantity`) and a delivery's own quantity
 * (`stock_movements` of `type: 'received'`) must already be expressed in
 * THIS item's own unit — this pass does not build cross-unit conversion
 * (e.g. "1 bottle = 750ml"), a real, deliberately deferred gap, not an
 * oversight. A property tracking a spirit by the millilitre records its
 * recipe quantities and deliveries in millilitres throughout.
 *
 * ── COSTING IS LAST-COST ONLY, NEVER WEIGHTED-AVERAGE ────────────────────
 *
 * `purchase_cost` is a plain, wholesale-replaced value — a goods-received
 * delivery simply overwrites it with that delivery's own unit cost
 * (`stock/service.js`'s `recordGoodsReceived`). This is a deliberate,
 * confirmed scope reduction against the more accurate (and materially
 * harder) weighted-average alternative: no running total of cost×quantity
 * is maintained anywhere.
 *
 * ── `current_quantity` IS CACHED, NEVER INDEPENDENTLY WRITTEN ────────────
 *
 * The same "one source of truth, always re-derived" discipline
 * `folios.balance`/`ar_accounts.current_balance` already establish:
 * `current_quantity` is written ONLY by `recomputeStockItemQuantity`
 * (`stock/service.js`), which re-sums every `stock_movements` row for this
 * item from scratch (`SUM(quantity)`, signed) and writes the result back —
 * never incremented/decremented in place.
 *
 * ── NEGATIVE STOCK IS ALLOWED, NEVER BLOCKED ──────────────────────────────
 *
 * This session's confirmed decision: settlement/deduction always
 * completes, even past zero (a race or bookkeeping drift is a real
 * possibility this pass does not paper over by refusing a sale already in
 * flight). The oversell GUARD is proactive only — once a component's
 * `current_quantity` hits ≤ 0, `applyStockAvailabilityEffects` flips its
 * dependent menu item(s) to `is_available: false`, preventing NEW orders,
 * never blocking one already settling.
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
  await knex.schema.createTable('stock_items', (table) => {
    table.comment(
      'A raw ingredient/consumable a menu item recipe draws against. Scope: PROPERTY_SCOPED. Archive, never delete.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();

    table.string('name', 150).notNullable();
    table.string('unit', 30).notNullable().comment('Free string, e.g. "ml", "bottle", "kg" — no conversion table, see migration header.');
    table.decimal('purchase_cost', 12, 2).notNullable().defaultTo('0.00').comment('Last-cost only — wholesale-replaced by the most recent goods-received delivery, never a weighted average.');
    table.string('supplier', 150).nullable();
    table.decimal('reorder_level', 14, 3).notNullable().defaultTo('0.000');
    table.decimal('current_quantity', 14, 3).notNullable().defaultTo('0.000').comment('Cached, always re-derived from stock_movements via recomputeStockItemQuantity — never written independently.');
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    // Parent key for pos_menu_item_components/stock_movements' own
    // composite FKs, the same 3-column shape `pos_outlets`' own header
    // establishes for a PROPERTY_SCOPED table referenced by another.
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'stock_items_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'stock_items_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'stock_items_tenant_id_property_id_outlet_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'outlet_id', 'status'], 'stock_items_tenant_id_property_id_outlet_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('stock_items');
};
