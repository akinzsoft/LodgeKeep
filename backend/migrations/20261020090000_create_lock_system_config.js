'use strict';

/**
 * Per-property door-lock configuration — PLAN.md Phase 7,
 * PRODUCT_REQUIREMENTS.md §3.23 ("Lock configuration ... is per-property
 * data, not code").
 *
 * Deliberately narrower than DATABASE.md's forward-declared row: only the
 * columns the confirmed hardware (HiRead ProUSB, standalone offline,
 * `manual_import`) actually uses. `credentials`, `gateway_installed`,
 * `supports_realtime`, `tier` and `last_connection_test_at` describe
 * networked/cloud adapters nobody is integrating yet — adding a column
 * later is a cheap, backwards-compatible migration; carrying speculative
 * ones now is not free (every reader has to reason about them).
 *
 * `adapter`/`ingestion_mode` are plain VARCHARs, never ENUMs, so a future
 * adapter needs no ALTER — the same "stable machine key, checked by string
 * equality" reasoning `plan_entitlements.feature_key` already uses.
 *
 * `import_mapping` is JSON on this singleton row rather than its own table:
 * one mapping per property, overwritten on each successful import, never
 * versioned — the `email_settings` (singleton column) vs `email_templates`
 * (a list, its own table) distinction.
 *
 * This row is also the import-commit LOCK TARGET: it exists exactly once
 * per property before any import can run (an import requires an adapter
 * other than `none`), so `SELECT ... FOR UPDATE` on it serialises every
 * commit for one property — see `access-monitoring/service.js`.
 *
 * Scope: PROPERTY_SCOPED.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('lock_system_config', (table) => {
    table.comment('Per-property door-lock adapter choice, saved import column mapping and detection tuning. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table
      .string('adapter', 40)
      .notNullable()
      .defaultTo('none')
      .comment('none / hiread_prousb / generic_csv — plain string, never an ENUM.');
    table
      .string('ingestion_mode', 40)
      .nullable()
      .comment('manual_import for every adapter built so far; NULL while adapter is none.');
    table
      .json('import_mapping')
      .nullable()
      .comment('The column mapping from the last successful import, reused as the next import default.');
    table
      .integer('post_checkout_grace_minutes')
      .unsigned()
      .notNullable()
      .defaultTo(15)
      .comment('Guest-card opens within this many minutes of a recorded checkout are ignored (fetching a forgotten bag).');
    table.datetime('last_import_at').nullable().comment('Shown on the retrospective-detection banner.');

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table
      .foreign(['tenant_id', 'property_id'], 'lock_system_config_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.unique(['tenant_id', 'property_id'], { indexName: 'lock_system_config_tenant_property_unique' });
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lock_system_config');
};
