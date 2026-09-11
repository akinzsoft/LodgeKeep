'use strict';

/**
 * The dunning schedule — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22.
 *
 * Revised per explicit user feedback after the first version of this pass
 * shipped (originally "3 attempts over 7 days, day 0/1/3/7"): "Multiple
 * retries over roughly a 7-14 day window... automatic suspension, but
 * only after a genuine retry-and-notify sequence has run its course."
 * `DUNNING_SCHEDULE_DAYS` below is now day 0/3/7/10/14 since the
 * invoice's own `due_at` — five charge attempts total (day 0 is the
 * ORIGINAL attempt, not itself a "retry"; the four after it are the real
 * retries the user's own wording names). A fifth failure (the day-14
 * retry) exhausts the schedule: `src/modules/billing/service.js`'s
 * `applyChargeOutcome` then marks the invoice `uncollectible` and
 * suspends the tenant via the same raw conditional-UPDATE mechanism
 * `src/jobs/trial-expiry.js` already established for "a job suspends a
 * tenant" — and, per the same feedback, suspension still only ever
 * degrades the tenant to the EXISTING read-only pattern
 * (`src/shared/tenant-lifecycle.js`), never a hard lockout, and fires
 * automatically with no human approval gate (a manual checkpoint "won't
 * scale or get reliably checked" — the user's own words). The four
 * escalating notification emails plus the final suspension notice this
 * same feedback asks for are built in `service.js`, not here — this file
 * stays strictly the schedule's own math, pure and directly unit-tested,
 * matching this codebase's own repeated "a business rule this
 * consequential gets a pure function with every boundary tested"
 * discipline (`computeEarlyLateFee`, `activityCutoffDate`,
 * `resolveEffectiveTax`).
 */

const DUNNING_SCHEDULE_DAYS = Object.freeze([0, 3, 7, 10, 14]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysSince(dateValue, now) {
  return Math.floor((now.getTime() - new Date(dateValue).getTime()) / MS_PER_DAY);
}

/** True once the schedule's own attempt budget is used up — no further retry should ever be attempted. */
function isDunningExhausted(attemptCount) {
  return attemptCount >= DUNNING_SCHEDULE_DAYS.length;
}

/**
 * True exactly when the NEXT scheduled attempt (indexed by how many
 * attempts have already happened) is due, given how many whole days have
 * passed since the invoice became due. `attemptCount === 0` is due
 * immediately once `due_at` itself has arrived (day 0 IS the due date, not
 * one day after it) — `daysSince` can be 0 or positive by the time a sweep
 * ever looks at it, both correctly due.
 */
function isDunningAttemptDue(invoice, now) {
  if (isDunningExhausted(invoice.attempt_count)) return false;
  return daysSince(invoice.due_at, now) >= DUNNING_SCHEDULE_DAYS[invoice.attempt_count];
}

/**
 * The calendar date (`YYYY-MM-DD`) of the NEXT scheduled attempt after
 * `attemptCount` attempts have happened so far — used only to tell a
 * tenant, in a notification email, when to expect the next retry. Returns
 * `null` once the schedule is exhausted (there is no next attempt to name
 * — that failure's own email is the suspension notice instead, not a
 * "we'll retry on..." promise).
 */
function nextAttemptDate(dueAt, attemptCount) {
  if (isDunningExhausted(attemptCount)) return null;
  const due = new Date(dueAt);
  const next = new Date(due.getTime() + DUNNING_SCHEDULE_DAYS[attemptCount] * MS_PER_DAY);
  return next.toISOString().slice(0, 10);
}

module.exports = { DUNNING_SCHEDULE_DAYS, isDunningExhausted, isDunningAttemptDue, nextAttemptDate };
