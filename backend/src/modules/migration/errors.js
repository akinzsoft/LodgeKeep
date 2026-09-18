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

/**
 * Security review finding: an uploaded CSV is attacker-controlled input from
 * a real (if privileged) user, and `__proto__`/`constructor`/`prototype`
 * column names are a known prototype-pollution vector against a naive
 * `columns: true` parse (GHSA-8cw4-87c7-c6xx). `csv-parse` itself no longer
 * mutates the prototype for these names (fixed upstream, `parse.js`'s own
 * header), but this is deliberate defense-in-depth: reject the file outright
 * rather than trust that every future call site correctly treats a `row`
 * object's own `__proto__`/`constructor`/`prototype` key as inert data.
 */
class UnsafeCsvHeaderError extends AppError {
  constructor(columnNames) {
    super(
      'VALIDATION_UNSAFE_CSV_HEADER',
      `The uploaded file's header row uses a reserved column name (${columnNames.join(', ')}) that is not permitted.`,
      400,
      { columnNames }
    );
  }
}

/**
 * Security review finding: a 20MB file has no shape limit at all otherwise
 * — a pathologically wide header (thousands of columns) builds an
 * equally-wide object per row for the whole file. See `parse.js`'s own
 * header for the full reasoning.
 */
class TooManyImportColumnsError extends AppError {
  constructor(columnCount, maxColumns) {
    super(
      'VALIDATION_TOO_MANY_IMPORT_COLUMNS',
      `The uploaded file's header row has ${columnCount} columns — at most ${maxColumns} are supported.`,
      400,
      { columnCount, maxColumns }
    );
  }
}

/** Same reasoning as `TooManyImportColumnsError`, for row count instead. */
class TooManyImportRowsError extends AppError {
  constructor(maxRows) {
    super('VALIDATION_TOO_MANY_IMPORT_ROWS', `This file has more than ${maxRows} data rows — split it into smaller files and import each separately.`, 400, {
      maxRows,
    });
  }
}

/**
 * A real, pre-existing gap found while adding the two limits above, not
 * introduced by them: `csv-parse` throws a bare `Error` (`.code` starting
 * `CSV_...` — inconsistent column counts, an unterminated quoted field,
 * this file's own new `CSV_MAX_RECORD_SIZE`, etc.) for any malformed
 * input, which is not an `AppError` and was never caught anywhere —
 * `error-handler.js`'s own catch-all turned every one of these into a bare
 * `500 INTERNAL_ERROR` instead of a friendly, actionable rejection.
 */
class MalformedCsvError extends AppError {
  constructor(csvErrorCode) {
    super('VALIDATION_MALFORMED_CSV', 'This file could not be read as a valid CSV — check for a wrong delimiter, an unterminated quote, or an inconsistent number of columns per row.', 400, {
      csvErrorCode,
    });
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
  UnsafeCsvHeaderError,
  TooManyImportColumnsError,
  TooManyImportRowsError,
  MalformedCsvError,
};
