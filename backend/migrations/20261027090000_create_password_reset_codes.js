'use strict';

/**
 * Gap closure (user-reported): "change the forgot-password flow from an
 * emailed reset link to an emailed numeric code" — reusing the exact
 * `mfa_login_codes` pattern (20260916090000) rather than inventing a second
 * one. Replaces `password_resets` (created in
 * 20260903210341_create_auth_credentials.js), dropped by the companion
 * migration `20261027091000_drop_password_resets.js` in this same pass —
 * the old link-based flow is removed entirely, confirmed with the user, not
 * kept alongside this one.
 *
 * Scope: TENANT_SCOPED, matching `mfa_login_codes`/the old `password_resets`
 * — a password reset happens before an active property is chosen, so there
 * is no property to scope to yet.
 *
 * The one real divergence from `mfa_login_codes`'s own shape: lookup is
 * keyed by `request_id` (a fresh UUID minted on every request and carried
 * inside the signed challenge token returned to the caller), never by
 * `user_id`. `mfa_login_codes` can safely key on `user_id` because
 * `verifyStaffMfa` only ever runs after a password has already been
 * verified — the account's existence is no longer a secret at that point.
 * Forgot-password is pre-auth and must stay anti-enumeration-safe
 * (PRODUCT_REQUIREMENTS.md §3.16): the challenge token has to carry
 * something that identifies "this attempt" without ever revealing whether
 * the target account exists, and `user_id` can't do that for an unknown
 * email — a fresh, always-present `request_id` can, since it's minted
 * identically whether or not a real user was actually found.
 *
 * `code_hash` is deliberately NOT `UNIQUE`, for the identical reason
 * `mfa_login_codes.code_hash` isn't: a 6-digit numeric code has only
 * 1,000,000 possible values, so two different users being issued the same
 * code around the same time is an ordinary coincidence, not a bug — lookups
 * go through `request_id` instead, which IS globally unique (a UUIDv4, the
 * same "a high-entropy random value is unique by construction" reasoning
 * `password_resets.token_hash`/`user_invitations.token_hash` already used).
 *
 * `attempts`/`expires_at`/`used_at` all mirror `mfa_login_codes` exactly —
 * see that migration's own header for the full reasoning (a 6-digit code's
 * weaker keyspace needs its own brute-force cap, deliberately not folded
 * into `lockout.js`'s existing per-account/per-IP dimensions).
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };
const CODE_HASH_LENGTH = 64;
const REQUEST_ID_LENGTH = 36; // a UUIDv4's canonical string length

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('password_reset_codes', (table) => {
    table.comment(
      // No apostrophes: knex parameterizes column comments but interpolates
      // TABLE comments straight into the DDL, so one would terminate the
      // string and break the migration — the same class of bug this
      // codebase has hit and documented before.
      'Emailed, single-use, short-lived password-reset codes. Scope: TENANT_SCOPED, matching mfa_login_codes. See this migration file header for why lookup is keyed by request_id, not user_id, and why code_hash carries no UNIQUE constraint.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();

    table
      .string('request_id', REQUEST_ID_LENGTH)
      .notNullable()
      .comment('A fresh UUID minted on every /password/forgot call, found or not — carried inside the signed reset_token the caller holds across the request/verify round trip. Never derived from the user, so it reveals nothing about whether an account was found.');

    table
      .string('code_hash', CODE_HASH_LENGTH)
      .notNullable()
      .comment('SHA-256 hex digest of the emailed 6-digit code. The plaintext exists only in the email (and, outside production, the request response\'s own dev_only_code field).');

    table
      .integer('attempts')
      .unsigned()
      .notNullable()
      .defaultTo(0)
      .comment('Incremented on each wrong guess against this specific code. Capped in application code (service.js) — this table only stores the count.');

    table.datetime('expires_at').notNullable();

    table
      .datetime('used_at')
      .nullable()
      .comment('Set by the conditional UPDATE that claims this code. NULL means unspent.');

    timestamps(knex, table);

    table.unique(['request_id'], { indexName: 'password_reset_codes_request_id_unique' });

    table
      .foreign(['tenant_id', 'user_id'], 'password_reset_codes_tenant_id_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // "Supersede any outstanding code for this user" on a repeat request.
    table.index(['tenant_id', 'user_id'], 'password_reset_codes_tenant_id_user_id_index');
    table.index(['expires_at'], 'password_reset_codes_expires_at_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('password_reset_codes');
};
