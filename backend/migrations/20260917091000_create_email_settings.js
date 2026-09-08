'use strict';

/**
 * Per-property email/SMTP configuration — user-confirmed decision
 * (AskUserQuestion, "per-property, stored in the database"). Until this
 * migration, `src/modules/notifications/email-adapter.js`'s email
 * transport was a single, whole-process `EMAIL_PROVIDER`/`SMTP_*` set of
 * environment variables — correct for this codebase's first real delivery
 * pass, but not the actual multi-tenant shape: a real SaaS customer wants
 * mail to genuinely come from their OWN hotel's mailbox/domain, the same
 * "configuration, never a code branch" reasoning `email_templates` already
 * established for per-property branded content, applied here to the
 * transport itself.
 *
 * One row per property (a singleton config, not a growing list) —
 * `UNIQUE(tenant_id, property_id)`, unlike `email_templates`'
 * three-column unique key, since there is only ever one active email
 * configuration per property, never one per template/locale. A property
 * with no row here (the common case immediately after this migration
 * runs) falls back to the process-level `EMAIL_PROVIDER`/`SMTP_*`
 * environment variables — `resolveEffectiveEmailConfig`
 * (`src/modules/notifications/email-adapter.js`) is what actually
 * implements that fallback, the same "property-configured override, else
 * a built-in default" shape `renderTemplate` already established for
 * `email_templates` itself.
 *
 * `smtp_password_encrypted` is genuinely encrypted at rest (`src/shared/
 * encryption.js`, AES-256-GCM), never plaintext — the first real secret
 * this schema has ever stored (SECURITY.md §7's own "encryption at rest
 * for guest PII and payment data" line names data, not credentials, but
 * the same discipline applies with more force to a password than to a
 * guest's phone number). `provider` is a free string, not an ENUM — the
 * same "adding a new provider later needs no schema change" reasoning
 * `payments.provider` already established.
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
  await knex.schema.createTable('email_settings', (table) => {
    table.comment('A property-specific email or SMTP configuration, overriding the process-level default. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table
      .string('provider', 20)
      .notNullable()
      .defaultTo('console')
      .comment('"console" (logs instead of sending) or "smtp" (real delivery). Free string, matching payments.provider, so a future provider needs no schema change.');
    table.string('smtp_host', 255).nullable();
    table.integer('smtp_port').unsigned().nullable();
    table.string('smtp_user', 255).nullable();
    table.text('smtp_password_encrypted', 'text').nullable().comment('AES-256-GCM ciphertext (src/shared/encryption.js) — never plaintext.');
    table.string('smtp_from', 255).nullable();
    table.string('smtp_from_name', 255).nullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id'], { indexName: 'email_settings_tenant_id_property_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'email_settings_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_settings');
};
