'use strict';

/**
 * Gap closure (flagged in CLAUDE.md's own Phase 4 section, built via
 * feature-dev): guest password-reset. `guest_password_resets` (the next
 * migration) is the first PROPERTY_SCOPED table to reference `guest_accounts`
 * — itself PROPERTY_SCOPED — so `guest_accounts` needs the same 3-column
 * composite parent key `room_types`/`rate_codes` (Phase 1) and `folios`
 * (`20260909090000_alter_folios_for_cashiering.js`) each added the first
 * time something referenced them back: a straight `(tenant_id, id)` key
 * would let a reset token pair one property's guest with another property's
 * id in the same tenant, leaving the property check to application code.
 *
 * `password_changed_at` is this pass's session-invalidation mechanism.
 * Staff password-reset revokes rows in `sessions` (a real, revocable
 * refresh-token table) — no such table exists for guests at all (guest
 * access tokens are short-lived, 15-minute, stateless JWTs with no refresh
 * path, `src/auth/tokens.js`'s own header). The stateless-JWT equivalent of
 * "revoke every existing session" is: reject any token issued before the
 * moment the password last changed. `authenticate('guest')`'s live
 * per-request re-check (`src/auth/middleware.js`) compares this column
 * against the token's own `iat` claim — a stolen or cached pre-reset token
 * stops working on its very next use, the same guarantee AUTH-8 requires
 * for staff, via a different mechanism suited to a session-less audience.
 * NULL means no reset has ever happened, so nothing needs invalidating on
 * this basis yet.
 *
 * MILLISECOND PRECISION IS LOAD-BEARING, NOT COSMETIC. A plain `DATETIME`
 * (MySQL's default, 0 fractional digits) truncates to whole seconds — and
 * a JWT `iat` claim is already only second-granular by the JWT spec itself
 * (`jwt.sign` sets it to `Math.floor(Date.now() / 1000)`). If BOTH sides of
 * the comparison were truncated to the same second, a login and a reset
 * landing in that same wall-clock second (routine for two sequential HTTP
 * calls in a fast test, or a fast real client) would make
 * `iat * 1000 < password_changed_at` false even though the reset genuinely
 * happened after the login — silently failing to invalidate the very
 * token this column exists to invalidate. `DATETIME(3)` keeps
 * `password_changed_at` at real millisecond precision, so the comparison
 * is always correct: `iat`'s floor is always <= the real login instant,
 * which is always < the real (millisecond-precise) reset instant,
 * independent of which whole second either falls in. Caught by this
 * pass's own test suite going genuinely flaky under load before this fix
 * — not a hypothetical.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('guest_accounts', (table) => {
    table
      .datetime('password_changed_at', { precision: 3 })
      .nullable()
      .comment(
        'Set only when a password changes after account creation (a completed reset). Compared against a guest access token\'s own iat claim by authenticate("guest") on every request — a token issued before this timestamp is rejected. The stateless-JWT equivalent of sessions.revoked_at for staff; no guest_sessions table exists to hold a revocable row. Millisecond precision (DATETIME(3)) is load-bearing — see this migration\'s own header.'
      );

    table.unique(['tenant_id', 'property_id', 'id'], {
      indexName: 'guest_accounts_tenant_id_property_id_id_unique',
    });
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('guest_accounts', (table) => {
    table.dropUnique(['tenant_id', 'property_id', 'id'], 'guest_accounts_tenant_id_property_id_id_unique');
    table.dropColumn('password_changed_at');
  });
};
