'use strict';

/**
 * `supermarket_sale_intents` — a supermarket quick sale waiting for an online
 * (Paystack) payment. Scope: PROPERTY_SCOPED.
 *
 * Holds everything the sale needs to complete WITHOUT the till: the frozen
 * cart (name, barcode, quantity and the unit price charged), the amount asked
 * of Paystack, the cashier, the outlet (which picks the payout subaccount) and
 * whether the cashier confirmed an oversell. No POS tab, settlement, stock
 * movement or receipt number exists until the payment captures; then, in the
 * capture transaction, the sale is completed exactly once and `sale_id` set.
 *
 * Lifecycle: pending → completed | cancelled (cashier cancel or expiry; the
 * reason says which) | needs_review (paid, but the sale could not be completed
 * — e.g. a tax change since the start, or captured after a cancel — the money
 * is kept and a manager refunds it).
 *
 * `tender`: 'card' today; 'transfer' later (a wider Paystack channel list) with
 * no schema change.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('supermarket_sale_intents', (table) => {
    table.comment('A supermarket quick sale waiting for an online (Paystack) payment; completed exactly once on capture. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('payment_id').unsigned().nullable().comment('The Paystack payment (settlement_target = supermarket_sale) that funds it.');
    table.bigInteger('created_by_user_id').unsigned().nullable().comment('The cashier; recorded as the seller even when the webhook completes the sale.');
    table.string('tender', 12).notNullable().defaultTo('online').comment("'online' (generic Paystack checkout); a narrower channel list can be added later with no schema change.");
    table.enu('status', ['pending', 'completed', 'cancelled', 'needs_review', 'refunded']).notNullable().defaultTo('pending');
    table.json('lines_json').notNullable().comment('Frozen cart: [{menu_item_id, item_name, barcode, quantity, unit_price}].');
    table.decimal('expected_total', 14, 2).notNullable().comment('Net + tax asked of Paystack (no service charge).');
    table.string('currency', 3).notNullable();
    table.boolean('confirm_oversell').notNullable().defaultTo(false);
    table.string('customer_email', 254).nullable();
    table.bigInteger('sale_id').unsigned().nullable().comment('The supermarket sale completed from it.');
    table.datetime('expires_at').notNullable();
    table.datetime('completed_at').nullable();
    table.datetime('cancelled_at').nullable();
    table.string('cancel_reason', 255).nullable();
    table.string('review_reason', 255).nullable().comment('Why a paid intent could not be completed (needs_review).');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table.unique(['payment_id'], { indexName: 'supermarket_sale_intents_payment_unique' });
    table.unique(['sale_id'], { indexName: 'supermarket_sale_intents_sale_unique' });
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'supermarket_sale_intents_scope_id_unique' });
    table.index(['tenant_id', 'property_id', 'outlet_id', 'status', 'created_by_user_id'], 'supermarket_sale_intents_pending_idx');
    table.index(['status', 'expires_at'], 'supermarket_sale_intents_expiry_idx');

    table.foreign(['tenant_id', 'property_id'], 'supermarket_sale_intents_property_fk').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'supermarket_sale_intents_outlet_fk').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'payment_id'], 'supermarket_sale_intents_payment_fk').references(['tenant_id', 'property_id', 'id']).inTable('payments').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'sale_id'], 'supermarket_sale_intents_sale_fk').references(['tenant_id', 'property_id', 'id']).inTable('supermarket_sales').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'created_by_user_id'], 'supermarket_sale_intents_user_fk').references(['tenant_id', 'id']).inTable('users').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('supermarket_sale_intents');
};
