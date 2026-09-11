'use strict';

/**
 * `subscription_invoices` — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22.
 * DATABASE.md's own draft row for this table, made real — "Distinct from
 * `ar_invoices`" (that table is the HOTEL invoicing ITS OWN corporate
 * clients; this one is Planmsys invoicing the tenant for its subscription
 * — the exact "genuinely different relationship" distinction this pass's
 * whole design turns on).
 *
 * One row per billing period, the amount due for that period. Multiple
 * `subscription_payments` rows may attempt to collect ONE invoice (the
 * dunning retries) — the invoice tracks what's owed and whether it's been
 * collected; the payments track each individual charge attempt against it,
 * following ARCHITECTURE.md §7's own state machine per attempt.
 *
 * Scope: PLATFORM_SCOPED, `tenant_id` unscoped/mandatory, following
 * `subscriptions` (its parent) for the identical reasoning.
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
  await knex.schema.createTable('subscription_invoices', (table) => {
    table.comment(
      'The amount due for one billing period of one tenant subscription. Distinct from ar_invoices (the hotel invoicing its own corporate clients). Scope: PLATFORM_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('subscription_id').unsigned().notNullable();

    table.decimal('amount', 12, 2).notNullable();
    table.string('currency', 3).notNullable();

    table
      .enu('status', ['open', 'paid', 'void', 'uncollectible'])
      .notNullable()
      .defaultTo('open')
      .comment('open: awaiting a successful charge. paid: collected. uncollectible: dunning exhausted (the tenant is also suspended at this point). void: never used this pass (no manual cancellation flow) — present for the same "closed set, no ad hoc strings" reasoning as payments.status.');

    table.date('period_start').notNullable();
    table.date('period_end').notNullable();
    table.date('due_at').notNullable().comment('Equal to period_start — a subscription is billed in advance, matching Paystack\'s own and every real SaaS billing convention.');
    table.datetime('paid_at').nullable();

    table.integer('attempt_count').unsigned().notNullable().defaultTo(0);

    timestamps(knex, table);

    table.unique(['tenant_id', 'id'], { indexName: 'subscription_invoices_tenant_id_id_unique' });
    // One invoice per subscription per period — the conditional-UPDATE
    // idiom the billing job uses to advance a period relies on this being
    // impossible to double-create even under real concurrent sweep runs.
    table.unique(['subscription_id', 'period_start'], { indexName: 'subscription_invoices_subscription_id_period_start_unique' });

    table
      .foreign('tenant_id', 'subscription_invoices_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'subscription_id'], 'subscription_invoices_tenant_id_subscription_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('subscriptions')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'status'], 'subscription_invoices_tenant_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('subscription_invoices');
};
