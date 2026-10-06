'use strict';

/**
 * Adds three `auth_events.event_type` values for the manager approval PIN
 * (`src/modules/approvals`): a PIN set or changed, a wrong PIN at the till,
 * and a PIN locked after 5 wrong attempts in 15 minutes. Same additive
 * `MODIFY COLUMN` shape as 20261027092000 (knex has no enum-alter helper);
 * the list below is that migration's NEW list, which is the live one.
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
  'password_reset_code_failed',
];

const NEW_EVENT_TYPES = [...ORIGINAL_EVENT_TYPES, 'approval_pin_set', 'approval_pin_failed', 'approval_pin_locked'];

function enumSql(values) {
  return values.map((v) => `'${v}'`).join(', ');
}

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE auth_events MODIFY COLUMN event_type ENUM(${enumSql(NEW_EVENT_TYPES)}) NOT NULL`);
};

exports.down = async function down(knex) {
  // Refuse rather than silently fail on rows MySQL could not represent.
  const [rows] = await knex.raw(
    "SELECT COUNT(*) AS n FROM auth_events WHERE event_type IN ('approval_pin_set', 'approval_pin_failed', 'approval_pin_locked')"
  );
  if (Number(rows[0].n) > 0) {
    throw new Error('Cannot roll back: auth_events already holds approval PIN events.');
  }
  await knex.raw(`ALTER TABLE auth_events MODIFY COLUMN event_type ENUM(${enumSql(ORIGINAL_EVENT_TYPES)}) NOT NULL`);
};
