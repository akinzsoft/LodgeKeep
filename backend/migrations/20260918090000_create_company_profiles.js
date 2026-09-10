'use strict';

/**
 * `company_profiles` — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md section 3.1
 * ("Company, travel agent, and source profiles ... B2B profiles matter for
 * invoicing/AR") and section 3.9 (Accounts Receivable). DATABASE.md's own
 * long-standing draft files this table under Guests and CRM, driven by AR
 * (section 3.9) — this migration is that draft made real, owned by the
 * Profiles module even though the module that actually consumes it (a new
 * `ar` module, this same pass) lives elsewhere. `folios.billed_to`'s own
 * migration comment ("no company_profile_id FK exists yet ... Accounts
 * Receivable, Phase 4") is the literal forward reference this pass closes.
 *
 * Scope: TENANT_SCOPED. A company or travel agent does business across
 * every property a tenant runs, the identical reasoning `guests` already
 * established (one identity across every property the tenant runs) rather
 * than belonging to a single property.
 *
 * No UNIQUE constraint on `name` — two genuinely different real-world
 * companies can share a display name (the same "nothing here is a natural
 * key" reasoning the `guests` migration already gives for skipping a
 * uniqueness constraint on a human name).
 *
 * `guests.company_profile_id` (added below, nullable) is the "linked
 * company/travel-agent profile" PRODUCT_REQUIREMENTS.md's own profile
 * detail screen spec names — deliberately narrow: a guest may be linked to
 * at most one company, set only through a dedicated endpoint, not a general
 * guest-update route (none exists yet).
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
  await knex.schema.createTable('company_profiles', (table) => {
    table.comment(
      'A company, travel agent, or other B2B billing source a guest or reservation can be linked to, and Accounts Receivable bills against. Scope: TENANT_SCOPED. Archive, never delete.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();

    table.string('name', 150).notNullable();
    table.enu('type', ['company', 'travel_agent', 'source']).notNullable().defaultTo('company');
    table.string('billing_email', 255).nullable();
    table.string('billing_phone', 50).nullable();
    table.text('billing_address').nullable();
    table
      .smallint('payment_terms_days')
      .unsigned()
      .notNullable()
      .defaultTo(30)
      .comment('Default net-terms window used to compute an AR invoice due_at at generation time.');
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    table
      .foreign('tenant_id', 'company_profiles_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'status'], 'company_profiles_tenant_id_status_index');

    // Parent key for ar_accounts.company_profile_id and guests.company_profile_id below.
    table.unique(['tenant_id', 'id'], { indexName: 'company_profiles_tenant_id_id_unique' });
  });

  await knex.schema.alterTable('guests', (table) => {
    table
      .bigInteger('company_profile_id')
      .unsigned()
      .nullable()
      .comment('Optional linked company/travel-agent profile, set only via POST /guests/:id/link-company. Not the AR billing decision itself, which lives on the folio.');
  });
  await knex.schema.alterTable('guests', (table) => {
    table
      .foreign(['tenant_id', 'company_profile_id'], 'guests_tenant_id_company_profile_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('company_profiles')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('guests', (table) => {
    table.dropForeign(['tenant_id', 'company_profile_id'], 'guests_tenant_id_company_profile_id_foreign');
    table.dropColumn('company_profile_id');
  });
  await knex.schema.dropTableIfExists('company_profiles');
};
