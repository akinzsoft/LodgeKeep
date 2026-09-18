'use strict';

/**
 * Adds `password_reset_code_failed` to `auth_events.event_type`'s fixed
 * ENUM — gap closure (user-reported): the forgot-password flow now checks a
 * real emailed 6-digit code (`password_reset_codes`,
 * `completePasswordResetWithCode`, `src/auth/service.js`), reusing
 * `mfa_failed`'s own shape rather than the old link-based flow's
 * shared-event-plus-`failure_reason` shape: a wrong/expired/already-used/
 * attempts-exhausted CODE writes this one dedicated event, with no
 * `failure_reason` breakdown (the specific cause stays server-internal — a
 * caller learns only "this code did not work", matching
 * `PasswordResetCodeInvalidError`'s own doc comment). A garbage/expired/
 * wrong-audience reset TOKEN (the correlation JWT itself) still reuses the
 * existing `password_reset_completed`/`AUTH_TOKEN_INVALID` path with no
 * audit write for that branch — mirroring `verifyStaffMfa`'s identical
 * split between a bad challenge token (no dedicated event) and a bad code
 * (`mfa_failed`). Same additive `MODIFY COLUMN` shape as
 * 20260910094000/20260911090000; knex has no enum-alter helper, and MySQL
 * enums can't be widened any other way.
 */

const ORIGINAL_EVENT_TYPES = [
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
  'invitation_accepted',
  'registration',
];

const NEW_EVENT_TYPES = [...ORIGINAL_EVENT_TYPES, 'password_reset_code_failed'];

function enumSql(values) {
  return values.map((v) => `'${v}'`).join(', ');
}

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE auth_events MODIFY COLUMN event_type ENUM(${enumSql(NEW_EVENT_TYPES)}) NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE auth_events MODIFY COLUMN event_type ENUM(${enumSql(ORIGINAL_EVENT_TYPES)}) NOT NULL`);
};
