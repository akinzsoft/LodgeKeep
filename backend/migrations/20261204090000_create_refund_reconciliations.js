'use strict';

/**
 * Refund reconciliation — one row per Paystack refund intent (a `payments` row with a `parent_payment_id`), written when
 * the intent is reserved and updated by every check of Paystack's own record (the sweep, a refund webhook, a manager).
 *
 * It exists so the refund's own `payments` row, which the hotel golden-output snapshots pin, gains no column. It holds
 * (a) what the original request knew and the intent row has nowhere to keep: who asked, and why (needed to void the
 * settlement and its stock later, when Paystack finally says "processed"); and (b) the history of checks the manager
 * "Clear stuck refund" action is gated on: how many times Paystack was asked, since when, and what it last said.
 *
 * One row per intent, enforced by the service under the refunded payment's row lock. PROPERTY_SCOPED. A row for an intent that predates this table is created on its first check, with no requester.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('refund_reconciliations', (table) => {
    table.comment('Per-refund-intent record of who asked and the history of checks against Paystack. PROPERTY_SCOPED. See cashiering/service.js reconcileRefundIntent.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('payment_id').unsigned().notNullable().comment('The refund intent (the child payments row).');
    table.bigInteger('requested_by_user_id').unsigned().nullable().comment('Who asked for the refund. NULL for an intent that predates this table.');
    table.string('reason', 500).nullable().comment('The reason given with the refund request.');
    table.integer('attempts').unsigned().notNullable().defaultTo(0).comment('How many times Paystack has been asked about this intent.');
    table.datetime('first_checked_at', { precision: 3 }).nullable();
    table.datetime('last_checked_at', { precision: 3 }).nullable();
    table.string('last_result', 20).nullable().comment('pending | unreachable | ambiguous | not_found | processed | failed | cleared');
    table.string('last_detail', 500).nullable();
    table.datetime('created_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    table.datetime('updated_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)')).comment('Set by the application.');

    // Not UNIQUE: one row per intent is kept by the service (always written under the refunded payment's row lock), the
    // same call `payment_terminal_details` made, so the shared isolation fixtures can add a second row for a payment.
    table.index(['tenant_id', 'payment_id'], 'refund_reconciliations_payment_index');
    table.index(['tenant_id', 'property_id', 'last_checked_at'], 'refund_reconciliations_checked_index');
    table
      .foreign(['tenant_id', 'property_id'], 'refund_reconciliations_property_fk')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'payment_id'], 'refund_reconciliations_payment_fk')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('payments')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'requested_by_user_id'], 'refund_reconciliations_user_fk')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('refund_reconciliations');
};
