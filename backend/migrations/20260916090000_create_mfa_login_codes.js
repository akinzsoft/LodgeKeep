'use strict';

/**
 * Gap closure (user-reported, live-tested): "the verification code shld be
 * send to the account email to login not a static code." Replaces the
 * fixed `000000` dev-only bypass (`src/auth/mfa.js`'s previous shape) with
 * a real, per-login, emailed 6-digit code — the first genuinely working
 * MFA verification this codebase has ever had, in every environment, not
 * just a development convenience.
 *
 * Scope: TENANT_SCOPED, matching `password_resets` — the challenge exists
 * before an active property is chosen, so there is no property to scope
 * to yet (the same reasoning that migration's own header gives).
 *
 * `code_hash` is deliberately NOT `UNIQUE`, unlike every other token table
 * in this codebase (`password_resets`, `guest_password_resets`,
 * `user_invitations`, `sessions`). Those all hash a 256-bit random value,
 * astronomically unlikely to collide. A 6-digit numeric code has only
 * 1,000,000 possible values — two different users being issued the same
 * code around the same time is a real, unremarkable event, not a bug, and
 * a global UNIQUE constraint here would turn an ordinary coincidence into
 * a failed INSERT. Lookups are scoped to `(tenant_id, user_id)` instead —
 * see `service.js`'s own `verifyStaffMfa` for the exact query shape.
 *
 * `attempts` is this table's own, narrow brute-force guard: a 6-digit
 * code is far weaker than a 256-bit token, so unlike its siblings this one
 * needs a cap on how many wrong guesses a single issued code tolerates
 * before it's treated as spent regardless of what's submitted next.
 * Deliberately NOT integrated with `lockout.js`'s existing per-account/
 * per-IP dimensions (that mechanism counts `login_failure` events —
 * password attempts — and doing the same job for MFA codes needs its own
 * threshold, since 5 wrong 6-digit guesses is a very different risk than 5
 * wrong passwords). A real, narrower gap flagged here rather than silently
 * left unguarded or over-built in the same pass: an attacker who
 * repeatedly re-triggers a fresh login (with the correct password each
 * time, which the existing account lockout never penalizes) gets a fresh
 * code and a fresh attempts budget every time. Closing that fully needs
 * its own dimension on `checkStaffLockout`, deferred as real, separate
 * scope.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };
const CODE_HASH_LENGTH = 64;

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('mfa_login_codes', (table) => {
    table.comment(
      // No apostrophes: knex parameterizes column comments but interpolates
      // TABLE comments straight into the DDL, so one would terminate the
      // string and break the migration — the same class of bug this
      // codebase has hit and documented before.
      'Emailed, single-use, short-lived MFA login codes. Scope: TENANT_SCOPED, matching password_resets. See this migration file header for why code_hash carries no UNIQUE constraint, unlike the token-based sibling tables.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();

    table
      .string('code_hash', CODE_HASH_LENGTH)
      .notNullable()
      .comment('SHA-256 hex digest of the emailed 6-digit code. The plaintext exists only in the email (and, outside production, the login response\'s own dev_only_code field).');

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

    table
      .foreign(['tenant_id', 'user_id'], 'mfa_login_codes_tenant_id_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The lookup `verifyStaffMfa` runs on every attempt: "the outstanding
    // code for this user."
    table.index(['tenant_id', 'user_id'], 'mfa_login_codes_tenant_id_user_id_index');
    table.index(['expires_at'], 'mfa_login_codes_expires_at_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('mfa_login_codes');
};
