'use strict';

/**
 * Platform console health — pure helpers, PLAN.md Phase 5 ("Platform
 * console — tenant list, health"), PRODUCT_REQUIREMENTS.md §3.22's own UI
 * spec ("Tenant list — status, plan, property/room count, signup date,
 * last activity" / "Tenant detail — subscription state, billing history").
 *
 * Kept separate from service.js's query-orchestration code so each piece is
 * directly unit-testable with no database, mirroring billing/dunning.js's
 * own "pure and directly tested" shape.
 *
 * Deliberately out of scope, confirmed with the user before building: the
 * separate aggregate "Platform Health" screen (signups-over-time, churn,
 * failed-payment counts, aggregate usage across all tenants) — nothing in
 * this codebase ever transitions a subscription to `canceled` today, so
 * churn has no real data behind it yet. Room count (only property count —
 * reaching `rooms`, a PROPERTY_SCOPED operational table, would cut against
 * this console's own "never a back door into tenant data" rule). A
 * computed "at risk" badge — every field service.js attaches is a stored
 * fact or a documented-precedent resolution (the plan fallback below, the
 * trial arithmetic here), never a threshold-based judgment.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Null when the tenant isn't currently on trial, or is on trial but has no
 * `trial_ends_at` set (`tenant-lifecycle.js`'s own "no expiry set — usable
 * indefinitely" case — there is no meaningful "remaining" figure for that).
 * Otherwise the integer number of days until expiry, ceil'd: a trial
 * ending in 3 hours reads as 1, not 0 or a fractional day — any real time
 * still left in the current day counts as a day remaining, rounding up
 * rather than truncating. A lapsed trial not yet swept by the background
 * job reads as a genuine negative integer — a raw fact, never clamped to
 * 0, per this pass's own confirmed "raw facts, no computed judgment"
 * scope. The UI decides how to word a negative value.
 *
 * @param {{status: string, trial_ends_at: (string|Date|null)}} tenant
 * @param {Date} [now]
 * @returns {number|null}
 */
function trialDaysRemaining(tenant, now = new Date()) {
  if (tenant.status !== 'trial' || !tenant.trial_ends_at) return null;
  return Math.ceil((new Date(tenant.trial_ends_at).getTime() - now.getTime()) / DAY_MS);
}

/**
 * Resolves which plan actually governs a tenant right now — mirrors
 * `billing/service.js`'s `resolvePlanFor` specifically (not
 * `src/shared/entitlements.js`'s `resolveActivePlanId`, which returns a
 * set `plan_id` verbatim with no existence check): a `plan_id` referencing
 * a row no longer in the catalogue falls back to the default active plan
 * here, the identical `resolvePlanFor` behaviour, rather than surfacing a
 * dangling id the way `resolveActivePlanId` would. Duplicated rather than
 * imported — the same precedented divergence `entitlements.js`'s own
 * header documents for this identical one-line query: no
 * `platform -> billing` dependency direction exists in this codebase's
 * module layering to reuse it directly for a single read-only display.
 * Currently untriggerable either way (no `plans` delete/deactivate
 * endpoint exists yet, so no dangling `plan_id` can occur today) — flagged
 * as a real, if dormant, divergence should that gap ever close: this
 * console would then show a resolved fallback plan for a tenant whose
 * real entitlement check (`hasEntitlement`) fails closed against the same
 * dangling id.
 *
 * @param {object[]} plans   Every row from `plans` (small catalogue, fetched once per roster/detail call).
 * @param {{plan_id: (string|number|null)}} tenant
 * @returns {object|null}    The plan row, or null if none resolves (an empty/misconfigured catalogue).
 */
function resolvePlanForRoster(plans, tenant) {
  if (tenant.plan_id) {
    const explicit = plans.find((plan) => String(plan.id) === String(tenant.plan_id));
    if (explicit) return explicit;
  }
  return plans.find((plan) => plan.is_active) ?? null;
}

module.exports = { trialDaysRemaining, resolvePlanForRoster };
