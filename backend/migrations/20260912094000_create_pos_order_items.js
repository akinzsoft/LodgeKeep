'use strict';

/**
 * `pos_order_items` — PLAN.md Phase 4. One line on a tab.
 *
 * Scope: PROPERTY_SCOPED, following `pos_orders`.
 *
 * `menu_item_id` (DATABASE.md's draft names this column `item_id`; renamed
 * here for the same clarity reason `rooms.room_type_id` isn't `type_id` —
 * DATABASE.md is updated to match in this same pass).
 *
 * `unit_price`/`modifiers` are SNAPSHOTTED at add-time from the menu
 * item's price/chosen modifier options — never re-read live later, the
 * same `reservation_daily_rates` convention this codebase already uses so
 * a later menu price change can't alter an already-open tab's total.
 * `modifiers` here is the CHOSEN subset (`[{name, option, priceDelta}]`),
 * distinct from `pos_menu_items.modifiers`'s catalogue of what's on offer.
 *
 * `split_group` is nullable — null means "not yet assigned to a split"
 * (the default, single-settlement case); an integer tags the item into
 * one of the tab's split groups for `pos_order_settlements` to settle
 * independently (this session's confirmed scope: item-group splits, no
 * drag-and-drop).
 *
 * Void: "Void an item with a reason before settlement; voids are
 * audited — this is the single most common vector for staff theft in
 * food and beverage" (PRODUCT_REQUIREMENTS.md §3.4) — void fields mirror
 * `folio_line_items`'/`pos_order_items`' own void-never-delete shape
 * exactly (ARCHITECTURE.md §8).
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
  await knex.schema.createTable('pos_order_items', (table) => {
    table.comment('One line on a tab. Scope: PROPERTY_SCOPED. Void, never delete (ARCHITECTURE.md §8).');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('pos_order_id').unsigned().notNullable();
    table.bigInteger('menu_item_id').unsigned().notNullable();

    table.integer('quantity').unsigned().notNullable().defaultTo(1);
    table.decimal('unit_price', 12, 2).notNullable().comment('Snapshotted from the menu item at add-time — never re-read live.');
    table.json('modifiers').nullable().comment('[{name, option, priceDelta}] chosen for this line — snapshotted, not a live reference.');
    table.integer('split_group').unsigned().nullable().comment('Null = unassigned (settled as one). See migration header.');

    table.datetime('voided_at').nullable();
    table.string('void_reason', 255).nullable();
    table.bigInteger('voided_by_user_id').unsigned().nullable();

    timestamps(knex, table);

    table
      .foreign(['tenant_id', 'property_id'], 'pos_order_items_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'pos_order_id'], 'pos_order_items_tenant_id_property_id_pos_order_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_orders')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'menu_item_id'], 'pos_order_items_tenant_id_property_id_menu_item_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_menu_items')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'voided_by_user_id'], 'pos_order_items_tenant_id_voided_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'pos_order_id'], 'pos_order_items_tenant_id_property_id_pos_order_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_order_items');
};
