'use strict';

/**
 * `expenses` — the real operating-expense ledger. Financial-record
 * immutability (ARCHITECTURE.md §8) applies exactly as it does to
 * `folio_line_items`/`payments`: a posted expense's amount/category/date
 * is never edited in place, only voided (mandatory reason) with a fresh,
 * correct row recorded separately. `voided_at`/`voided_by_user_id`/
 * `void_reason` are the only fields a mutation ever touches after insert.
 *
 * `amount` is always a plain positive value — an expense is always an
 * outflow, so unlike `folio_line_items` there's no signed-amount
 * convention to represent a credit.
 *
 * `expense_category_id` is REQUIRED, not nullable — unlike
 * `stock_items.category` (retrofitted onto years of pre-existing
 * uncategorized rows), this is a brand-new table with zero legacy data,
 * and expense-reporting-by-category is an explicit deliverable: letting
 * every expense default to "uncategorized" would make that report useless
 * from day one. Mirrors `pos_menu_items.category` (NOT NULL), not
 * `stock_items.category` (nullable).
 *
 * `business_date` (ARCHITECTURE.md §6, never wall clock) may be backdated
 * by the recorder — confirmed decision: real expense entry is often
 * retrospective (an invoice or receipt arrives days after the fact) —
 * but never postdated past the property's own current business date
 * (enforced in the service layer, not the schema).
 *
 * `currency` is enforced equal to the property's own `base_currency` at
 * record time (confirmed decision: no cross-currency/FX handling in this
 * pass) — stored on the row anyway, matching every other money-bearing
 * table in this schema (ARCHITECTURE.md §1: "every money column carries
 * its currency"), rather than assumed implicitly from the property.
 *
 * `recorded_by_user_id` is nullable — null means system-posted (a
 * recurring-schedule auto-post), the same "null means the job posted this,
 * not a person" convention `folio_line_items.posted_by_user_id` already
 * establishes.
 *
 * Scope: PROPERTY_SCOPED. Void, never delete.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('expenses', (table) => {
    table.comment('The operating-expense ledger. Scope: PROPERTY_SCOPED. Void, never delete — a correction is a void plus a fresh, correct row.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('expense_category_id').unsigned().notNullable();
    table.string('description', 255).notNullable();
    table.string('payee', 160).nullable().comment('Free text — no structured supplier/company link (confirmed decision).');
    table.decimal('amount', 12, 2).notNullable();
    table.string('currency', 3).notNullable();
    table.enu('payment_method', ['cash', 'card', 'bank_transfer', 'cheque', 'other']).notNullable();
    table.date('business_date').notNullable();
    table.enu('source', ['manual', 'recurring']).notNullable().defaultTo('manual');
    table.bigInteger('recurring_expense_schedule_id').unsigned().nullable();
    table.bigInteger('recorded_by_user_id').unsigned().nullable().comment('Null means system-posted (a recurring schedule\'s own auto-post), matching folio_line_items.posted_by_user_id\'s convention.');
    table.datetime('voided_at').nullable();
    table.bigInteger('voided_by_user_id').unsigned().nullable();
    table.string('void_reason', 500).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table
      .foreign(['tenant_id', 'property_id'], 'expenses_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'expense_category_id'], 'expenses_expense_category_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('expense_categories')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    // Nullable column: MySQL's default MATCH SIMPLE skips the FK check when
    // it's NULL (a manually-recorded expense), the same reasoning
    // payment_webhook_events' own nullable attribution FK already documents.
    table
      .foreign(['tenant_id', 'property_id', 'recurring_expense_schedule_id'], 'expenses_recurring_expense_schedule_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('recurring_expense_schedules')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'recorded_by_user_id'], 'expenses_recorded_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'voided_by_user_id'], 'expenses_voided_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'business_date'], 'expenses_tenant_property_business_date_index');
    table.index(['tenant_id', 'property_id', 'expense_category_id'], 'expenses_tenant_property_category_index');
    table.index(['tenant_id', 'property_id', 'voided_at'], 'expenses_tenant_property_voided_at_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('expenses');
};
