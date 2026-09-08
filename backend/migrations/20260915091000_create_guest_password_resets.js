'use strict';

/**
 * Gap closure (flagged in CLAUDE.md's own Phase 4 section, built via
 * feature-dev): guest password-reset. Follows `password_resets`' own shape
 * (single-use, SHA-256 token digest, state derived from `used_at`/
 * `expires_at`, hard-deletable — credentials, not history; the durable
 * record is `auth_events`) with the one scope difference the parent table
 * demands: `guest_accounts` is PROPERTY_SCOPED (a guest logs into one
 * property's own portal), so this table is too — a straight copy of
 * `password_resets`' TENANT_SCOPED shape would be wrong here, since a
 * guest's whole identity is anchored to one property, not the tenant.
 *
 * `token_hash` is `UNIQUE` globally, not per-tenant/property — the same
 * reasoning `password_resets`/`user_invitations` already establish: a
 * 256-bit random value is globally unique by construction, and the lookup
 * (`completeGuestPasswordReset`) lands before the property is known, via
 * `acrossProperties()` on a tenant-only context — the same mechanism
 * `acceptInvitation` already uses for the identical "no session yet"
 * shape.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };
const TOKEN_HASH_LENGTH = 64;

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('guest_password_resets', (table) => {
    table.comment(
      'Emailed single-use guest password-reset tokens. Scope: PROPERTY_SCOPED, matching guest_accounts — a genuinely separate store from staff password_resets (TENANT_SCOPED).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('guest_account_id').unsigned().notNullable();

    table
      .string('token_hash', TOKEN_HASH_LENGTH)
      .notNullable()
      .comment('SHA-256 hex digest of the emailed token. The plaintext exists only in the email; a database backup yields no usable reset links.');

    table.datetime('expires_at').notNullable();

    // Single-use, the same conditional-UPDATE-with-affected-row-check shape
    // password_resets.used_at already establishes — see that migration's
    // own header for the concurrency reasoning.
    table
      .datetime('used_at')
      .nullable()
      .comment('Set by the conditional UPDATE that claims this token. NULL means unspent; a second use finds zero affected rows and is rejected.');

    timestamps(knex, table);

    table.unique(['token_hash'], { indexName: 'guest_password_resets_token_hash_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'guest_password_resets_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // Shortened from the naturally-generated
    // guest_password_resets_tenant_id_property_id_guest_account_id_foreign
    // (68 chars), which exceeds MySQL's 64-character identifier limit —
    // the same class of bug this codebase's own migration history has hit
    // and documented at least three times before.
    table
      .foreign(['tenant_id', 'property_id', 'guest_account_id'], 'guest_password_resets_guest_account_fk')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('guest_accounts')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // Outstanding resets for a guest account.
    table.index(['tenant_id', 'property_id', 'guest_account_id'], 'guest_password_resets_property_guest_account_index');
    table.index(['expires_at'], 'guest_password_resets_expires_at_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('guest_password_resets');
};
