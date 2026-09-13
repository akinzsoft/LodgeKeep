'use strict';

/**
 * `pos_order_settlements.business_date` — the property business date a POS
 * sale was settled on (ARCHITECTURE.md §6: every posted transaction stores
 * its business date separately from its wall-clock timestamp). The POS
 * sales report filters on it, so a sale after midnight but before Night
 * Audit counts toward the day it belongs to.
 *
 * Existing rows are backfilled from `DATE(settled_at)` — the closest
 * available approximation, flagged as such; every new settlement writer
 * records the real business date.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.date('business_date').nullable().comment('Property business date the settlement posted on (ARCHITECTURE.md §6).');
  });
  await knex('pos_order_settlements').whereNull('business_date').update({ business_date: knex.raw('DATE(settled_at)') });
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.index(['tenant_id', 'property_id', 'business_date'], 'pos_order_settlements_business_date_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropIndex(['tenant_id', 'property_id', 'business_date'], 'pos_order_settlements_business_date_index');
  });
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropColumn('business_date');
  });
};
