'use strict';

/**
 * Discounts and comps (PR 1 of 2; vouchers follow in a second migration). Four NEW tables and nothing added to a
 * table the hotel golden snapshots dump (`pos_order_settlements`, `pos_order_items`, `pos_orders`, `payments`), so
 * a check without a discount is stored exactly as it always was.
 *
 * - `discount_reasons` (PROPERTY_SCOPED): the property's catalogue of reasons; every discount carries one.
 * - `discount_limits` (PROPERTY_SCOPED): the largest percent a role may give without a manager's approval. No row
 *   for a role means the built-in default applies (never "off").
 * - `discounts` (PROPERTY_SCOPED): the request. It holds the RULE (type + value as entered), never a trusted amount;
 *   the server works the money out when it prices the check. Once `active` (applied within the limit, or approved)
 *   or `applied` (frozen into a settlement) nothing about it changes: a different discount is a new row that needs
 *   its own approval. Only `status` moves (removed / applied / expired), and only that is ever updated.
 * - `settlement_discounts` (PROPERTY_SCOPED): the amounts frozen when a settlement is written. Reports, receipts and
 *   refunds read these; nothing recomputes them. A voided settlement is found by joining its settlement row, so
 *   there is exactly one place a void is recorded.
 */
const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

function tenantProperty(table, name) {
  table
    .foreign(['tenant_id', 'property_id'], `${name}_tenant_property_foreign`)
    .references(['tenant_id', 'id'])
    .inTable('properties')
    .onDelete(RESTRICT.onDelete)
    .onUpdate(RESTRICT.onUpdate);
}

function userFk(table, column, name) {
  table
    .foreign(['tenant_id', column], `${name}_${column}_foreign`)
    .references(['tenant_id', 'id'])
    .inTable('users')
    .onDelete(RESTRICT.onDelete)
    .onUpdate(RESTRICT.onUpdate);
}

