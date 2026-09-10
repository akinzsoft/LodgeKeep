'use strict';

/**
 * `ar_accounts` — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md section 3.9
 * ("Credit management, outstanding balance tracking"). One company can hold
 * at most one AR account per property.
 *
 * Scope: PROPERTY_SCOPED, deliberately NOT tenant-wide even though its
 * parent `company_profiles` is TENANT_SCOPED. Every other money-bearing
 * ledger table in this codebase (folios, payments, folio_line_items,
 * pos_orders) is PROPERTY_SCOPED for the same reason: two properties in the
 * same tenant run entirely separate ledgers, and a credit limit is exactly
 * this kind of per-property risk decision — one property may extend real
 * credit to a travel agency, a sister property in the same tenant may
 * extend none. This also keeps the credit-limit row lock (see
 * `src/modules/ar/service.js`) scoped to one property's own contention, not
 * a tenant-wide bottleneck.
 *
 * `current_balance`/`is_over_limit` are both DERIVED, never independently
 * maintained — `recomputeArAccountBalance` (ar/service.js) is the only
 * writer, the identical "one source of truth, always re-derived" discipline
 * `folios.balance`/`recomputeFolioBalance` already established.
 *
 * `enforcement_mode` is this session's confirmed decision on TESTING.md
 * AR-3's deliberately non-committal "blocked or flagged per config" —
 * configurable per account rather than a single global rule.
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
  await knex.schema.createTable('ar_accounts', (table) => {
    table.comment(
      'A companys credit account at one property - the entity a folio is billed to and an invoice is generated against. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('company_profile_id').unsigned().notNullable();

    table.decimal('credit_limit', 12, 2).notNullable().defaultTo('0.00');
    table.string('currency', 3).notNullable();
    table
      .enu('enforcement_mode', ['block', 'flag_only'])
      .notNullable()
      .defaultTo('block')
      .comment('block: a charge that would exceed credit_limit is rejected unless a manager overrides it. flag_only: always allowed, is_over_limit is set instead.');
    table
      .decimal('current_balance', 12, 2)
      .notNullable()
      .defaultTo('0.00')
      .comment('Derived only, via recomputeArAccountBalance - never written directly elsewhere. See migration header.');
    table.boolean('is_over_limit').notNullable().defaultTo(false);
    table.enu('status', ['active', 'closed']).notNullable().defaultTo('active');

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'company_profile_id'], {
      indexName: 'ar_accounts_tenant_property_company_unique',
    });
    // Parent key for ar_invoices/ar_payments/ar_invoice_sequences below.
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'ar_accounts_tenant_property_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'ar_accounts_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'company_profile_id'], 'ar_accounts_tenant_company_foreign')
      .references(['tenant_id', 'id'])
      .inTable('company_profiles')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'status'], 'ar_accounts_tenant_property_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ar_accounts');
};
