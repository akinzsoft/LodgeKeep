/**
 * The marketing landing page's editable content (platform console, user-requested).
 *
 * `landing_content_versions` is APPEND-ONLY: saving, resetting to defaults and
 * restoring an older version each INSERT a row, and the newest row is the live
 * content. The table holds only OVERRIDES of the defaults that ship in the
 * frontend (`frontend/src/landing/landingContent.js`); no row, or an empty
 * `content_json`, means "show the defaults". It never holds the monthly fee or
 * the trial length: those are read live from the billing plan and the trial
 * setting so the page can never quote something customers are not charged.
 *
 * PLATFORM_SCOPED with no tenant column (it is Planmsys's own marketing, not
 * any tenant's data). Kept by the tenant purge. No delete endpoint exists; the
 * history of who changed the page and when is the audit trail.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('landing_content_versions', (table) => {
    table.comment('Versions of the marketing landing page content overrides, newest row is live. Scope: PLATFORM_SCOPED.');

    table.bigIncrements('id');
    table.json('content_json').notNullable().comment('Validated overrides of the frontend defaults. An empty object means "use the defaults".');
    table.string('note', 200).nullable().comment('Why: "Saved", "Reset to defaults" or "Restored version N".');
    table.bigInteger('created_by_platform_user_id').unsigned().notNullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table
      .foreign('created_by_platform_user_id', 'landing_content_versions_created_by_foreign')
      .references('id')
      .inTable('platform_users')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('landing_content_versions');
};
