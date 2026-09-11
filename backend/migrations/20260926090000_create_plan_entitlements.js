'use strict';

/**
 * `plan_entitlements` — PLAN.md Phase 5's own final exit criterion: "a
 * tenant on a lower plan calling a gated endpoint directly is rejected."
 * PRODUCT_REQUIREMENTS.md §3.22 ("a single entitlement check used
 * everywhere"). `plans`' own migration (20260924090000) already forward-
 * declared this exact table and deferred it explicitly; DATABASE.md's own
 * row for it has named this shape — `plan_id, feature_key, enabled` —
 * since that pass, unbuilt until now.
 *
 * Scope: GLOBAL_REFERENCE, following `plans` (its own FK parent) exactly —
 * one shared catalogue, no tenant dimension, read-only through the
 * accessor (src/shared/entitlements.js is the one thing that reads it).
 *
 * `feature_key` is a plain VARCHAR, deliberately not an ENUM — a new gated
 * capability (§3.22 names three more beyond this pass's own
 * `multi_property`: advanced revenue management, channel manager
 * integration, door access monitoring) must never need a MODIFY COLUMN
 * just to add its key, the same reasoning `permissions.permission_key`
 * already applies to its own catalogue.
 *
 * `enabled` defaults to `false` — an entitlement row inserted without an
 * explicit value grants nothing. Fails closed, matching this codebase's
 * own safe-default instinct elsewhere (`isTenantWriteBlocked`'s fallthrough
 * in `src/shared/tenant-lifecycle.js`).
 *
 * Seeded in this SAME migration for the already-existing `standard` plan,
 * not a second backfill migration — unlike `20260924095000_seed_billing_
 * permissions.js`'s two-migration shape (which backfilled MANY existing,
 * independently-created `role_permissions` rows across every tenant),
 * `plan_entitlements` has no such multiplicity: there is exactly one
 * `plans` row to seed against today, the same one-shot
 * create-table-and-seed-its-row shape `20260924090000_create_plans.js`
 * itself already used. `standard` gets `multi_property: enabled: true` so
 * this migration changes no tenant's existing behaviour — every tenant
 * already on `standard` (or with a null `plan_id`, which resolves to the
 * one active default plan, `src/shared/entitlements.js`) keeps creating
 * properties exactly as before.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('plan_entitlements', (table) => {
    table.comment(
      'Which gated features a plan unlocks — the entitlement-gating exit criterion of PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md section 3.22. Scope: GLOBAL_REFERENCE, following plans exactly.'
    );

    table.bigIncrements('id');

    table
      .bigInteger('plan_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('plans')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');

    table
      .string('feature_key', 100)
      .notNullable()
      .comment('A stable machine key, checked by string equality — never an ENUM, so a new gated capability needs no schema change to add its key.');

    table
      .boolean('enabled')
      .notNullable()
      .defaultTo(false)
      .comment('Fail-closed default — a row inserted without an explicit value grants nothing.');

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table
      .datetime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table.unique(['plan_id', 'feature_key'], 'plan_entitlements_plan_feature_unique');
  });

  const standardPlan = await knex('plans').where({ code: 'standard' }).first('id');
  if (standardPlan) {
    await knex('plan_entitlements').insert({
      plan_id: standardPlan.id,
      feature_key: 'multi_property',
      enabled: true,
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('plan_entitlements');
};
