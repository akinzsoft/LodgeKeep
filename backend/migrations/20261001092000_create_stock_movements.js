'use strict';

/**
 * `stock_movements` — PLAN.md Phase 6. The append-only ledger every real
 * quantity change in `stock_items.current_quantity` derives from —
 * ARCHITECTURE.md §8's "void, never delete; a correction is an offsetting
 * row" applied to inventory instead of money: no `updated_at`, no void
 * columns at all. A correction (a stock-take variance, a reversed sale) is
 * always a NEW row, never an edit to an existing one.
 *
 * Scope: PROPERTY_SCOPED, following `stock_items`.
 *
 * `quantity` is SIGNED (positive = increase, negative = decrease) — the
 * same convention `folio_line_items.amount` already uses, so
 * `current_quantity = SUM(quantity)` is trivially, always correct, no
 * per-type sign-flipping logic needed anywhere that reads this table.
 *
 * `outlet_id` is denormalized from `stock_items.outlet_id` at write time —
 * avoids a join on the hot per-sale posting path and on outlet-scoped
 * reporting (`stock/reporting.js`).
 *
 * `unit_cost`/`total_cost` are snapshotted from `stock_items.purchase_cost`
 * AT THE MOMENT of this movement, under the same row lock that reads it —
 * ARCHITECTURE.md §12's "lock at commitment, reproduce historically"
 * principle, so a later cost change never retroactively alters what an
 * old movement's cost was understood to be.
 *
 * `type`:
 *   received        — a goods-received delivery (`recordGoodsReceived`)
 *   sold            — deducted by a real POS settlement (`deductStockForSettlement`)
 *   wastage         — a manually recorded loss, reason mandatory (`recordWastage`)
 *   transfer        — reserved for a future outlet-to-outlet transfer; UNUSED this pass
 *   count_adjustment — a stock-take's own variance, posted at completion
 *   sale_reversal   — a settlement void's stock-side undo (`reverseStockForSettlement`);
 *                     the direct counterpart of an original `sold` row, restating
 *                     that row's OWN business_date, never today's
 *
 * `pos_order_id`/`pos_order_settlement_id` are set only for `sold`/
 * `sale_reversal`; `reversed_movement_id` (a self-FK) is set only for
 * `sale_reversal`, pointing at the exact `sold` row it undoes —
 * `voidSettlement`'s own reversal lookup key. `stock_take_id` is set only
 * for `count_adjustment`. None of these four carry a CHECK constraint
 * tying them to `type` — MySQL 8 CHECK constraints exist but this
 * schema's own convention (confirmed across every other polymorphic-by-type
 * table here, e.g. `folio_line_items`) is to enforce that shape in the
 * service layer, not the database.
 *
 * `user_id` is NULLABLE — a QR guest order settled via `settleOrder({...,
 * settledByUserId: null})` (PLAN.md Phase 6's own QR self-ordering pass)
 * has no staff identity to attribute a `sold` deduction to.
 *
 * FK constraint names are all explicitly shortened (not knex's
 * auto-generated `<table>_<cols>_foreign` shape) — this table has six real
 * foreign keys, and MySQL's 64-character identifier limit has already bit
 * this codebase at least twice before (`rate_calendar`,
 * `cancellation_policies`) on a table with far fewer columns than this
 * one.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  // `pos_order_settlements` (20260912095000) has never before needed to be
  // the PARENT of another table's composite foreign key — it has only ever
  // been a child (of `pos_orders`/`folios`/`users`), so its own migration
  // never added the 3-column `(tenant_id, property_id, id)` unique key a
  // composite FK needs to reference. `stock_movements.pos_order_settlement_id`
  // is the first caller that needs it — added here via ALTER rather than
  // editing that already-shipped migration, the same "extend, don't
  // rewrite history" discipline `stock_takes`' own deferred-FK migration
  // (next file) follows for the identical reason.
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'pos_order_settlements_tenant_id_property_id_id_unique' });
  });

  await knex.schema.createTable('stock_movements', (table) => {
    table.comment(
      'Append-only inventory ledger — every real quantity change. Scope: PROPERTY_SCOPED. No update, no delete; a correction is a new offsetting row (ARCHITECTURE.md §8).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable().comment('Denormalized from stock_items.outlet_id at write time — avoids a join on the hot posting/reporting path.');
    table.bigInteger('stock_item_id').unsigned().notNullable();

    table.enu('type', ['received', 'sold', 'wastage', 'transfer', 'count_adjustment', 'sale_reversal']).notNullable();
    table.decimal('quantity', 14, 3).notNullable().comment('Signed — positive increases current_quantity, negative decreases it.');
    table.decimal('unit_cost', 12, 2).nullable().comment('Snapshotted stock_items.purchase_cost at the moment of this movement, under the same lock.');
    table.decimal('total_cost', 12, 2).nullable().comment('unit_cost × quantity, signed to match quantity\'s own direction.');
    table.date('business_date').notNullable().comment('properties.current_business_date at write time — never wall-clock (ARCHITECTURE.md §6).');
    table.string('reason', 255).nullable().comment('DB-nullable; service-layer-enforced REQUIRED for wastage and count_adjustment.');

    table.bigInteger('pos_order_id').unsigned().nullable().comment('Set only for sold/sale_reversal.');
    table.bigInteger('pos_order_settlement_id').unsigned().nullable().comment('Set only for sold/sale_reversal — the reversal lookup key for voidSettlement.');
    table.bigInteger('reversed_movement_id').unsigned().nullable().comment('Self-FK, set only for sale_reversal — the exact original "sold" row this undoes.');
    table.bigInteger('stock_take_id').unsigned().nullable().comment('Set only for count_adjustment.');
    table.string('reference', 100).nullable().comment('Free text, e.g. a delivery note number — set for received.');
    table.bigInteger('user_id').unsigned().nullable().comment('Nullable — a QR guest settlement has no staff identity to attribute a deduction to.');

    table.datetime('occurred_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    // Parent key for this table's OWN self-referencing FK
    // (`reversed_movement_id`, below) — a `sale_reversal` row points back
    // at the exact original `sold` row it undoes.
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'stock_movements_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'stock_movements_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'stock_item_id'], 'stock_movements_stock_item_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('stock_items')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'pos_order_id'], 'stock_movements_pos_order_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_orders')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'pos_order_settlement_id'], 'stock_movements_settlement_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_order_settlements')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'reversed_movement_id'], 'stock_movements_reversed_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('stock_movements')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // stock_takes/stock_take_lines are created by LATER migrations in this
    // same set — this FK is added by 20261001093000's own migration once
    // that table exists (knex/MySQL cannot reference a table that does not
    // exist yet). See that migration's own header.

    table
      .foreign(['tenant_id', 'user_id'], 'stock_movements_user_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'stock_item_id', 'occurred_at'], 'stock_movements_by_item_occurred_index');
    table.index(['tenant_id', 'property_id', 'outlet_id', 'type', 'business_date'], 'stock_movements_by_outlet_type_date_index');
    table.index(['tenant_id', 'property_id', 'pos_order_settlement_id'], 'stock_movements_by_settlement_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('stock_movements');
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropUnique(['tenant_id', 'property_id', 'id'], 'pos_order_settlements_tenant_id_property_id_id_unique');
  });
};
