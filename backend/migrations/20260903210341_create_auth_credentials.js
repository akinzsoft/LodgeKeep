'use strict';

/**
 * Auth credentials — DATABASE.md §1 ("Identity & access"), PRODUCT_REQUIREMENTS.md
 * §3.16, SECURITY.md §1.1. The four tables the Phase 0 auth deliverable needs
 * (PLAN.md: "Auth — staff login, sessions, password reset, RBAC").
 *
 *   sessions           TENANT_SCOPED    refresh-token records; revocable
 *   password_resets    TENANT_SCOPED    single-use, time-limited reset tokens
 *   mfa_devices        TENANT_SCOPED    enrolled second factors
 *   user_invitations   PROPERTY_SCOPED  invitee sets their own password
 *
 * These four are what make three of Phase 0's closing test gates answerable at
 * all: "refresh-token revocation actually revokes" (TESTING.md AUTH-6),
 * "password reset single-use" (AUTH-7), and "all existing sessions invalidated"
 * on reset (AUTH-8).
 *
 * ── SECRETS ARE STORED AS HASHES, AND THE HASH IS NOT bcrypt ───────────────
 *
 * `refresh_token_hash` and both `token_hash` columns hold a SHA-256 hex digest
 * of a high-entropy random token, never the token itself: a stolen database
 * backup must not yield usable refresh tokens or reset links (SECURITY.md §1.1).
 *
 * SHA-256 rather than bcrypt/argon2 here is deliberate, and is the opposite of
 * the choice `users.password_hash` makes. bcrypt's work factor exists to make
 * *low-entropy* human-chosen secrets expensive to guess. These tokens are
 * 256-bit random values, so there is no dictionary to run and no guessing
 * advantage to remove — while the work factor would be paid on every single API
 * refresh, and a per-token salt would make the lookup impossible: the server
 * has to *find* the row from the presented token, which means the digest must be
 * deterministic and indexed. CHAR(64) is exactly a SHA-256 hex digest; changing
 * the digest is therefore a visible migration rather than a silent truncation.
 *
 * ── WHY THE TOKEN UNIQUES ARE GLOBAL, NOT PER-TENANT ──────────────────────
 *
 * Every other unique in this schema is scoped (`UNIQUE(tenant_id, email)`), but
 * these three are `UNIQUE(token_hash)` across the whole table, following the
 * precedent DATABASE.md §2 already sets with `pos_order_tokens: UNIQUE(token_hash)`.
 * A 256-bit random value is globally unique by construction, and the constraint
 * is what guarantees a presented token can never resolve to two rows.
 *
 * That does NOT license an unscoped read path (ARCHITECTURE.md §3). The lookup
 * still filters on tenant_id: the refresh token and the reset/invitation links
 * carry their tenant as an unauthenticated *hint*, so the query stays
 * `WHERE tenant_id = ? AND token_hash = ?` and a wrong hint simply finds
 * nothing. The unique index means that added predicate never changes which row
 * is found — it only keeps the scoped accessor honest, with no escape hatch
 * carved out of it for the auth module.
 *
 * ── LIFECYCLE (DATABASE.md §3) ────────────────────────────────────────────
 *
 * §3: "a table with no status column and no delete path is a table nobody
 * thought about." None of these four carries a `status` column, on purpose —
 * each derives its state from its own timestamps, which is a narrower and
 * non-contradictable encoding than a status column kept in sync alongside them:
 *
 *   sessions          active | revoked (revoked_at) | expired (expires_at)
 *   password_resets   pending | used (used_at) | expired (expires_at)
 *   mfa_devices       pending (confirmed_at IS NULL) | confirmed
 *   user_invitations  pending | accepted (accepted_at) | expired (expires_at)
 *
 * All four are hard-deletable, which is the deliberate exception to the
 * deactivate-never-delete rule that governs `users` and `properties`. They are
 * credentials, not history: the durable record of what happened to them is
 * `auth_events` (TESTING.md AUTH-14 — "any auth event: row in auth_events"),
 * which is a separate table with its own retention. Purging an expired session
 * therefore destroys no audit trail, and a spent reset token is safest gone.
 * This is also why no foreign key anywhere points *at* these tables.
 *
 * ── DEVIATIONS FROM DATABASE.md §1, BOTH DELIBERATE ───────────────────────
 *
 * §1 lists `user_invitations` as (tenant_id, email, role, token_hash,
 * expires_at, accepted_at). This migration adds `property_id` and
 * `invited_by_user_id` and declares the table PROPERTY_SCOPED. See the block
 * comment on that table — an invitation carrying a role but no property is the
 * global-role construct SECURITY.md §4 forbids, and cannot be accepted without
 * letting the invitee choose their own scope.
 *
 * Reference: DATABASE.md §1–3; SECURITY.md §1.1, §2–4; ARCHITECTURE.md §3
 * (scoping), §10 (IDs); PRODUCT_REQUIREMENTS.md §3.16; TESTING.md AUTH-6..AUTH-10.
 */

