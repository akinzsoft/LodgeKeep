'use strict';

/**
 * `guests.date_of_birth` — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.20's
 * data-migration dedup rule: "match incoming guests on email, then phone,
 * then name + date of birth." `guests` (20260906091000) never had this
 * column — Phase 2's own confirmed scope was deliberately minimal (name,
 * email, phone only). §3.20's third dedup tier can't be implemented as
 * literally spec'd without it, and the field is small, nullable, additive,
 * and generically useful to Guest Profiles beyond migration (a real gap
 * that column-less table already had, not a schema change invented solely
 * to satisfy one caller).
 *
 * Nullable — the overwhelming majority of existing guest rows, and most
 * future front-desk-entered ones, will never carry this. No index on the
 * column alone: it is only ever consulted alongside `last_name` (the dedup
 * tier itself is "name + date of birth," never DOB in isolation), so the
 * composite index below is what the dedup lookup actually uses.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('guests', (table) => {
    table.date('date_of_birth').nullable().comment('PRODUCT_REQUIREMENTS.md §3.20 dedup tier 3 ("name + date of birth"). Nullable — most guest rows will never carry this.');
  });
  await knex.schema.alterTable('guests', (table) => {
    table.index(['tenant_id', 'last_name', 'date_of_birth'], 'guests_tenant_id_last_name_dob_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('guests', (table) => {
    table.dropIndex(['tenant_id', 'last_name', 'date_of_birth'], 'guests_tenant_id_last_name_dob_index');
  });
  await knex.schema.alterTable('guests', (table) => {
    table.dropColumn('date_of_birth');
  });
};
