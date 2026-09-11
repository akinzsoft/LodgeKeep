'use strict';

/**
 * `plans` — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22 ("Plans &
 * entitlements: plan definitions... and a single entitlement check used
 * everywhere"). This pass wires the plan catalogue and `tenants.plan_id`
 * itself; the entitlement CHECK (gating multi-property/advanced revenue
 * management/channel manager/door access per plan) is explicitly out of
 * this pass's scope, per its own instructions — this table exists and is
 * wired to a real subscription, nothing yet reads it to gate a feature.
 *
 * Scope: GLOBAL_REFERENCE, matching `permissions`' own reasoning exactly —
 * a shared, seeded, tenant-independent catalogue no tenant edits through
 * the accessor (ARCHITECTURE.md §3). Seeded here with exactly one row
 * ("at minimum one plan for now," per this pass's own scope) — `code`
 * being a real, stable string (not the auto-increment `id`) is what lets
 * `DEFAULT_PLAN_CODE`-shaped lookups in application code survive a
 * reseed/rollback without hardcoding an id that could differ between
 * environments.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

const DEFAULT_PLAN_CODE = 'standard';

exports.up = async function up(knex) {
  await knex.schema.createTable('plans', (table) => {
    table.comment(
      'The plan catalogue Planmsys bills its own tenant customers against. Scope: GLOBAL_REFERENCE — seeded, read-only through the accessor, same as `permissions`.'
    );

    table.bigIncrements('id');

    table
      .string('code', 50)
      .notNullable()
      .unique('plans_code_unique')
      .comment('Stable machine key application code looks up by (e.g. "standard") — never the auto-increment id, which can differ between environments.');
    table.string('name', 150).notNullable();

    table.decimal('price', 12, 2).notNullable().comment('DECIMAL-as-string, exact — src/shared/money.js\'s own BigInt-cents arithmetic, never float (ARCHITECTURE.md section 1).');
    table.string('currency', 3).notNullable().comment('ISO 4217 — Planmsys\' own billing currency, independent of any property\'s own operating currency (a tenant\'s properties may each run a different currency; this is Planmsys\' relationship with the TENANT, not a property).');

    table
      .enu('billing_interval', ['monthly'])
      .notNullable()
      .defaultTo('monthly')
      .comment('Only "monthly" exists this pass. A free string was considered and rejected: ARCHITECTURE.md section 7\'s own fixed-enum precedent for the payment state machine argues for a closed set here too, since a typo\'d interval this codebase\'s own billing-cycle math does not recognise is exactly the class of silent bug a free string invites.');

    table
      .boolean('is_active')
      .notNullable()
      .defaultTo(true)
      .comment('A retired plan stays for historical subscriptions still referencing it (RESTRICT, never CASCADE) but is excluded from what a NEW subscription may choose — no such choice exists yet this pass (one plan only), but the column exists so a second plan does not need a schema change.');

    timestamps(knex, table);
  });

  await knex('plans').insert({
    code: DEFAULT_PLAN_CODE,
    name: 'Standard',
    price: '50000.00',
    currency: 'NGN',
    billing_interval: 'monthly',
    is_active: true,
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('plans');
};
