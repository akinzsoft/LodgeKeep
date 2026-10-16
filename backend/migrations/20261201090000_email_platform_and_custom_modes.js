'use strict';

/**
 * Email modes per property: "platform" (the platform's own SMTP, the new
 * default) and custom (the property's own SMTP; stored as provider = 'smtp',
 * so rows that already have a real SMTP configured are left exactly as they
 * are). "console" stays valid for local development only.
 *
 * - email_settings.provider default 'console' -> 'platform'.
 * - New columns: smtp_security ('tls' | 'starttls'; NULL = derived from the
 *   port, which is how every existing custom row already behaved), reply_to
 *   (the Reply-To used in platform mode), and the last test result.
 * - Backfill: rows still on 'console' -> 'platform', except tenants that are
 *   purging/purged (their data is on its way out; do not touch it).
 * - notification_log.outbox_event_id: lets Resend rebuild the original email
 *   (an invitation link, a code) from the event payload. Nullable, no FK.
 *
 * down: platform -> console (the old default), columns dropped. Rows that
 * were created as 'platform' after this migration also go back to 'console',
 * which is the only value the old code understands.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('email_settings', (table) => {
    table.string('smtp_security', 10).nullable().comment("'tls' (implicit TLS) or 'starttls'. NULL = derived from the port.");
    table.string('reply_to', 254).nullable().comment('Reply-To for platform mode. NULL = the first active super_admin.');
    table.datetime('last_test_at').nullable();
    table.boolean('last_test_ok').nullable();
    table.string('last_test_error', 300).nullable();
  });
  await knex.raw("ALTER TABLE email_settings MODIFY provider VARCHAR(20) NOT NULL DEFAULT 'platform'");
  await knex.schema.alterTable('notification_log', (table) => {
    table.bigInteger('outbox_event_id').unsigned().nullable();
    table.index(['outbox_event_id'], 'notification_log_outbox_event_id_index');
  });
  await knex.raw(
    `UPDATE email_settings es
       JOIN tenants t ON t.id = es.tenant_id
        SET es.provider = 'platform'
      WHERE es.provider = 'console'
        AND t.status NOT IN ('purging', 'purged')`
  );
};

exports.down = async function down(knex) {
  await knex('email_settings').where({ provider: 'platform' }).update({ provider: 'console' });
  await knex.raw("ALTER TABLE email_settings MODIFY provider VARCHAR(20) NOT NULL DEFAULT 'console'");
  await knex.schema.alterTable('notification_log', (table) => {
    table.dropIndex(['outbox_event_id'], 'notification_log_outbox_event_id_index');
    table.dropColumn('outbox_event_id');
  });
  await knex.schema.alterTable('email_settings', (table) => {
    table.dropColumn('smtp_security');
    table.dropColumn('reply_to');
    table.dropColumn('last_test_at');
    table.dropColumn('last_test_ok');
    table.dropColumn('last_test_error');
  });
};
