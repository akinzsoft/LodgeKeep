'use strict';

/**
 * Self-service "My Profile" screen (user-requested) — a staff member
 * changing their own password (while logged in, distinct from the
 * forgot-password reset flow) revokes every OTHER active session for that
 * user, deliberately sparing the one behind the request itself (confirmed
 * with the user: the device making the change stays signed in). None of
 * `sessions.revoked_reason`'s existing values fit this — `'password_reset'`
 * means the *forgot-password* flow specifically, which revokes ALL
 * sessions unconditionally, a materially different code path per that
 * column's own original comment ("each value corresponds to a code path,
 * so a new one is a code change"). `'admin_revoked'` was considered and
 * rejected — this is a self-driven action, not an admin one, and reusing
 * it would misattribute the reason in any future support investigation.
 *
 * A raw `MODIFY COLUMN`, not knex's schema builder — MySQL ENUM widening
 * has no schema-builder equivalent in this codebase (same pattern
 * `20260910094000_add_invitation_accepted_auth_event.js`/
 * `20260911090000_add_registration_auth_event.js` already established for
 * `auth_events.event_type`). The column's own `.comment(...)` is restated
 * verbatim — a bare `MODIFY COLUMN` silently drops any comment not
 * repeated in the new definition.
 */

const ORIGINAL_REASONS = ['logout', 'password_reset', 'user_deactivated', 'admin_revoked', 'superseded'];
const NEW_REASONS = [...ORIGINAL_REASONS, 'password_changed'];
const COMMENT = 'Why this session was revoked. NULL while active. "superseded" is refresh-token rotation replacing this row with a fresh one.';

function enumSql(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE sessions MODIFY COLUMN revoked_reason ENUM(${enumSql(NEW_REASONS)}) NULL COMMENT '${COMMENT}'`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE sessions MODIFY COLUMN revoked_reason ENUM(${enumSql(ORIGINAL_REASONS)}) NULL COMMENT '${COMMENT}'`);
};
