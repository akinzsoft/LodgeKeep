'use strict';

/**
 * Adds `registration` to `auth_events.event_type`'s fixed ENUM — PLAN.md
 * Phase 4 (the guest booking portal, PRODUCT_REQUIREMENTS.md §3.14/§3.16).
 * A guest creating a `guest_accounts` row for the first time is the same
 * identity-lifecycle category `invitation_accepted` (this project's own
 * prior gap-closure migration, 20260910094000) already added for staff — "a
 * new login-capable account coming into existence" — just on the guest side
 * instead. Same additive `MODIFY COLUMN` shape; knex has no enum-alter
 * helper, and MySQL enums can't be widened any other way.
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
];

const NEW_EVENT_TYPES = [...ORIGINAL_EVENT_TYPES, 'registration'];

function enumSql(values) {
  return values.map((v) => `'${v}'`).join(', ');
}

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE auth_events MODIFY COLUMN event_type ENUM(${enumSql(NEW_EVENT_TYPES)}) NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE auth_events MODIFY COLUMN event_type ENUM(${enumSql(ORIGINAL_EVENT_TYPES)}) NOT NULL`);
};
