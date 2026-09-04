'use strict';

/**
 * auth_events — DATABASE.md §5, TESTING.md AUTH-14, SECURITY.md §1.1.
 *
 * DATABASE.md §5 lists this table as "user_id, event_type, ip, user_agent,
 * occurred_at — logins, failures, lockouts, MFA, impersonation". It is the
 * durable record behind three separate requirements:
 *
 *   1. AUTH-14: "any auth event → row in auth_events". The auth-credentials
 *      migration leans on this: sessions, password_resets, mfa_devices and
 *      user_invitations are all hard-deletable *because* what happened to them
 *      is recorded here rather than in the credential row.
 *   2. PRODUCT_REQUIREMENTS.md §3.16: "all authentication events are audited —
 *      successful logins, failures, lockouts, password changes, MFA enrolment,
 *      impersonation start/end".
 *   3. The lockout counter behind AUTH-3 and AUTH-4. See below.
 *
 * ── SCOPE: PLATFORM_SCOPED, AND WHY THAT IS NOT A LOOPHOLE ────────────────
 *
 * Every other tenant-owned table in this schema is TENANT_SCOPED or
 * PROPERTY_SCOPED with a NOT NULL tenant_id. This one is PLATFORM_SCOPED, and
 * the reason is specific rather than convenient: the single most important event
 * to record is a login failure for an address that matches no account, and that
 * event has no tenant to resolve. A NOT NULL tenant_id would force the auth
 * module to either discard exactly the rows the lockout counter needs, or invent
 * a sentinel tenant — and a sentinel tenant is a cross-tenant bug waiting for
 * someone to join through it.
 *
 * The table also spans all three identity populations (API.md §4): a staff
 * login, a guest portal login and a platform-console login are the same kind of
 * event and belong in one place, and only one of those three has a tenant at
 * all.
 *
 * So `tenant_id` and `property_id` are present but **nullable, and they are
 * attribution rather than scope**. `src/shared/table-scopes.js` records that
 * distinction explicitly (`attributionColumns`) so it is a declared exception
 * the isolation suite tests, not an undocumented one it happens to tolerate —
 * `tests/isolation/entity-scope.test.js` asserts that every column named there
 * really is nullable, which is what stops the field being used to smuggle a
 * genuine scope column past the scope check.
 *
 * The practical consequence, stated plainly: this table has no tenant-scoped
 * read path today. Only `src/auth` writes it, and nothing reads it but the
 * lockout counter. A tenant-facing "recent sign-in activity" screen needs a
 * dedicated, reviewed service function that filters `tenant_id` explicitly, and
 * that function does not exist yet — the screen is not in Phase 0 (PLAN.md).
 *
 * ── LOCKOUT IS COUNTED FROM THIS TABLE, NOT FROM REDIS ────────────────────
 *
 * The `users` migration says lockout counters live in Redis, following
 * ARCHITECTURE.md §15. That conflated two controls that this migration
 * separates, because they have different durability requirements and API.md §3
 * already gives them different status codes:
 *
 *   423 LOCKED_ACCOUNT   Account lockout. Security state. Counted from the rows
 *                        in this table, so it survives a deploy, a Redis
 *                        restart, and a second backend instance. ARCHITECTURE.md
 *                        §14 is explicit that Redis is never a source of truth;
 *                        a lockout that evaporates when Redis restarts is
 *                        exactly the case that rule is written for.
 *
 *   429 RATE_LIMITED     Rate limiting. Traffic shaping. `express-rate-limit`
 *                        with `rate-limit-redis` (§15), added when Redis is
 *                        wired up. Losing those counters degrades a limit;
 *                        losing a lockout unlocks an account under attack.
 *
 * Both dimensions of the lockout are read from here, and they are deliberately
 * different shapes (SECURITY.md §1.1, ARCHITECTURE.md §15):
 *
 *   per-account   tight. N failures against one user_id locks that account.
 *   per-IP        loose. A shared front-desk terminal legitimately produces many
 *                  failures across many accounts, so the per-IP ceiling is a
 *                  backstop against credential stuffing, not the primary lock.
 *                  AUTH-4 is the test that this stays true.
 *
 * ── APPEND-ONLY ───────────────────────────────────────────────────────────
 *
 * No `status` column, no `updated_at`, and no update path: a row here is a
 * statement that something happened at a moment, and nothing that happened later
 * changes it. `created_at`/`updated_at` are omitted for the same reason — they
 * would restate `occurred_at` and imply an edit history this table does not
 * have. Deletion is retention housekeeping over `occurred_at`, not a business
 * operation.
 *
 * Reference: DATABASE.md §5; SECURITY.md §1.1, §6; ARCHITECTURE.md §3, §10,
 * §14–15; API.md §3–4; PRODUCT_REQUIREMENTS.md §3.16; TESTING.md AUTH-3, AUTH-4,
 * AUTH-14.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

/** IPv6 worst case, `::ffff:255.255.255.255` — same width as `sessions.ip`. */
const IP_LENGTH = 45;

