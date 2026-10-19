'use strict';

/**
 * Vouchers (discounts PR 2). Three NEW tables and nothing added to `discounts`, `pos_order_settlements`,
 * `pos_orders`, `pos_order_items` or `payments`: the hotel golden snapshots dump those with SELECT *, so a check
 * without a voucher is stored exactly as it always was.
 *
 * - `vouchers` (PROPERTY_SCOPED): a code a manager creates; fixed or percent; optional cap (`max_amount`), validity
 *   dates, a total-use limit and a state. Never edited after creation (a change is a new voucher). `used_count` is
 *   moved ONLY by the conditional update at settlement and the guarded decrement when that settlement is voided.
 *   `check_percent_cap` is the creator's discount limit when it was made (100 when made with comp authority): the
 *   most of ANY check the voucher may take off, which is how a fixed voucher is bounded by a reference.
 * - `voucher_outlets` (PROPERTY_SCOPED): the outlets a voucher works at. No rows = every outlet.
 * - `voucher_redemptions` (PROPERTY_SCOPED): one row per voucher put on a check (`attached`), then `redeemed` when
 *   the check settles and `reversed` when that sale is voided or fully refunded (or `released` if it was taken off
 *   before settling). The `discounts` row (kind `voucher`) carries the pricing; this carries the voucher link and the
 *   code as it was. UNIQUE(voucher, discount) is the second guard behind the conditional update.
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

exports.up = async function up(knex) {
  await knex.schema.createTable('vouchers', (table) => {
    table.comment('A discount voucher a manager created. Never edited; a change is a new voucher. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.string('code', 24).notNullable().comment('Normalised: upper case, no spaces or dashes. The screens show it with dashes.');
    table.string('type', 10).notNullable().comment('percent | fixed');
    table.decimal('value', 12, 2).notNullable();
    table.decimal('max_amount', 12, 2).nullable().comment('The most one redemption can ever take off. Null = no cap beyond the value.');
    table.decimal('check_percent_cap', 5, 2).notNullable().comment("The most of a check it may take off: the creator's discount limit when made (100 with comp authority).");
    table.date('valid_from').notNullable();
    table.date('valid_to').notNullable();
    table.integer('max_total_uses').unsigned().nullable().comment('Null = unlimited.');
    table.integer('used_count').unsigned().notNullable().defaultTo(0);
    table.string('status', 10).notNullable().defaultTo('active').comment('active | disabled');
    table.string('note', 200).nullable();
    table.bigInteger('created_by_user_id').unsigned().notNullable();
    table.bigInteger('disabled_by_user_id').unsigned().nullable();
    table.datetime('disabled_at').nullable();
    table.string('disabled_reason', 255).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    table.unique(['tenant_id', 'property_id', 'code'], { indexName: 'vouchers_tenant_property_code_unique' });
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'vouchers_tenant_property_id_unique' });
    tenantProperty(table, 'vouchers');
    table.foreign(['tenant_id', 'created_by_user_id'], 'vouchers_created_by_foreign').references(['tenant_id', 'id']).inTable('users').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'disabled_by_user_id'], 'vouchers_disabled_by_foreign').references(['tenant_id', 'id']).inTable('users').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });

  await knex.schema.createTable('voucher_outlets', (table) => {
    table.comment('The outlets a voucher works at; no rows = every outlet. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('voucher_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['voucher_id', 'outlet_id'], { indexName: 'voucher_outlets_voucher_outlet_unique' });
    tenantProperty(table, 'voucher_outlets');
    table
      .foreign(['tenant_id', 'property_id', 'voucher_id'], 'voucher_outlets_voucher_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('vouchers')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'voucher_outlets_outlet_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });

  await knex.schema.createTable('voucher_redemptions', (table) => {
    table.comment('A voucher on a check: attached, redeemed when it settles, reversed when that sale is voided or fully refunded. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('voucher_id').unsigned().notNullable();
    table.bigInteger('discount_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('settlement_id').unsigned().nullable().comment('The first settlement of the check, once redeemed.');
    table.string('code', 24).notNullable().comment('The voucher code as it was when attached.');
    table.decimal('amount', 12, 2).nullable().comment('The money taken off, once redeemed.');
    table.string('status', 10).notNullable().defaultTo('attached').comment('attached | redeemed | reversed | released');
    table.bigInteger('attached_by_user_id').unsigned().notNullable();
    table.datetime('redeemed_at').nullable();
    table.datetime('reversed_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    table.unique(['voucher_id', 'discount_id'], { indexName: 'voucher_redemptions_voucher_discount_unique' });
    table.index(['tenant_id', 'property_id', 'voucher_id', 'status'], 'voucher_redemptions_voucher_status_index');
    // A voucher's redemption is found by its discount while the settlement holds the order lock. Without an index that
    // leads with the scope columns the locking read scans (and locks) other checks' rows and two settlements deadlock.
    table.index(['tenant_id', 'property_id', 'discount_id'], 'voucher_redemptions_discount_index');
    tenantProperty(table, 'voucher_redemptions');
    table
      .foreign(['tenant_id', 'property_id', 'voucher_id'], 'voucher_redemptions_voucher_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('vouchers')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'discount_id'], 'voucher_redemptions_discount_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('discounts')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'voucher_redemptions_outlet_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table.foreign('settlement_id', 'voucher_redemptions_settlement_foreign').references('id').inTable('pos_order_settlements').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'attached_by_user_id'], 'voucher_redemptions_attached_by_foreign').references(['tenant_id', 'id']).inTable('users').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  // A redemption is a record of money taken off a sale: refuse to throw that away.
  if (await knex.schema.hasTable('voucher_redemptions')) {
    const used = await knex('voucher_redemptions').whereIn('status', ['redeemed', 'reversed']).first('id');
    if (used) throw new Error('Refusing to drop voucher tables: voucher redemptions exist.');
  }
  await knex.schema.dropTableIfExists('voucher_redemptions');
  await knex.schema.dropTableIfExists('voucher_outlets');
  await knex.schema.dropTableIfExists('vouchers');
};
