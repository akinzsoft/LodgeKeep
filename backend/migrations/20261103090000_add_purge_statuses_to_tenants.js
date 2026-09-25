'use strict';

/**
 * Adds `purging` and `purged` to `tenants.status` — the tenant retention-expiry
 * purge (security audit finding: "Offboarding sets retention_expires_at but
 * nothing acts on it").
 *
 *   offboarding -> purging -> purged
 *
 * Both new states are ONE-WAY DOORS. `purging` is the irreversible claim
 * (`src/modules/offboarding/purge.js`): access is cut immediately and the
 * deletion resumes across sweep ticks until every tenant-owned row is gone.
 * `purged` is the tombstone that remains once it is — the `tenants` row is kept
 * so the slug stays reserved and Planmsys's own billing records keep their
 * parent. Neither is reachable from `reactivateTenant`.
 *
 * A plain `knex.schema` call cannot widen a MySQL ENUM in place, so this is a
 * raw `MODIFY COLUMN` (the `20260910094000` precedent) — additive only: every
 * existing value stays, so it is backwards-compatible per DATABASE.md's
 * migration rule.
 *
 * `down` reverts to the four-value enum and WILL FAIL if any row is `purging` or
 * `purged`. That is correct: a purge cannot be rolled back, and a schema that
 * silently coerced a purged tenant back to some other status would be lying.
 */

const ORIGINAL = ['trial', 'active', 'suspended', 'offboarding'];
const WIDENED = [...ORIGINAL, 'purging', 'purged'];
const COMMENT = 'Trial expiry degrades to read-only, never a hard lockout on a system holding live reservations (PLAN.md Phase 5). purging/purged are one-way: see the retention purge.';
const ORIGINAL_COMMENT = 'Trial expiry degrades to read-only, never a hard lockout on a system holding live reservations (PLAN.md Phase 5).';

const enumSql = (values) => values.map((v) => `'${v}'`).join(', ');

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE tenants MODIFY COLUMN status ENUM(${enumSql(WIDENED)}) NOT NULL DEFAULT 'trial' COMMENT '${COMMENT}'`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE tenants MODIFY COLUMN status ENUM(${enumSql(ORIGINAL)}) NOT NULL DEFAULT 'trial' COMMENT '${ORIGINAL_COMMENT}'`);
};
