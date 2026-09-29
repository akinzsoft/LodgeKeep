'use strict';

/**
 * Platform database backups (user-requested: "a feature in the platform page
 * where I can click Backup and specify the email to send it to").
 * Confirmed with the user: the WHOLE database (every tenant), encrypted with
 * a passphrase typed at the moment of the backup (never stored, never
 * emailed), and only platform admins may start one.
 *
 * `platform_backups` — one row per backup request: who asked, where it was
 * sent, and how it went. PLATFORM_SCOPED like `platform_users` (no tenant:
 * a backup spans every tenant). It is the audit trail of every copy of the
 * database that has left the server, so there is no delete endpoint and it
 * is never purged. The file itself is not kept on the server.
 *
 * `status`: `running` -> `sent` | `failed`. A row still `running` long after
 * it started (the process restarted mid-backup) is reported as failed by the
 * service rather than left spinning forever.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('platform_backups', (table) => {
    table.comment('Whole-database backups emailed from the platform console (who, to where, outcome). Scope: PLATFORM_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('requested_by_platform_user_id').unsigned().notNullable();
    table.string('recipient_email', 255).notNullable();
    table.enu('status', ['running', 'sent', 'failed']).notNullable().defaultTo('running');
    table.string('file_name', 255).nullable();
    table.bigInteger('size_bytes').unsigned().nullable().comment('The encrypted attachment, as emailed.');
    table.integer('table_count').unsigned().nullable();
    table.bigInteger('row_count').unsigned().nullable();
    table.string('email_provider', 30).nullable().comment('`smtp`, or `console` when no real email provider is configured (nothing was actually delivered).');
    table.string('error', 500).nullable();
    table.datetime('requested_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('completed_at').nullable();

    table
      .foreign('requested_by_platform_user_id', 'platform_backups_requested_by_foreign')
      .references('id')
      .inTable('platform_users')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
    table.index(['requested_at'], 'platform_backups_requested_at_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('platform_backups');
};