/**
 * Every event this system can record.
 *
 * An enum rather than free text, following `sessions.revoked_reason`: each value
 * corresponds to a code path, so adding one is a migration and a code change
 * together rather than a string that quietly appears in production logs. The
 * five categories DATABASE.md §5 names — logins, failures, lockouts, MFA,
 * impersonation — are all here; `impersonation_*` is written by Phase 5's
 * `impersonation_sessions` work (SECURITY.md §2) and has no writer yet.
 */
const EVENT_TYPES = [
  'login_success',
  'login_failure',
  'logout',
  'lockout',
  'token_refreshed',
  'token_refresh_rejected',
  'password_reset_requested',
  'password_reset_completed',
  'password_changed',
  'mfa_challenge_issued',
  'mfa_verified',
  'mfa_failed',
  'mfa_enrolled',
  'session_revoked',
  'user_deactivated',
  'impersonation_started',
  'impersonation_ended',
];

/**
 * Why an attempt failed — server-side only.
 *
 * AUTH-2 requires the *response* to be identical for a wrong password and an
 * unknown email, so that a caller cannot enumerate accounts. That is a rule
 * about what leaves the server. The distinction still has to be recorded, or an
 * administrator investigating a real incident cannot tell a typo from an attack.
 * Keeping the two apart — one generic message out, the true reason in this
 * column — is the whole point of the split.
 */
const FAILURE_REASONS = [
  'unknown_email',
  'invalid_password',
  'user_inactive',
  'tenant_inactive',
  'account_locked',
  'ip_locked',
  'token_expired',
  'token_revoked',
  'token_unknown',
  'token_already_used',
  'wrong_audience',
  'mfa_required',
  'mfa_invalid_code',
  'no_property_access',
];