/**
 * Every foreign key in this file is RESTRICT/RESTRICT, as in the two migrations
 * before it (ARCHITECTURE.md §1, §8). Nothing here is a financial row, but the
 * reasoning still holds from the other direction: a CASCADE from `users` would
 * mean deleting a user silently discards the record of which devices were
 * enrolled and which sessions were open — and RESTRICT is what makes the
 * "deactivate, never delete" rule enforced rather than merely documented.
 */
const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

/** A SHA-256 hex digest — see the note on hashing in the file header. */
const TOKEN_HASH_LENGTH = 64;

/**
 * IPv6 needs 45 characters in the worst case (an IPv4-mapped address such as
 * ::ffff:255.255.255.255). VARCHAR(45) is the standard width; 15 would silently
 * truncate every v6 address into a useless prefix, and truncated audit data is
 * worse than absent audit data because it looks trustworthy.
 */
const IP_LENGTH = 45;

/** created_at / updated_at, assumed on every table (DATABASE.md §1). */
function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

/**
 * The (tenant_id, user_id) → users(tenant_id, id) composite foreign key that
 * every table here except `user_invitations` hangs off.
 *
 * Composite rather than a bare `user_id` reference for the reason SECURITY.md §2
 * gives: a single-column reference would let a row pair one tenant's id with
 * another tenant's user and leave the tenant check to application code, which
 * is precisely what "isolation is architectural, not disciplinary" rules out.
 * The parent key is `users_tenant_id_id_unique`, added by the identity migration
 * for exactly this purpose.
 */
function tenantScopedUserForeignKey(table, constraintName) {
  table
    .foreign(['tenant_id', 'user_id'], constraintName)
    .references(['tenant_id', 'id'])
    .inTable('users')
    .onDelete(RESTRICT.onDelete)
    .onUpdate(RESTRICT.onUpdate);
}

/**
 * `users.mfa_secret` is superseded by `mfa_devices` — see the comment on that
 * table. DATABASE.md forbids dropping a column in the same release that stops
 * writing to it, so this release only re-labels it; the drop is a later
 * migration once nothing reads it.
 *
 * A comment-only MODIFY is metadata-only in MySQL 8 (no table rebuild, no data
 * touched) and the definition below is otherwise character-for-character the one
 * the identity migration created, including the column's inherited
 * utf8mb4_0900_ai_ci collation, which MODIFY takes from the table default.
 */
const MFA_SECRET_COMMENT_NOW =
  'DEPRECATED — superseded by mfa_devices.secret, which is the authoritative ' +
  'store for enrolled second factors. Do not write to this column. Retained ' +
  'this release only because DATABASE.md forbids dropping a column in the same ' +
  'release that stops writing to it; dropped in a follow-up migration.';

const MFA_SECRET_COMMENT_BEFORE =
  'Encrypted at rest like any other secret (SECURITY.md §1.1) — the column ' +
  'stores ciphertext, never a bare TOTP seed.';

function setMfaSecretComment(knex, comment) {
  return knex.raw('ALTER TABLE `users` MODIFY COLUMN `mfa_secret` VARCHAR(255) NULL COMMENT ?', [
    comment,
  ]);
}

