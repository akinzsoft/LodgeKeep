'use strict';

/**
 * Stock request top-ups (user-requested: "top-ups after a short issue").
 * A request is still decided once — confirmed with the user, the store
 * never sends more against an issued request. Instead, an outlet whose
 * request was issued short raises a NEW request for the rest ("Request the
 * rest", an editable form pre-filled with the shortfall), and that new
 * request records which one it tops up, so the paper trail reads
 * "#15 — top-up of #12".
 *
 * `top_up_of_request_id` — nullable; set only on a top-up, pointing at an
 * ISSUED request of the same property with the same two outlets (the
 * service enforces both, and that the original was really sent short).
 * A composite self-reference `(tenant_id, property_id, top_up_of_request_id)`
 * onto the table's own parent key, RESTRICT like every other key here, so
 * a top-up can never point at another tenant's or property's request. The
 * tenant purge NULLs it before deleting (purge-plan.js SELF_REFERENCES).
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('stock_transfer_requests', (table) => {
    table
      .bigInteger('top_up_of_request_id')
      .unsigned()
      .nullable()
      .after('note')
      .comment('Set on a top-up: the issued-short request whose shortfall this one asks for.');
    table
      .foreign(['tenant_id', 'property_id', 'top_up_of_request_id'], 'stock_transfer_requests_top_up_of_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('stock_transfer_requests')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('stock_transfer_requests', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'top_up_of_request_id'], 'stock_transfer_requests_top_up_of_foreign');
  });
  await knex.schema.alterTable('stock_transfer_requests', (table) => {
    table.dropIndex(['tenant_id', 'property_id', 'top_up_of_request_id'], 'stock_transfer_requests_top_up_of_foreign');
  });
  await knex.schema.alterTable('stock_transfer_requests', (table) => {
    table.dropColumn('top_up_of_request_id');
  });
};