exports.up = async function up(knex) {
  // ---------------------------------------------------------------------
  // guest_accounts gains UNIQUE(tenant_id, id).
  // ---------------------------------------------------------------------
  //
  // Not a change to what the table stores — `id` is already unique, so this
  // constraint rejects nothing that was previously accepted, which is what makes
  // it a safe additive migration (DATABASE.md: backwards-compatible, reversible).
  //
  // It exists to be a *parent key*. `users`, `roles` and `properties` each got a
  // UNIQUE(tenant_id, id) in an earlier migration for the same reason: a child
  // row referencing them through (tenant_id, parent_id) cannot pair one tenant's
  // id with another tenant's parent. `auth_events.guest_account_id` is the first
  // column anywhere to point at `guest_accounts`, so the parent key is needed
  // now.
  await knex.schema.alterTable('guest_accounts', (table) => {
    table.unique(['tenant_id', 'id'], { indexName: 'guest_accounts_tenant_id_id_unique' });
  });

  await knex.schema.createTable('auth_events', (table) => {
    table.comment(
      'Append-only authentication audit log across all three identity populations. Scope: PLATFORM_SCOPED — tenant_id is nullable attribution, not scope, because a login failure for an unknown address has no tenant to resolve. Also the source of the account-lockout counter (TESTING.md AUTH-3, AUTH-4, AUTH-14).'
    );

    table.bigIncrements('id');

    table
      .datetime('occurred_at')
      .notNullable()
      .defaultTo(knex.fn.now())
      .comment('When the event happened. Wall clock, deliberately NOT a business date: authentication is not a posted transaction and does not belong to a property accounting day (ARCHITECTURE.md §6).');

    table
      .enu('audience', ['staff', 'guest', 'platform'])
      .notNullable()
      .comment('Which identity population this event belongs to (API.md §4). Recorded even on failure, because "a guest token was presented to a PMS route" is itself the event worth seeing (TESTING.md AUTH-12).');

    table.enu('event_type', EVENT_TYPES).notNullable();

    table
      .enu('failure_reason', FAILURE_REASONS)
      .nullable()
      .comment('NULL on success. The true reason, which is never the reason returned to the caller — AUTH-2 requires one generic message for both a wrong password and an unknown email.');

    // ---- Attribution. All nullable; see the scope note in the file header. ----

    table
      .bigInteger('tenant_id')
      .unsigned()
      .nullable()
      .comment('NULL when no tenant resolved — an unknown email, or a platform-console event. Attribution, not scope.');

    table
      .bigInteger('property_id')
      .unsigned()
      .nullable()
      .comment('NULL for staff events: a staff login is tenant-wide and the active property is chosen afterwards (SECURITY.md §3). Populated for guest events, since the portal is a specific property’s front door.');

    table
      .bigInteger('user_id')
      .unsigned()
      .nullable()
      .comment('The staff account, once resolved. NULL for an unknown email, and for guest and platform events.');

    table.bigInteger('guest_account_id').unsigned().nullable();
    table.bigInteger('platform_user_id').unsigned().nullable();

    table
      .string('email_attempted', 255)
      .nullable()
      .comment('The address as typed, kept even when it resolves to nothing — otherwise a failed-login investigation has no subject at all. Never accompanied by the password that was tried, in any column or log line (SECURITY.md §1.1, TESTING.md AUTH-11).');

    table
      .string('ip', IP_LENGTH)
      .nullable()
      .comment('Origin IP — the second lockout dimension. Nullable: a proxy misconfiguration must degrade the per-IP backstop, never block a login outright.');

    table.string('user_agent', 512).nullable();

    table
      .string('request_id', 64)
      .nullable()
      .comment('Correlates to the request_id returned in the API.md §2 error envelope and to the matching audit_log row (SECURITY.md §6) — the three must share one identifier or an incident cannot be traced across them.');

    // ---- Foreign keys. RESTRICT throughout, as everywhere else. ----
    //
    // MySQL evaluates a composite foreign key only when every column in it is
    // non-NULL. That is precisely the behaviour this table needs: an event with
    // no resolved tenant is unconstrained, while an event that names both a
    // tenant and a user is held to the pair existing together.

    table
      .foreign('tenant_id', 'auth_events_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id'], 'auth_events_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The generic rule asserted in tests/isolation/entity-scope.test.js: any
    // table carrying user_id reaches `users` through (tenant_id, user_id),
    // never a bare user_id.
    table
      .foreign(['tenant_id', 'user_id'], 'auth_events_tenant_id_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'guest_account_id'], 'auth_events_tenant_id_guest_account_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('guest_accounts')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // No tenant to close over: platform_users is PLATFORM_SCOPED.
    table
      .foreign('platform_user_id', 'auth_events_platform_user_id_foreign')
      .references('id')
      .inTable('platform_users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // ---- Indexes. Each one is a query this system actually runs. ----

    // Tenant-scoped reads, and the supporting index for the users foreign key.
    table.index(['tenant_id', 'user_id', 'occurred_at'], 'auth_events_tenant_id_user_id_occurred_at_index');

    // The per-account lockout count. Led by user_id rather than tenant_id
    // because the question is "how many times has this account failed lately",
    // and user_id already implies its tenant.
    table.index(['user_id', 'event_type', 'occurred_at'], 'auth_events_user_id_event_type_occurred_at_index');

    // The per-IP lockout count — the dimension that has to work when no account
    // resolved at all, which is the case an attacker producing these rows is in.
    table.index(['ip', 'event_type', 'occurred_at'], 'auth_events_ip_event_type_occurred_at_index');

    // Retention housekeeping. Deliberately not led by tenant_id: the sweep that
    // drops events past their retention window is platform-wide, like the
    // expired-session purge in the previous migration.
    table.index(['occurred_at'], 'auth_events_occurred_at_index');

    // The property and guest foreign keys get InnoDB's automatic supporting
    // index rather than a declared one — neither is on a hot path, and an index
    // this table does not query is a write cost on every login.
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('auth_events');

  // Dropped after the table, since auth_events' guest foreign key depends on it.
  await knex.schema.alterTable('guest_accounts', (table) => {
    table.dropUnique(['tenant_id', 'id'], 'guest_accounts_tenant_id_id_unique');
  });
};
