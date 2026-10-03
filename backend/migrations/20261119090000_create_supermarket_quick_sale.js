'use strict';

/**
 * Supermarket quick-sale layer, Stage 1. A thin layer over the existing POS
 * order and settlement path (no new money flow): barcodes map to existing
 * menu items, each sale is an ordinary `pos_orders` tab settled by
 * `settleOrder`, and these tables only add what a till needs on top.
 *
 *  - supermarket_barcodes: several per item, unique per property.
 *  - supermarket_receipt_sequences: a locked per-outlet counter, so receipt
 *    numbers are gapless (a voided sale keeps its number).
 *  - supermarket_sales: one row per quick sale, linked to its tab/settlement.
 *  - supermarket_sale_lines: a snapshot of each receipt line (name, qty, price,
 *    net and tax) so a receipt reprints exactly whatever is edited later.
 *
 * Also seeds three permissions: `supermarket.sales` (sell), `supermarket.report`
 * (read sales and reports) and `supermarket.manage` (barcodes, products, void,
 * import). Skips `purging`/`purged` tenants, which hold no roles or grants.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };
const DELETED_TENANT_STATUSES = ['purging', 'purged'];
const PERMISSIONS = [
  { key: 'supermarket.sales', name: 'Sell at a supermarket outlet', roles: ['pos_operator', 'manager', 'admin', 'super_admin'] },
  { key: 'supermarket.report', name: 'View supermarket sales and reports', roles: ['manager', 'admin', 'super_admin'] },
  { key: 'supermarket.manage', name: 'Manage supermarket barcodes, void sales, import products', roles: ['manager', 'admin', 'super_admin'] },
];

function scopeColumns(table) {
  table.bigInteger('tenant_id').unsigned().notNullable();
  table.bigInteger('property_id').unsigned().notNullable();
}

exports.up = async function up(knex) {
  await knex.schema.createTable('supermarket_barcodes', (table) => {
    table.comment('A barcode for a menu item; several per item, unique per property. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    scopeColumns(table);
    table.bigInteger('menu_item_id').unsigned().notNullable();
    table.string('barcode', 64).notNullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['tenant_id', 'property_id', 'barcode'], { indexName: 'supermarket_barcodes_barcode_unique' });
    table.index(['tenant_id', 'property_id', 'menu_item_id'], 'supermarket_barcodes_item_index');
    table.foreign(['tenant_id', 'property_id'], 'supermarket_barcodes_property_fk').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'menu_item_id'], 'supermarket_barcodes_item_fk').references(['tenant_id', 'property_id', 'id']).inTable('pos_menu_items').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });

  await knex.schema.createTable('supermarket_receipt_sequences', (table) => {
    table.comment('Per-outlet gapless receipt counter, locked FOR UPDATE when a sale is rung. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    scopeColumns(table);
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('next_number').unsigned().notNullable().defaultTo(1);
    table.unique(['outlet_id'], { indexName: 'supermarket_receipt_sequences_outlet_unique' });
    table.foreign(['tenant_id', 'property_id'], 'supermarket_receipt_sequences_property_fk').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'supermarket_receipt_sequences_outlet_fk').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });

  await knex.schema.createTable('supermarket_sales', (table) => {
    table.comment('One quick sale: its tab, settlement and gapless receipt number. Voided sales keep their number. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    scopeColumns(table);
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('pos_order_id').unsigned().notNullable();
    table.bigInteger('settlement_id').unsigned().notNullable();
    table.bigInteger('receipt_number').unsigned().notNullable();
    table.bigInteger('sold_by_user_id').unsigned().nullable();
    table.string('method', 20).notNullable().comment('cash | card | terminal');
    table.decimal('subtotal', 14, 2).notNullable().comment('Net of inclusive tax, as settled.');
    table.decimal('tax_amount', 14, 2).notNullable();
    table.decimal('total', 14, 2).notNullable();
    table.string('currency', 3).notNullable();
    table.datetime('voided_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['outlet_id', 'receipt_number'], { indexName: 'supermarket_sales_receipt_unique' });
    table.unique(['pos_order_id'], { indexName: 'supermarket_sales_order_unique' });
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'supermarket_sales_scope_id_unique' });
    table.index(['tenant_id', 'property_id', 'created_at'], 'supermarket_sales_date_index');
    table.foreign(['tenant_id', 'property_id'], 'supermarket_sales_property_fk').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'supermarket_sales_outlet_fk').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'pos_order_id'], 'supermarket_sales_order_fk').references(['tenant_id', 'property_id', 'id']).inTable('pos_orders').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'settlement_id'], 'supermarket_sales_settlement_fk').references(['tenant_id', 'property_id', 'id']).inTable('pos_order_settlements').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });

  await knex.schema.createTable('supermarket_sale_lines', (table) => {
    table.comment('Receipt line snapshot for a quick sale. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    scopeColumns(table);
    table.bigInteger('sale_id').unsigned().notNullable();
    table.integer('line_no').unsigned().notNullable();
    table.bigInteger('menu_item_id').unsigned().nullable().comment('Plain reference for reporting; the name below is the snapshot.');
    table.string('item_name', 150).notNullable();
    table.string('barcode', 64).nullable();
    table.integer('quantity').unsigned().notNullable();
    table.decimal('unit_price', 14, 2).notNullable().comment('As sold (tax-inclusive when the VAT row is inclusive).');
    table.decimal('line_total', 14, 2).notNullable().comment('quantity x unit_price.');
    table.decimal('line_net', 14, 2).notNullable().comment('Net of inclusive tax, scaled to the settlement subtotal.');
    table.decimal('line_tax', 14, 2).notNullable();
    table.unique(['sale_id', 'line_no'], { indexName: 'supermarket_sale_lines_line_unique' });
    table.foreign(['tenant_id', 'property_id'], 'supermarket_sale_lines_property_fk').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'sale_id'], 'supermarket_sale_lines_sale_fk').references(['tenant_id', 'property_id', 'id']).inTable('supermarket_sales').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });

  for (const permission of PERMISSIONS) {
    if (!(await knex('permissions').where({ permission_key: permission.key }).first('id'))) {
      await knex('permissions').insert({ permission_key: permission.key, name: permission.name, domain: 'supermarket' });
    }
    const row = await knex('permissions').where({ permission_key: permission.key }).first('id');
    const tenantIds = (await knex('tenants').whereNotIn('status', DELETED_TENANT_STATUSES).select('id')).map((t) => t.id);
    if (!tenantIds.length) continue;
    const roles = await knex('roles').whereIn('tenant_id', tenantIds).whereIn('code', permission.roles).select('id', 'tenant_id');
    if (!roles.length) continue;
    const already = new Set((await knex('role_permissions').whereIn('role_id', roles.map((r) => r.id)).where({ permission_id: row.id }).select('role_id')).map((r) => String(r.role_id)));
    const rows = roles.filter((r) => !already.has(String(r.id))).map((r) => ({ tenant_id: r.tenant_id, role_id: r.id, permission_id: row.id }));
    if (rows.length) await knex('role_permissions').insert(rows);
  }
};

exports.down = async function down(knex) {
  const sales = await knex('supermarket_sales').count({ n: '*' }).first();
  if (Number(sales.n) > 0) throw new Error(`Refusing to roll back: ${sales.n} supermarket sale(s) exist. Rolling back would erase their receipts.`);
  for (const permission of PERMISSIONS) {
    const row = await knex('permissions').where({ permission_key: permission.key }).first('id');
    if (!row) continue;
    await knex('role_permissions').where({ permission_id: row.id }).delete();
    await knex('permissions').where({ id: row.id }).delete();
  }
  await knex.schema.dropTableIfExists('supermarket_sale_lines');
  await knex.schema.dropTableIfExists('supermarket_sales');
  await knex.schema.dropTableIfExists('supermarket_receipt_sequences');
  await knex.schema.dropTableIfExists('supermarket_barcodes');
};
