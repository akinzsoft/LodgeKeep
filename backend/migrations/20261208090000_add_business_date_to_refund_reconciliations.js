'use strict';

/**
 * The business date a card refund was PROCESSED on, so the Sales report and the payment reconciliation can show a
 * refund as a negative line on the day it happened (and never change a closed day after the fact).
 *
 * It lives here, not on `payments`, because a refund's `payments` row is pinned by the hotel golden-output snapshots and
 * must gain no column. Nullable: set when the refund is processed (the property's `current_business_date` then); a refund
 * processed before this column existed has none, and the reports fall back to its capture date in the property's timezone.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('refund_reconciliations', (table) => {
    table.date('business_date').nullable().comment('Property business date on which the refund was processed. NULL for a refund that predates this column or is not processed yet.');
    table.index(['tenant_id', 'property_id', 'business_date'], 'refund_reconciliations_bdate_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('refund_reconciliations', (table) => {
    table.dropIndex(['tenant_id', 'property_id', 'business_date'], 'refund_reconciliations_bdate_index');
    table.dropColumn('business_date');
  });
};
