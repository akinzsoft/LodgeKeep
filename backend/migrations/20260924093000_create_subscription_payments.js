'use strict';

/**
 * `subscription_payments` — PLAN.md Phase 5. One row per CHARGE ATTEMPT
 * against a `subscription_invoices` row — dunning means multiple attempts
 * against the SAME due invoice, so the attempt is its own entity, not a
 * column on the invoice. Follows ARCHITECTURE.md §7's exact payment state
 * machine and field shape (mirroring `payments`' own migration almost
 * column-for-column) — the PATTERN is reused verbatim; the table itself is
 * new because `payments`/`applyGatewayResult` in `cashiering/service.js`
 * are hard-wired to `folio_id`/`folio_line_items`, which a platform-to-
 * tenant subscription charge has neither of (confirmed by reading that
 * code directly before choosing to duplicate the pattern rather than
 * stretch the existing table to cover a row with no folio at all).
 *
 * Scope: PLATFORM_SCOPED, `tenant_id` unscoped/mandatory, following
 * `subscription_invoices` (its parent).
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
  await knex.schema.createTable('subscription_payments', (table) => {
    table.comment(
      'One charge attempt against a subscription_invoices row — dunning retries are multiple rows here against the same invoice. Follows the ARCHITECTURE.md section 7 state machine verbatim. Scope: PLATFORM_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('subscription_invoice_id').unsigned().notNullable();

    table
      .string('idempotency_key', 191)
      .notNullable()
      .comment('Defense-in-depth beyond the generic idempotency_keys table, matching payments\' own reasoning verbatim.');

    table.string('provider', 30).notNullable();
    table.string('provider_payment_id', 100).nullable();
    table
      .string('provider_reference', 100)
      .notNullable()
      .comment('Our own generated reference (a ULID), passed to the gateway and how a webhook is matched back to this row.');

    table.decimal('amount', 12, 2).notNullable();
    table.string('currency', 3).notNullable();

    table
      .enu('status', [
        'INITIATED',
        'PENDING',
        'AUTHORIZED',
        'CAPTURED',
        'FAILED',
        'EXPIRED',
        'VOIDED',
        'CANCELLED',
      ])
      .notNullable()
      .defaultTo('INITIATED')
      .comment('ARCHITECTURE.md section 7\'s exact state machine, minus the refund branches (REFUNDED/PARTIALLY_REFUNDED) — a subscription charge is never refunded through this pass\'s own explicitly out-of-scope flows; the enum stays a strict subset rather than including branches nothing in this module can reach.');

    table.string('failure_code', 100).nullable();
    table.string('failure_reason', 500).nullable();

    table.datetime('authorized_at').nullable();
    table.datetime('captured_at').nullable();
    table.datetime('failed_at').nullable();
    table.datetime('expired_at').nullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'idempotency_key'], { indexName: 'subscription_payments_tenant_id_idempotency_key_unique' });
    table.unique(['provider', 'provider_reference'], { indexName: 'subscription_payments_provider_provider_reference_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'subscription_payments_tenant_id_id_unique' });

    table
      .foreign('tenant_id', 'subscription_payments_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'subscription_invoice_id'], 'subscription_payments_tenant_id_invoice_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('subscription_invoices')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'subscription_invoice_id'], 'subscription_payments_tenant_id_invoice_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('subscription_payments');
};
