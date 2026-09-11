'use strict';

/**
 * Platform console module error types — API.md §3, PLAN.md Phase 5.
 * 422, not 400 — the same "a friendly existence check ahead of the real
 * constraint" convention AR's own `ArAccountNotFoundError`/
 * `CompanyProfileNotFoundError` already established: the request is
 * well-formed, the referenced tenant/property simply isn't real (or isn't
 * paired correctly).
 */

const { AppError, ValidationError } = require('../../shared/errors');

class TenantNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_TENANT_NOT_FOUND', 'The specified tenant does not exist.', 422);
  }
}

class PropertyNotInTenantError extends AppError {
  constructor() {
    super('VALIDATION_PROPERTY_NOT_IN_TENANT', 'The specified property does not belong to this tenant.', 422);
  }
}

module.exports = { TenantNotFoundError, PropertyNotInTenantError, ValidationError };
