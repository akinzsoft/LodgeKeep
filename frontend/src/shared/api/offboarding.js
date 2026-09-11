import { request, requestBlob } from './client.js';

/**
 * Tenant self-service offboarding — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md
 * §3.22. Thin wrappers matching `backend/src/modules/offboarding`'s real
 * response shapes, the same shape every other `shared/api/*.js` file takes.
 */

export function requestOffboarding(reason) {
  return request('/offboarding/request', { method: 'POST', body: { reason } });
}

export function getOffboardingStatus() {
  return request('/offboarding/status');
}

export function retryExport(exportId) {
  return request(`/offboarding/exports/${exportId}/retry`, { method: 'POST', body: {} });
}

export function downloadExport(exportId) {
  return requestBlob(`/offboarding/exports/${exportId}/download`);
}
