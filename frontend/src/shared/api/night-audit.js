import { request } from './client.js';

/**
 * PLAN.md Phase 2.5's night-audit module. Same shape as `housekeeping.js`:
 * plain exported functions, each a thin wrapper over `request()`. No
 * `Idempotency-Key` on `runNightAudit` — the backend's own run-row claim
 * is a stronger, purpose-built idempotency mechanism (see
 * `backend/src/modules/night-audit/service.js`'s own header for why).
 */

export function runNightAudit() {
  return request('/night-audit/run', { method: 'POST', body: {} });
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
