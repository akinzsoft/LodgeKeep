'use strict';

/**
 * Door-access data retention — PRODUCT_REQUIREMENTS.md §3.23's legal/privacy
 * note ("retained on a defined schedule rather than kept forever ...
 * configurable per tenant, since the applicable regime follows the
 * property's location, not the platform's"). `lock_system_config` shipped
 * in Phase 7's first slice with no retention column at all — door events
 * were kept indefinitely, flagged as a real gap in that pass's own header.
 * This closes it.
 *
 * `retention_days` is nullable, default NULL — confirmed with the user:
 * no property purges automatically until an admin explicitly sets a real
 * number via Setup. A pre-set default (e.g. 365) would apply a real
 * retention POLICY to every existing property's PII on the tenant's
 * behalf, on a number nobody there actually chose — the same "raw facts,
 * no invented thresholds" discipline the platform-health pass already
 * established for this codebase. A whole number of days (not hours/a
 * timestamp) because that's the unit every jurisdiction's own retention
 * language uses ("X days/months/years"), and it deliberately has no
 * upper-bound DB constraint beyond the application-layer sanity check in
 * `access-monitoring/service.js`'s `updateConfig` (1-3650 days) — the
 * column itself stays a plain nullable INT so a future jurisdiction with a
 * longer legally-mandated window needs no migration.
 *
 * What "retention" purges, and what it deliberately never touches, is
 * `access-monitoring/service.js`'s `purgeExpiredEvents` own header, not
 * repeated here — this migration only adds the number that function reads.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('lock_system_config', (table) => {
    table
      .integer('retention_days')
      .unsigned()
      .nullable()
      .comment('Door event retention window in days. NULL = no automatic purge configured (the default for every property until an admin sets one).');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('lock_system_config', (table) => {
    table.dropColumn('retention_days');
  });
};