exports.up = async function up(knex) {
  // An online (Paystack) supermarket sale prices its frozen cart with these cart-bound discounts and claims them when
  // the payment is captured. Nullable: a sale without a discount stores nothing here.
  await knex.schema.alterTable('supermarket_sale_intents', (table) => {
    table.json('discount_ids_json').nullable().comment('Cart-bound discount ids (discounts.id) the online sale was priced with.');
  });

  await knex.schema.createTable('discount_reasons', (table) => {
    table.comment('Per-property catalogue of discount and comp reasons. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.string('code', 30).notNullable();
    table.string('name', 80).notNullable();
    table.string('kind', 10).notNullable().defaultTo('discount').comment('discount | comp | both');
    table.string('status', 10).notNullable().defaultTo('active').comment('active | archived');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    table.unique(['tenant_id', 'property_id', 'code'], { indexName: 'discount_reasons_tenant_property_code_unique' });
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'discount_reasons_tenant_property_id_unique' });
    tenantProperty(table, 'discount_reasons');
  });

  await knex.schema.createTable('discount_limits', (table) => {
    table.comment('The largest percent a role may discount without approval. No row = built-in default. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.string('role_code', 50).notNullable();
    table.decimal('max_percent', 5, 2).notNullable();
    table.bigInteger('updated_by_user_id').unsigned().nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    table.unique(['tenant_id', 'property_id', 'role_code'], { indexName: 'discount_limits_tenant_property_role_unique' });
    tenantProperty(table, 'discount_limits');
    userFk(table, 'updated_by_user_id', 'discount_limits');
  });

  await knex.schema.createTable('discounts', (table) => {
    table.comment('A discount or comp request: the rule as entered, never a trusted amount. Immutable once active. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('pos_order_id').unsigned().nullable().comment('Null for a supermarket cart-bound request until the sale claims it.');
    table.bigInteger('pos_order_item_id').unsigned().nullable().comment('The line, for scope = line.');
    table.bigInteger('menu_item_id').unsigned().nullable().comment('Supermarket cart-bound line scope: which product, until the sale claims it.');
    table.string('scope', 10).notNullable().comment('order | line');
    table.string('kind', 10).notNullable().comment('discount | comp');
    table.string('type', 10).notNullable().comment('percent | fixed');
    table.decimal('value', 12, 2).notNullable();
    table.decimal('max_amount', 12, 2).nullable().comment('Set when a manager approves: the most this discount can ever take off, whatever is added to the check afterwards. Null = not approval-capped.');
    table.bigInteger('reason_id').unsigned().notNullable();
    table.string('status', 20).notNullable().comment('pending_approval | active | removed | applied | expired');
    table.decimal('effective_percent', 7, 2).nullable().comment('The percent of its base when requested; informational.');
    table.bigInteger('applied_by_user_id').unsigned().notNullable();
    table.bigInteger('approved_by_user_id').unsigned().nullable();
    table.bigInteger('approval_id').unsigned().nullable().comment('manager_approvals.id; no FK, same as the audit references.');
    table.datetime('requested_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('decided_at').nullable();
    table.datetime('expires_at').nullable().comment('Cart-bound requests only.');
    table.bigInteger('removed_by_user_id').unsigned().nullable();
    table.datetime('removed_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    table.index(['tenant_id', 'property_id', 'pos_order_id', 'status'], 'discounts_tenant_property_order_status_index');
    table.index(['tenant_id', 'property_id', 'outlet_id', 'status'], 'discounts_tenant_property_outlet_status_index');
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'discounts_tenant_property_id_unique' });
    tenantProperty(table, 'discounts');
    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'discounts_tenant_property_outlet_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'pos_order_id'], 'discounts_tenant_property_order_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_orders')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table.foreign('pos_order_item_id', 'discounts_order_item_foreign').references('id').inTable('pos_order_items').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'reason_id'], 'discounts_tenant_property_reason_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('discount_reasons')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    userFk(table, 'applied_by_user_id', 'discounts');
    userFk(table, 'approved_by_user_id', 'discounts');
    userFk(table, 'removed_by_user_id', 'discounts');
  });

  await knex.schema.createTable('settlement_discounts', (table) => {
    table.comment('Discount amounts frozen when a settlement was written. Voided with its settlement. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('settlement_id').unsigned().notNullable();
    table.bigInteger('discount_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.string('scope', 10).notNullable();
    table.string('kind', 10).notNullable();
    table.string('type', 10).notNullable();
    table.decimal('value', 12, 2).notNullable();
    table.decimal('base_before', 12, 2).notNullable().comment('The value the discount applied to, before it.');
    table.decimal('amount', 12, 2).notNullable().comment('The money actually taken off, worked out by the server.');
    table.bigInteger('reason_id').unsigned().notNullable();
    table.string('reason_name', 80).notNullable();
    table.bigInteger('applied_by_user_id').unsigned().notNullable();
    table.bigInteger('approved_by_user_id').unsigned().nullable();
    table.bigInteger('approval_id').unsigned().nullable();
    table.date('business_date').nullable();
    table.string('currency', 3).notNullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['settlement_id', 'discount_id'], { indexName: 'settlement_discounts_settlement_discount_unique' });
    table.index(['tenant_id', 'property_id', 'business_date'], 'settlement_discounts_tenant_property_date_index');
    tenantProperty(table, 'settlement_discounts');
    table.foreign('settlement_id', 'settlement_discounts_settlement_foreign').references('id').inTable('pos_order_settlements').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'discount_id'], 'settlement_discounts_discount_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('discounts')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'settlement_discounts_outlet_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'reason_id'], 'settlement_discounts_reason_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('discount_reasons')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    userFk(table, 'applied_by_user_id', 'settlement_discounts');
    userFk(table, 'approved_by_user_id', 'settlement_discounts');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('settlement_discounts');
  await knex.schema.dropTableIfExists('discounts');
  await knex.schema.dropTableIfExists('discount_limits');
  await knex.schema.dropTableIfExists('discount_reasons');
  await knex.schema.alterTable('supermarket_sale_intents', (table) => {
    table.dropColumn('discount_ids_json');
  });
};