exports.up = async function up(knex) {
  // ---------------------------------------------------------------------
  // sessions — TENANT_SCOPED. Refresh-token records, revocable.
  // ---------------------------------------------------------------------
  //
  // NO property_id, and therefore not PROPERTY_SCOPED, even though SECURITY.md
  // §3 calls the active property "session state". Storing it here would create a
  // second source of truth for an authorization decision that §3 requires be
  // "verified server-side against user_property_access for the currently active
  // property" on *every* request (TESTING.md ISO-6). A stored active_property_id
  // would still have to be re-verified on each use, so it could authorize
  // nothing on its own — while a stale row surviving a revoked grant is a real
  // failure mode. The property a request concerns is carried per-request and
  // checked against user_property_access; nothing durable is needed.
  await knex.schema.createTable('sessions', (table) => {
    table.comment(
      'Refresh-token records for staff sessions. Scope: TENANT_SCOPED. Revocation must take effect immediately (PRODUCT_REQUIREMENTS.md §3.16, TESTING.md AUTH-6) — which is why the refresh token is checked against this row on every use rather than trusted until its own expiry.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();

    table
      .string('refresh_token_hash', TOKEN_HASH_LENGTH)
      .notNullable()
      .comment('SHA-256 hex digest of the refresh token, never the token itself. See the hashing note in this migration header for why this is not bcrypt.');

    table
      .datetime('expires_at')
      .notNullable()
      .comment('Natural expiry. Not sufficient on its own: a dismissed employee cannot be left with a working token until this passes, which is what revoked_at is for.');

    // The revocation mechanism behind AUTH-6 and AUTH-8. A row, not a delete,
    // so that "this session was revoked, and why" is answerable for as long as
    // the row is retained — and so revoking is an UPDATE that a concurrent
    // refresh cannot race past unnoticed.
    table.datetime('revoked_at').nullable();

    // Not in DATABASE.md §1's column list. Added because three separate
    // requirements in PRODUCT_REQUIREMENTS.md §3.16 revoke sessions for three
    // different reasons — logout, password reset ("resetting invalidates active
    // sessions"), and deactivation ("deactivation is immediate and revokes
    // sessions") — and a support question about why a terminal was logged out
    // is otherwise unanswerable. Enum rather than free text: each value
    // corresponds to a code path, so a new one is a code change.
    table
      .enu('revoked_reason', [
        'logout',
        'password_reset',
        'user_deactivated',
        'admin_revoked',
        'superseded',
      ])
      .nullable()
      .comment('Why this session was revoked. NULL while active. "superseded" is refresh-token rotation replacing this row with a fresh one.');

    table
      .string('device_label', 255)
      .nullable()
      .comment('Human label for the session list, e.g. "Front desk terminal 2". Never load-bearing for authorization — SECURITY.md §1.1: the audit trail records the actual user, never "the terminal".');

    table
      .string('ip', IP_LENGTH)
      .nullable()
      .comment('Origin IP, for the session list and abuse investigation. Nullable: a proxy misconfiguration must not be able to block a login.');

    timestamps(knex, table);

    // The lookup that authenticates a refresh. Global rather than per-tenant —
    // see the file header. This is also the constraint that makes token
    // rotation safe: reissuing a digest that already exists fails loudly
    // instead of quietly attaching one hash to two sessions.
    table.unique(['refresh_token_hash'], { indexName: 'sessions_refresh_token_hash_unique' });

    tenantScopedUserForeignKey(table, 'sessions_tenant_id_user_id_foreign');

    // "Revoke every session for this user" — the dismissal and password-reset
    // path (AUTH-8), and the hot query on this table after the refresh lookup.
    table.index(['tenant_id', 'user_id'], 'sessions_tenant_id_user_id_index');

    // The purge sweep for rows past expiry. Deliberately NOT led by tenant_id:
    // the job that drains expired sessions is platform-wide housekeeping over a
    // table of spent credentials, not a tenant-scoped read of tenant data.
    table.index(['expires_at'], 'sessions_expires_at_index');
  });

  // ---------------------------------------------------------------------
  // password_resets — TENANT_SCOPED. Single-use, time-limited.
  // ---------------------------------------------------------------------
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

    // Single-use (AUTH-7) is enforced by claiming the row with a conditional
    // update — UPDATE ... SET used_at = NOW() WHERE id = ? AND used_at IS NULL,
    // then checking the affected-row count — not by SELECTing used_at and then
    // writing. ARCHITECTURE.md §5: reading and then writing in separate
    // unlocked steps is the anti-pattern, and "add another check" never fixes
    // it. Two simultaneous submissions of the same link must see exactly one
    // affected row between them.
    table
      .datetime('used_at')
      .nullable()
      .comment('Set by the conditional UPDATE that claims this token. NULL means unspent; a second use finds zero affected rows and is rejected (AUTH-7).');

    timestamps(knex, table);

    table.unique(['token_hash'], { indexName: 'password_resets_token_hash_unique' });

    tenantScopedUserForeignKey(table, 'password_resets_tenant_id_user_id_foreign');

    // Outstanding resets for a user: needed to invalidate the rest once one is
    // spent, and to rate-limit repeat requests for the same account.
    table.index(['tenant_id', 'user_id'], 'password_resets_tenant_id_user_id_index');
    table.index(['expires_at'], 'password_resets_expires_at_index');
  });

  // ---------------------------------------------------------------------
  // mfa_devices — TENANT_SCOPED. Enrolled second factors.
  // ---------------------------------------------------------------------
  //
  // This table supersedes `users.mfa_secret`, which the identity migration
  // created before there was anywhere better to put a seed. Keeping both as
  // writable stores would be two sources of truth for the same secret — the
  // failure mode being an MFA challenge that verifies against the stale one.
  // `users.mfa_enabled` stays and keeps its job: a cheap flag the login path
  // reads to decide whether to issue a challenge at all (AUTH-9), without
  // touching secrets. `users.mfa_secret` is re-labelled DEPRECATED at the end
  // of this migration and dropped in a follow-up release.
  await knex.schema.createTable('mfa_devices', (table) => {
    table.comment(
      'Enrolled second factors. Scope: TENANT_SCOPED. Authoritative store for MFA secrets, superseding users.mfa_secret. MFA is mandatory for admin and super_admin (PRODUCT_REQUIREMENTS.md §3.16) and that requirement is enforced against the role held at a property, not a column here.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();

    // Enum, not a free string, and the opposite call from `permissions.domain`
    // in the identity migration: a new permission domain is a seed row, but a
    // new factor type is a new verification code path, so it cannot arrive
    // without a deploy. The schema should say so.
    table
      .enu('type', ['totp', 'sms'])
      .notNullable()
      .comment('The verification path this device uses. A new type is a code change, hence an enum rather than a string.');

    table
      .string('secret', 255)
      .notNullable()
      .comment('Encrypted at rest (SECURITY.md §1.1) — ciphertext, never a bare TOTP seed or a phone number in the clear. 255 leaves room for the envelope an encrypted value carries (key id, nonce), which a raw seed does not need.');

    // The gate that makes enrolment two-phase. A device is created when
    // enrolment starts and only becomes usable once the user has proved they
    // can generate a code from it; an unconfirmed row must never satisfy a
    // challenge, or "enrol MFA" would lock a user out of their own account.
    table
      .datetime('confirmed_at')
      .nullable()
      .comment('NULL until the user has proved possession by submitting a valid code. An unconfirmed device must not satisfy an MFA challenge.');

    timestamps(knex, table);

    // One device per type per user.
    //
    // Not from DATABASE.md §2's list — §2's own instruction is that a table
    // whose entity should be unique per tenant gets its constraint in the
    // migration that creates it, and "this user's TOTP device" is one such
    // entity: two confirmed TOTP secrets for one account means an MFA challenge
    // has two right answers, and revoking a lost phone silently leaves the
    // other valid.
    //
    // The cost is deliberate and accepted: replacing a device is remove-then-
    // enrol rather than enrol-then-remove, so there is a brief window with the
    // factor absent. That window is guarded the same way disabling MFA is — the
    // action is re-authenticated and written to auth_events — which is a better
    // trade than a schema that cannot tell which of two secrets is current.
    table.unique(['tenant_id', 'user_id', 'type'], {
      indexName: 'mfa_devices_tenant_id_user_id_type_unique',
    });

    tenantScopedUserForeignKey(table, 'mfa_devices_tenant_id_user_id_foreign');

    // Note there is intentionally no index on (tenant_id, user_id) of its own:
    // the unique above already leads with exactly that prefix, so a second
    // index would be dead weight InnoDB still has to maintain on every write.
  });

  // ---------------------------------------------------------------------
  // user_invitations — PROPERTY_SCOPED. Invitee sets their own password.
  // ---------------------------------------------------------------------
  //
  // TWO DELIBERATE ADDITIONS TO DATABASE.md §1's COLUMN LIST.
  //
  // `property_id`, which also makes this table PROPERTY_SCOPED rather than
  // TENANT_SCOPED. §1 lists the invitation as carrying `role` and no property,
  // but SECURITY.md §4 is explicit that a role is never global — a role exists
  // only as one held at a property, and accepting an invitation has to write a
  // `user_property_access(tenant_id, property_id, user_id, role)` row. Without a
  // property on the invitation, that property_id has to come from somewhere at
  // acceptance time, and the only party present is the invitee: the schema would
  // be asking the person being granted access to choose their own scope. Naming
  // the property when the invitation is issued keeps the grant entirely in the
  // hands of the admin who issued it. Inviting someone to several properties is
  // several invitations, which also keeps one invitation link to one grant.
  //
  // `invited_by_user_id`, because SECURITY.md §1.1 requires admin actions —
  // "user role changes, permission grants" — to be audited to the same standard
  // as guest-facing changes, and creating a staff account at a property is the
  // most consequential of those. auth_events records that an invitation was
  // sent; this column keeps the answer attached to the grant itself, so it
  // survives independently of event retention.
  await knex.schema.createTable('user_invitations', (table) => {
    table.comment(
      // No apostrophes in a table comment: knex parameterizes column comments
      // but interpolates table comments straight into the DDL, so one would
      // terminate the string and break the migration.
      'Pending staff invitations. Scope: PROPERTY_SCOPED — an invitation grants a role AT a property (SECURITY.md §4). The invitee sets their own password: an admin never sets a password on behalf of another person, because that destroys attributability (PRODUCT_REQUIREMENTS.md §3.16).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table
      .string('email', 255)
      .notNullable()
      .comment('Where the invitation was sent. Deliberately NOT unique per tenant — see the note on re-invitation below.');

    // Same shape and the same reasoning as user_property_access.role: a code
    // bound to roles(tenant_id, code) by a composite foreign key, so an
    // invitation cannot grant a role that this tenant does not define, nor one
    // borrowed from another tenant.
    table
      .string('role', 50)
      .notNullable()
      .comment('Role code to grant at this property on acceptance, from roles.code.');

    table
      .string('token_hash', TOKEN_HASH_LENGTH)
      .notNullable()
      .comment('SHA-256 hex digest of the emailed invitation token.');

    table.datetime('expires_at').notNullable();

    table
      .datetime('accepted_at')
      .nullable()
      .comment('Claimed by the same conditional-UPDATE pattern as password_resets.used_at: an invitation link is single-use, so two simultaneous acceptances must not both create a user.');

    table.bigInteger('invited_by_user_id').unsigned().notNullable();

    timestamps(knex, table);

    table.unique(['token_hash'], { indexName: 'user_invitations_token_hash_unique' });

    // There is deliberately NO unique on (tenant_id, email) or
    // (tenant_id, property_id, email). An address that was invited and never
    // accepted must be invitable again once the first link expires, and MySQL
    // has no partial index to restrict uniqueness to rows still pending. "Only
    // one live invitation per address per property" is therefore an application
    // rule enforced by superseding the outstanding row when a new invitation is
    // issued — not a constraint that would permanently burn an email address on
    // the first typo.

    table
      .foreign(['tenant_id', 'property_id'], 'user_invitations_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'role'], 'user_invitations_tenant_id_role_foreign')
      .references(['tenant_id', 'code'])
      .inTable('roles')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(
        ['tenant_id', 'invited_by_user_id'],
        'user_invitations_tenant_id_invited_by_user_id_foreign'
      )
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // "Outstanding invitations for this address", which is what the application
    // rule above is checked against, and what an admin's invitation list shows.
    table.index(['tenant_id', 'email'], 'user_invitations_tenant_id_email_index');
    table.index(['expires_at'], 'user_invitations_expires_at_index');
  });

  // Last, and separate from the table creations: re-label the column
  // `mfa_devices` supersedes. Comment-only, so it is metadata in MySQL 8 and
  // safe against a populated table.
  await setMfaSecretComment(knex, MFA_SECRET_COMMENT_NOW);
};

exports.down = async function down(knex) {
  // Restore the comment first, so a failure below leaves the schema describing
  // itself accurately rather than pointing at a table that no longer exists.
  await setMfaSecretComment(knex, MFA_SECRET_COMMENT_BEFORE);

  // Nothing references these four, so the order is not forced — but it mirrors
  // the creation order reversed, as the earlier migrations do.
  await knex.schema.dropTableIfExists('user_invitations');
  await knex.schema.dropTableIfExists('mfa_devices');
  await knex.schema.dropTableIfExists('password_resets');
  await knex.schema.dropTableIfExists('sessions');
};
