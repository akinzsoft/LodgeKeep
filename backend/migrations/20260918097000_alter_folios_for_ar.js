'use strict';

/**
 * `folios.company_profile_id` - PLAN.md Phase 4, Accounts Receivable. Closes
 * the literal forward reference `folios.billed_to`s own migration comment
 * left open ("not yet a company_profile_id FK ... no company-profile
 * concept exists until AR (Phase 4) lands").
 *
 * `billed_to` (the existing free-text label) is kept, UNCHANGED - it stays
 * the plain display label for every folio, including AR-billed ones
 * (`billFolioToCompany`, ar module wiring in cashiering/service.js, sets it
 * to the companys own name the moment `company_profile_id` is set, so the
 * two never disagree). This column is purely additive.
 *
 * Nullable and FK-less-when-null by MySQLs own default MATCH SIMPLE
 * semantics (a NULL in any column of a composite FK skips enforcement) -
 * the overwhelming majority of folios have no company at all.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.alterTable('folios', (table) => {
    table
      .bigInteger('company_profile_id')
      .unsigned()
      .nullable()
      .comment('Set when this folio is billed to a company AR account instead of settled by the guest directly. See migration header.');
  });
  await knex.schema.alterTable('folios', (table) => {
    table
      .foreign(['tenant_id', 'company_profile_id'], 'folios_tenant_id_company_profile_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('company_profiles')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('folios', (table) => {
    table.dropForeign(['tenant_id', 'company_profile_id'], 'folios_tenant_id_company_profile_id_foreign');
    table.dropColumn('company_profile_id');
  });
};
