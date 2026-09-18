import { request, requestWithMeta } from './client.js';

/**
 * PLAN.md Phase 2.5's night-audit module. Same shape as `housekeeping.js`:
 * plain exported functions, each a thin wrapper over `request()`. No
 * `Idempotency-Key` on `runNightAudit` — the backend's own run-row claim
 * is a stronger, purpose-built idempotency mechanism (see
 * `backend/src/modules/night-audit/service.js`'s own header for why).
 *
 * Gap closure (user-reported): running night audit blanked the whole page.
 * `POST /night-audit/run`'s real response carries the daily-report row in
 * `data` and `{run, exceptions, nextBusinessDate}` in `meta` (the run and
 * next business date aren't properties of the report resource itself) —
 * `runNightAudit` used plain `request()`, which silently discards `meta`,
 * so `NightAuditScreen.jsx`'s own `lastResult.meta.nextBusinessDate` read
 * threw on a real `undefined`, crashing the tree with no error boundary to
 * catch it. `CLAUDE.md` had already flagged this exact defect once before
 * (the guest-booking-portal pass fixed its own equivalent) but left this
 * screen's instance open as unrelated to that pass's scope — this is that
 * follow-up, finally triggered by a real run rather than left latent.
 */
export function runNightAudit() {
  return requestWithMeta('/night-audit/run', { method: 'POST', body: {} });
}

export function listRuns() {
  return request('/night-audit/runs');
}

export function getRun(id) {
  return request(`/night-audit/runs/${id}`);
}

export function getDailyReport(businessDate) {
  return request(`/night-audit/daily-reports/${businessDate}`);
}
