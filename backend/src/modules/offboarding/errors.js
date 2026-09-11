'use strict';

/**
 * Offboarding module errors — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md
 * §3.22. The tenant-status transition itself reuses
 * `TenantNotFoundError`/`InvalidTenantLifecycleTransitionError`
 * (`src/modules/platform/errors.js`) rather than duplicating them — see
 * that file's own header, updated by this pass to describe both
 * directions of the offboarding transition. A cross-tenant or nonexistent
 * export id is a plain 404 (SECURITY.md §2 — "cross-tenant access is 404,
 * never 403/422, since anything else confirms the record exists"),
 * handled the same way every other by-id lookup in this codebase is
 * (`if (!row) return notFound(res)`), not a dedicated error class here.
 */

const { AppError } = require('../../shared/errors');

class ExportNotRetryableError extends AppError {
  constructor(status) {
    super(
      'BUSINESS_RULE_EXPORT_NOT_RETRYABLE',
      `Only a failed export can be retried (current status: "${status}").`,
      422,
      { status }
    );
  }
}

class ExportNotDownloadableError extends AppError {
  constructor(status) {
    super(
      'BUSINESS_RULE_EXPORT_NOT_DOWNLOADABLE',
      `This export is not ready to download yet (current status: "${status}").`,
      422,
      { status }
    );
  }
}

module.exports = { ExportNotRetryableError, ExportNotDownloadableError };
