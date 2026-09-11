'use strict';

/**
 * Tenant offboarding — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22
 * ("Offboarding must include a full data export... define a retention
 * window before deletion, and honour it").
 *
 * `tenants.status` has carried an `offboarding` enum value since the very
 * first tenancy migration, but nothing has ever transitioned into it —
 * confirmed by reading every caller of `tenants.status` before starting
 * this pass, the same discipline the self-service-signup pass applied to
 * `trial`. This migration adds the two columns the real transition needs;
 * a later migration in this same pass adds the permission and the
 * `tenant_data_exports` table.
 *
 * `offboarding_requested_at` mirrors `trial_ends_at`'s own precedent — a
 * status-transition-relevant date living directly on `tenants`, not
 * derived from a side table, since "when did this tenant ask to leave" is
 * a fact about the TENANT itself, independent of how many export attempts
 * follow.
 *
 * `retention_expires_at` is computed ONCE, at request time, and stored —
 * deliberately not derived on every read as `offboarding_requested_at +
 * N days`. If the retention-window CONSTANT itself is ever changed later,
 * an already-requested tenant keeps the exact date it was originally
 * told, which is the only legally honest behaviour: you cannot retroactively
 * move someone's data-deletion-eligibility date because a policy changed
 * after they asked to leave. Confirmed with the user: 30 days from the
 * request (`src/modules/offboarding/service.js`'s own
 * `RETENTION_WINDOW_DAYS`) — long enough to cover a tenant re-downloading
 * their export, a billing dispute, or a platform admin reversing an
 * accidental request, without holding a departing customer's data
 * indefinitely. This pass stores the date; the actual purge job that acts
 * on it is explicitly out of scope (PLAN.md Phase 5's own next piece).
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('tenants', (table) => {
    table.datetime('offboarding_requested_at').nullable();
    table.datetime('retention_expires_at').nullable().comment('Purge-eligible date for a future pass — this migration only stores it, nothing reads it yet.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('tenants', (table) => {
    table.dropColumn('offboarding_requested_at');
    table.dropColumn('retention_expires_at');
  });
};
