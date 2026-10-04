'use strict';

const { AppError } = require('../../shared/errors');

class NotASupermarketOutletError extends AppError {
  constructor(outletName) {
    super('BUSINESS_RULE_NOT_A_SUPERMARKET_OUTLET', `${outletName ? `"${outletName}"` : 'This outlet'} is not a supermarket outlet.`, 422);
  }
}

class BarcodeNotFoundError extends AppError {
  constructor(barcode) {
    super('VALIDATION_BARCODE_NOT_FOUND', `No product has the barcode "${barcode}".`, 404);
  }
}

class BarcodeAlreadyUsedError extends AppError {
  constructor(barcode) {
    super('CONFLICT_BARCODE_ALREADY_USED', `The barcode "${barcode}" already belongs to a product.`, 409);
  }
}

class SupermarketSaleNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_SUPERMARKET_SALE_NOT_FOUND', 'The specified sale does not exist.', 404);
  }
}

class SupermarketSaleAlreadyVoidedError extends AppError {
  constructor() {
    super('CONFLICT_SUPERMARKET_SALE_ALREADY_VOIDED', 'This sale has already been voided.', 409);
  }
}

// ---------------------------------------------------------------- Stage 3: product import

/** The uploaded file is not this import's template (missing or unknown columns, no data rows, too many rows). */
class ProductImportFileError extends AppError {
  constructor(message, details) {
    super('VALIDATION_PRODUCT_IMPORT_FILE', message, 400, details);
  }
}

/** Commit refused: the dry run found blocking errors (all-or-nothing — nothing commits while any row is wrong). */
class ProductImportHasErrorsError extends AppError {
  constructor(errorCount) {
    super('BUSINESS_RULE_PRODUCT_IMPORT_HAS_ERRORS', `The dry run found ${errorCount} problem(s). Fix the file and upload it again — nothing is imported while any row is wrong.`, 422, { errorCount });
  }
}

/** Another product import is committing at this property (one at a time — the catalogue is property-wide). */
class ProductImportInProgressError extends AppError {
  constructor(importRunId) {
    super('CONFLICT_PRODUCT_IMPORT_IN_PROGRESS', 'Another product import is being committed at this property. Wait for it to finish, then try again.', 409, { importRunId: String(importRunId) });
  }
}

/** Thrown inside the commit transaction when re-validating finds the data changed since the dry run (e.g. a barcode added by hand meanwhile). */
class ProductImportChangedError extends AppError {
  constructor(findings) {
    super(
      'BUSINESS_RULE_PRODUCT_IMPORT_CHANGED',
      `The data changed since the dry run: ${findings.length} problem(s). Nothing was imported — fix the file and upload it again.`,
      422,
      { count: findings.length }
    );
    this.findings = findings;
  }
}

/** The job finished after its run was released as stuck; its work is rolled back rather than landing on a failed run. */
class ProductImportReleasedError extends AppError {
  constructor() {
    super('CONFLICT_PRODUCT_IMPORT_RELEASED', 'This import was released as stuck while it was still running, so nothing from it was kept. Upload the file again.', 409);
  }
}

module.exports = {
  ProductImportReleasedError,
  ProductImportFileError,
  ProductImportHasErrorsError,
  ProductImportInProgressError,
  ProductImportChangedError,
  NotASupermarketOutletError,
  BarcodeNotFoundError,
  BarcodeAlreadyUsedError,
  SupermarketSaleNotFoundError,
  SupermarketSaleAlreadyVoidedError,
};
