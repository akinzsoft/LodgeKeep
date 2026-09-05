'use strict';

/**
 * Adds `invitation_accepted` to `auth_events.event_type`'s fixed ENUM —
 * PLAN.md Phase 1 gap closure (the staff invitation flow,
 * PRODUCT_REQUIREMENTS.md §3.16). That column's own migration
 * (20260904101500_create_auth_events.js) explains why it is an ENUM at all
 * ("that vocabulary is fixed and small — one row per module-owned business
 * action, in `audit_log`, would be the wrong home for it") and already
 * anticipated `user_deactivated` for exactly this kind of identity-lifecycle
 * event; `invitation_accepted` is the same category — a new login-capable
 * account coming into existence — that this earlier migration's own
 * enumeration simply didn't include yet.
 *
 * A plain `knex.schema` call cannot widen a MySQL ENUM in place, so this is
 * a raw `MODIFY COLUMN` — additive only (every existing value stays), which
 * keeps it backwards-compatible per DATABASE.md's migration rule. The
 * `down` reverses to the exact original list.
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
];

const NEW_EVENT_TYPES = [...ORIGINAL_EVENT_TYPES, 'invitation_accepted'];

function enumSql(values) {
  return values.map((v) => `'${v}'`).join(', ');
}

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE auth_events MODIFY COLUMN event_type ENUM(${enumSql(NEW_EVENT_TYPES)}) NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE auth_events MODIFY COLUMN event_type ENUM(${enumSql(ORIGINAL_EVENT_TYPES)}) NOT NULL`);
};
