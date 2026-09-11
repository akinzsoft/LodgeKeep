'use strict';

/**
 * Data migration module error types — API.md §3, PLAN.md Phase 5.
 */

const { AppError } = require('../../shared/errors');

class UnknownEntityTypeError extends AppError {
  constructor(entityType) {
    super('VALIDATION_UNKNOWN_ENTITY_TYPE', `"${entityType}" is not a supported import entity type.`, 400, { entityType });
  }
}

class MissingUploadedFileError extends AppError {
  constructor() {
    super('VALIDATION_MISSING_FILE', 'A CSV file is required.', 400);
  }
}

class MissingPropertyIdError extends AppError {
  constructor(entityType) {
    super('VALIDATION_MISSING_PROPERTY_ID', `"property_id" is required for a "${entityType}" import.`, 400, { entityType });
  }
}

class ImportRunNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_IMPORT_RUN_NOT_FOUND', 'The specified import run does not exist.', 404);
  }
}

/** 422 — the run exists but is not in the right lifecycle state for the action requested. */
class InvalidImportRunStateError extends AppError {
  constructor(status, expected) {
    super(
      'BUSINESS_RULE_INVALID_IMPORT_RUN_STATE',
      `This action requires the import run to be in one of [${expected.join(', ')}] — it is currently "${status}".`,
      422,
      { status, expected }
    );
  }
}

/** §3.20: "never auto-merge" — commit refuses outright while any duplicate_candidate row has no resolution. */
class UnresolvedDuplicatesError extends AppError {
  constructor(rowNumbers) {
    super(
      'VALIDATION_UNRESOLVED_DUPLICATES',
      `${rowNumbers.length} row(s) have an unresolved likely-duplicate guest and must be resolved before commit: rows ${rowNumbers.join(', ')}.`,
      422,
      { rowNumbers }
    );
  }
}

class DuplicateRowNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_DUPLICATE_ROW_NOT_FOUND', 'No unresolved duplicate-candidate finding exists for this row.', 404);
  }
}

class InvalidDuplicateResolutionError extends AppError {
  constructor() {
    super('VALIDATION_INVALID_DUPLICATE_RESOLUTION', '"resolution" must be "use_existing" or "create_new" ("use_existing" also requires "matched_guest_id").', 400);
  }
}

module.exports = {
  UnknownEntityTypeError,
  MissingUploadedFileError,
  MissingPropertyIdError,
  ImportRunNotFoundError,
  InvalidImportRunStateError,
  UnresolvedDuplicatesError,
  DuplicateRowNotFoundError,
  InvalidDuplicateResolutionError,
};
