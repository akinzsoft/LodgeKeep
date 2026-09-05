'use strict';

/**
 * Cancellation policies — PLAN.md Phase 1 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.19 ("Cancellation & no-show policies: rules and any associated fees,
 * referenced at reservation time"), DATABASE.md §1.
 *
 * Scope: PROPERTY_SCOPED, same reasoning as `market_segments`/
 * `booking_sources` (this migration set's own two prior files) — closes the
 * third and last of the three forward references the reservations migration
 * left open for exactly this reason.
 *
 * `fee_type`/`fee_value`/`cutoff_hours` are stored as data because
 * ARCHITECTURE.md's own "configuration, never code branches" rule
 * (PRODUCT_REQUIREMENTS.md §1.1) forbids hardcoding a fee formula per
 * property. What is deliberately NOT built in this pass: automatic fee
 * computation and folio posting at cancellation time — that is real new
 * business logic (a fee engine plus a folio adjustment), not "reference
 * data", and is flagged here rather than half-built. This table only
 * stores the rule and lets a reservation record which policy applied;
 * charging it is a follow-on gap for whoever picks this up next.
 *
 * `cutoff_hours` — hours before arrival after which cancelling triggers the
 * fee; NULL means "no free-cancellation window, the fee always applies".
 * `fee_type`: `none` (informational only), `flat_fee` (uses `fee_value` as a
 * currency amount), `first_night` (charges the reservation's first night's
 * rate — no `fee_value` needed), `percentage` (uses `fee_value` as 0-100 of
 * the total stay value).
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
  await knex.schema.createTable('cancellation_policies', (table) => {
    table.comment(
      'A cancellation/no-show rule a reservation can be booked under. Scope: PROPERTY_SCOPED. Archive, never delete. Fee computation/posting is not yet wired to any reservation action — see file header.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.string('code', 30).notNullable().comment('Short machine key, unique per property, not globally.');
    table.string('name', 150).notNullable();
    table.text('description').nullable();

    table
      .integer('cutoff_hours')
      .unsigned()
      .nullable()
      .comment('Hours before arrival after which cancelling is fee-liable. NULL = fee always applies.');

    table.enu('fee_type', ['none', 'flat_fee', 'first_night', 'percentage']).notNullable().defaultTo('none');

    // DECIMAL, never FLOAT (ARCHITECTURE.md §1/§12) — currency amount for
    // flat_fee, or a 0-100 percentage for `percentage`; unused for
    // `none`/`first_night`.
    table.decimal('fee_value', 12, 2).nullable();

    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    table.unique(['property_id', 'code'], { indexName: 'cancellation_policies_property_id_code_unique' });

    table.unique(['tenant_id', 'property_id', 'id'], {
      indexName: 'cancellation_policies_tenant_id_property_id_id_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'cancellation_policies_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'status'], 'cancellation_policies_tenant_id_property_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('cancellation_policies');
};
