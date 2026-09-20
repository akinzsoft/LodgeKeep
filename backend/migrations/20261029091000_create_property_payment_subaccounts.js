'use strict';

/**
 * `property_payment_subaccounts` — one row per property, the hotel's own
 * Paystack Subaccount (`src/modules/cashiering/paystack-adapter.js`'s
 * `createSubaccount`). User-confirmed decision (AskUserQuestion,
 * "per-property"): matches `email_settings`/`base_currency`/every other
 * guest-payment-adjacent table in this schema, all PROPERTY_SCOPED — a
 * 3-property chain gets 3 subaccounts, matching how real hotel groups
 * usually bank locally per property, and how `folios`/`payments` already
 * scope guest money.
 *
 * `platform_payment_integration_id` is a plain, single-column FK to
 * `platform_payment_integrations.id` — the same "scoped table -> plain FK
 * to a GLOBAL_REFERENCE row" shape `tenants.plan_id -> plans.id` already
 * establishes (a GLOBAL_REFERENCE row has no tenant/property of its own to
 * match against, so no composite key is needed). Recorded once, at the
 * moment the subaccount is created, from whichever integration the
 * property's OWN `base_currency` resolved to at that time — RESTRICT, not
 * CASCADE: an integration a live subaccount depends on can never be
 * silently deleted out from under it.
 *
 * Only the last 4 digits of the bank account number are retained after
 * the subaccount is created — the same least-privilege reasoning this
 * codebase already applies to never storing a full card PAN. The full
 * number is used once, to create the subaccount via Paystack's own API,
 * and never needs to be supplied again: every future charge references
 * the property by `subaccount_code` alone.
 *
 * `percentage_charge` is a real, per-property column even though every
 * row is seeded at 0% today (user-confirmed decision: "0% for now... no
 * pricing decision has been made") — kept here, not hardcoded in
 * application code, so a future per-hotel platform fee is a data change,
 * not a schema change, the same reasoning `platform_payment_integrations`
 * itself follows for multi-currency.
 *
 * `UNIQUE(tenant_id, property_id)` — a singleton config per property,
 * matching `email_settings`' own shape exactly (one active payout
 * destination at a time, never a growing list). Changing a hotel's bank
 * account creates a NEW Paystack subaccount and replaces this row's
 * `subaccount_code` rather than mutating the existing subaccount in
 * place — deliberately avoids ambiguity about which subaccount an
 * ALREADY-CHARGED `payments.subaccount_code` snapshot refers to (see that
 * migration's own header).
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
  await knex.schema.createTable('property_payment_subaccounts', (table) => {
    // A plain apostrophe here breaks knex's table-level `.comment()` SQL
    // generation (unlike column-level comments) — the same recurring bug
    // this codebase has hit and documented before; reworded, not escaped.
    table.comment(
      'A property-owned Paystack Subaccount — where its guest card revenue is routed, minus any configured platform fee. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table
      .bigInteger('platform_payment_integration_id')
      .unsigned()
      .notNullable()
      .comment('Which platform merchant integration this subaccount was created under (resolved from the property\'s own base_currency at creation time). Plain FK — the parent is GLOBAL_REFERENCE.');

    table.string('subaccount_code', 100).notNullable().comment('Paystack\'s own returned code (e.g. "ACCT_..."), passed as the `subaccount` param on every future charge for this property.');
    table.string('bank_code', 10).notNullable();
    table.string('bank_name', 150).notNullable();
    table.string('account_number_last4', 4).notNullable().comment('Display only. The full account number is never retained after the subaccount is created — see migration header.');
    table.string('account_name', 150).notNullable().comment('The name Paystack resolved the account to — shown back to the hotel as its own confirmation that the right account was configured.');

    table
      .decimal('percentage_charge', 5, 2)
      .notNullable()
      .defaultTo(0)
      .comment('The platform\'s cut of each transaction, as Paystack\'s own split percentage. 0.00 for every row seeded by this pass (user-confirmed: no fee yet) — a real column so a future fee needs no schema change.');

    table.boolean('is_active').notNullable().defaultTo(true);

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id'], { indexName: 'property_payment_subaccounts_tenant_id_property_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'property_payment_subaccounts_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      // Shortened name — MySQL's 64-character identifier limit, the same
      // class of bug this codebase has hit and documented before.
      .foreign('platform_payment_integration_id', 'property_payment_subaccounts_integration_id_foreign')
      .references('id')
      .inTable('platform_payment_integrations')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('property_payment_subaccounts');
};
