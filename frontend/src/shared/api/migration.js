import { request, requestBlob, requestMultipart } from './client.js';

/**
 * Data Migration endpoint wrappers — PLAN.md Phase 5's last unbuilt bullet,
 * PRODUCT_REQUIREMENTS.md §3.20. Thin wrappers matching the real
 * `backend/src/modules/migration` response shapes exactly — a raw
 * `import_runs`/`import_row_errors` row is snake_case (it's a direct DB
 * row return, not a hand-shaped response), while `rollbackImportRun`'s own
 * return value is hand-built and camelCase. Callers read both shapes as
 * they really are rather than a normalized-then-relied-upon fiction.
 */

export function listEntityTypes() {
  return ['guests', 'reservations', 'companies', 'ar_balances'];
}

export function downloadTemplate(entityType) {
  return requestBlob(`/migration/templates/${entityType}`);
}

export function uploadImport({ entityType, propertyId, file }) {
  const formData = new FormData();
  formData.append('entity_type', entityType);
  if (propertyId) formData.append('property_id', propertyId);
  formData.append('file', file);
  return requestMultipart('/migration/imports', formData);
}

export function listImportRuns({ entityType, status } = {}) {
  const params = new URLSearchParams();
  if (entityType) params.set('entity_type', entityType);
  if (status) params.set('status', status);
  const query = params.toString();
  return request(`/migration/imports${query ? `?${query}` : ''}`);
}

/** @returns {Promise<{run: object, errors: object[]}>} */
export function getImportRun(id) {
  return request(`/migration/imports/${id}`);
}

/** @returns {Promise<{run: object, errors: object[]}>} */
export function runDryRun(id) {
  return request(`/migration/imports/${id}/dry-run`, { method: 'POST', body: {} });
}

/** @param {'use_existing'|'create_new'} resolution */
export function resolveDuplicate(id, rowNumber, resolution, matchedGuestId) {
  return request(`/migration/imports/${id}/duplicates/${rowNumber}`, {
    method: 'PATCH',
    body: { resolution, matched_guest_id: matchedGuestId },
  });
}

export function commitImportRun(id) {
  return request(`/migration/imports/${id}/commit`, { method: 'POST', body: {} });
}

/** @returns {Promise<{importRunId: string, status: string, rowsRolledBack: number, rowsRefused: Array<{entityType: string, entityId: string, rowNumber: number, reason: string}>}>} */
export function rollbackImportRun(id, reason) {
  return request(`/migration/imports/${id}/rollback`, { method: 'POST', body: { reason } });
}
