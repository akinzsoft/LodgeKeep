import { request, requestMultipart } from './client.js';

/**
 * Door access monitoring endpoint wrappers — PLAN.md Phase 7,
 * PRODUCT_REQUIREMENTS.md §3.23 (`backend/src/modules/access-monitoring`).
 *
 * The import flow is stateless on the server: the selected file is sent
 * again with each step (headers → preview → commit), so every import call
 * here takes the browser's own `File`. `mapping` travels as a JSON string
 * field next to it. Config/summary responses are hand-shaped camelCase;
 * alert/event/confirmation rows are raw snake_case DB rows.
 */

function uploadForm(file, mapping) {
  const formData = new FormData();
  if (mapping) formData.append('mapping', JSON.stringify(mapping));
  formData.append('file', file);
  return formData;
}

export function getConfig() {
  return request('/door-access/config');
}

/** @param {{adapter?: string, postCheckoutGraceMinutes?: number}} changes */
export function updateConfig({ adapter, postCheckoutGraceMinutes }) {
  return request('/door-access/config', {
    method: 'PUT',
    body: { adapter, post_checkout_grace_minutes: postCheckoutGraceMinutes },
  });
}

export function readHeaders(file) {
  return requestMultipart('/door-access/imports/headers', uploadForm(file));
}

export function previewImport(file, mapping) {
  return requestMultipart('/door-access/imports/preview', uploadForm(file, mapping));
}

export function commitImport(file, mapping) {
  return requestMultipart('/door-access/imports/commit', uploadForm(file, mapping));
}

export function listAlerts({ status, rule, severity } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (rule) params.set('rule', rule);
  if (severity) params.set('severity', severity);
  const query = params.toString();
  return request(`/door-access/alerts${query ? `?${query}` : ''}`);
}

export function getAlert(id) {
  return request(`/door-access/alerts/${id}`);
}

export function acknowledgeAlert(id) {
  return request(`/door-access/alerts/${id}/acknowledge`, { method: 'POST', body: {} });
}

export function resolveAlert(id, reason) {
  return request(`/door-access/alerts/${id}/resolve`, { method: 'POST', body: { reason } });
}

export function listStayConfirmations() {
  return request('/door-access/stay-confirmations');
}
