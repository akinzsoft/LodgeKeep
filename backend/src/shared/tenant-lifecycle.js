'use strict';

/**
 * The one project-wide policy for a tenant's write access — PLAN.md Phase 5,
 * PRODUCT_REQUIREMENTS.md §3.22 ("read-only degradation with a grace period
 * is safer than a hard cutoff... a PMS holding live reservations cannot
 * simply lock out a hotel mid-service").
 *
 * A single pure function, not a status scattered across services: both the
 * per-request HTTP gate (`src/auth/tenant-lifecycle-guard.js`, via
 * `req.context.tenantWriteBlocked` — computed once per request in
 * `src/auth/middleware.js`) and the trial-expiry background job
 * (`src/jobs/trial-expiry.js`, deciding which tenants to transition) read
 * this same function, so the rule can only ever be defined in one place.
 *
 * `tenants.status` values (`backend/migrations/20260902213045_...js`):
 *   trial       — usable exactly like `active` UNTIL `trial_ends_at` passes.
 *                 No separate "trial_expired" enum value exists; the
 *                 background job physically transitions an expired trial to
 *                 `suspended` (see that job's own header for why reusing
 *                 `suspended` rather than inventing a new status is
 *                 deliberate) — but this function ALSO checks `trial_ends_at`
 *                 directly, independent of whether that job has run yet, so
 *                 enforcement is correct immediately at the moment a trial
 *                 lapses, not only after the next sweep interval.
 *   active      — full read/write, unconditionally.
 *   suspended   — read-only (non-payment, or a lapsed trial).
 *   offboarding — read-only here too (this pass builds no transition INTO
 *                 this status — see `tenant-resolution.js`'s own header for
 *                 the separate, stricter "unreachable at all" rule that
 *                 status carries) — included for completeness, not because
 *                 any code path produces it yet.
 */

function isTenantWriteBlocked(tenant) {
  if (!tenant) return true; // fail closed — a request with no tenant row behind it writes nothing.
  if (tenant.status === 'active') return false;
  if (tenant.status === 'trial') {
    if (!tenant.trial_ends_at) return false; // no expiry set — usable indefinitely until one is.
    return new Date(tenant.trial_ends_at).getTime() <= Date.now();
  }
  // suspended, offboarding, or any future value this function doesn't yet
  // name explicitly — read-only is the safe default, never the reverse.
  return true;
}

const DEFAULT_TRIAL_PERIOD_DAYS = Number(process.env.TRIAL_PERIOD_DAYS || 14);

/** Pure, and takes "now" as a parameter so a test can pick a fixed instant rather than racing the real clock. */
function trialEndsAtFromNow(now = new Date(), days = DEFAULT_TRIAL_PERIOD_DAYS) {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

module.exports = { isTenantWriteBlocked, trialEndsAtFromNow, DEFAULT_TRIAL_PERIOD_DAYS };
