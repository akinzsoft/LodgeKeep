'use strict';

/**
 * Gap closure (user-reported): "change the forgot-password flow from an
 * emailed reset link to an emailed numeric code." Confirmed with the user
 * before building: the old link/token-based flow is removed entirely, not
 * kept alongside the new code-based one (`20261027090000_create_password_reset_codes.js`,
 * this same pass) — `password_resets` (created in
 * 20260903210341_create_auth_credentials.js) has no remaining callers once
 * `requestPasswordReset`/`completePasswordReset` (`src/auth/service.js`) are
 * replaced by `requestPasswordResetCode`/`completePasswordResetWithCode`.
 *
 * `down()` recreates the table byte-for-byte as the original migration
 * defined it (copied directly from that file, not hand-reconstructed) so
 * `migrate:rollback` stays a true inverse of `up()`.
 *
 * Deploy-ordering note: this migration and the application code that stops
 * using `password_resets` land in the same deploy. Any reset request mid-
 * flight at deploy time (at most 1 hour old, the old flow's own expiry)
 * simply becomes unreachable — the person re-requests, through the new
 * code-based flow.
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

function tenantScopedUserForeignKey(table, constraintName) {
  table
    .foreign(['tenant_id', 'user_id'], constraintName)
    .references(['tenant_id', 'id'])
    .inTable('users')
    .onDelete(RESTRICT.onDelete)
    .onUpdate(RESTRICT.onUpdate);
}

exports.up = async function up(knex) {
  await knex.schema.dropTableIfExists('password_resets');
};

exports.down = async function down(knex) {
  await knex.schema.createTable('password_resets', (table) => {
    table.comment(
      'Emailed single-use password-reset tokens (PRODUCT_REQUIREMENTS.md §3.16 — never email a password). Scope: TENANT_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();

    table
      .string('token_hash', TOKEN_HASH_LENGTH)
      .notNullable()
      .comment('SHA-256 hex digest of the emailed token. The plaintext exists only in the email; a database backup yields no usable reset links.');

    table.datetime('expires_at').notNullable();

    table
      .datetime('used_at')
      .nullable()
      .comment('Set by the conditional UPDATE that claims this token. NULL means unspent; a second use finds zero affected rows and is rejected (AUTH-7).');

    timestamps(knex, table);

    table.unique(['token_hash'], { indexName: 'password_resets_token_hash_unique' });

    tenantScopedUserForeignKey(table, 'password_resets_tenant_id_user_id_foreign');

    table.index(['tenant_id', 'user_id'], 'password_resets_tenant_id_user_id_index');
    table.index(['expires_at'], 'password_resets_expires_at_index');
  });
};
