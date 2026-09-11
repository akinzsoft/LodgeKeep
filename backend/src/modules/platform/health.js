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
 * ending in 3 hours reads as 0 (not -1), and a lapsed trial not yet swept
 * by the background job reads as a genuine negative integer — a raw fact,
 * never clamped to 0, per this pass's own confirmed "raw facts, no
 * computed judgment" scope. The UI decides how to word a negative value.
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
 * `billing/service.js`'s `resolvePlanFor` / `src/shared/entitlements.js`'s
 * `resolveActivePlanId` null-`plan_id` fallback (first active plan,
 * ordered by id) exactly, duplicated rather than imported. The same
 * precedented divergence `entitlements.js`'s own header documents for this
 * identical one-line query: no `platform -> billing` (or
 * `platform -> shared/entitlements`) dependency direction exists in this
 * codebase's module layering to reuse either directly for a single
 * read-only display, and this module's own header already states it never
 * reaches beyond the platform's own account-roster metadata.
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
