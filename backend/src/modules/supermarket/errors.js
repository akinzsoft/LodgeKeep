'use strict';

const { AppError } = require('../../shared/errors');

class NotASupermarketOutletError extends AppError {
  constructor(outletName) {
    super('BUSINESS_RULE_NOT_A_SUPERMARKET_OUTLET', `${outletName ? `"${outletName}"` : 'This outlet'} is not a supermarket outlet.`, 422);
  }
}

/**
 * The sale would take recorded stock below zero and the cashier has not
 * confirmed it. Nothing is written; resend the same cart with
 * `confirm_oversell: true` once the cashier confirms. `details.lines` lists
 * every short stock item (name, unit, on hand, needed, projected).
 */
class OversellNotConfirmedError extends AppError {
  constructor(shortfalls) {
    const names = shortfalls.map((line) => `${line.name} (${line.onHand} on hand, ${line.needed} needed)`).join(', ');
    super('BUSINESS_RULE_OVERSELL_NOT_CONFIRMED', `This sale takes recorded stock below zero: ${names}. Confirm to sell anyway.`, 422, {
      lines: shortfalls.map((line) => ({ stock_item_id: String(line.stockItemId), name: line.name, unit: line.unit, on_hand: line.onHand, needed: line.needed, projected: line.projectedQuantity })),
    });
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

// ---------------------------------------------------------------- online (Paystack) sales

/** The cashier already has an online sale waiting at this outlet: finish or cancel it first. */
class OnlineSalePendingError extends AppError {
  constructor(intentId) {
    super('CONFLICT_ONLINE_SALE_PENDING', 'An online payment is already waiting at this till. Finish or cancel it first.', 409, { intent_id: String(intentId) });
  }
}

class OnlineSaleNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_ONLINE_SALE_NOT_FOUND', 'The specified online sale does not exist.', 404);
  }
}

/** Cancel/refund asked of an online sale in a state that does not allow it (e.g. already paid and completed). */
class OnlineSaleStateError extends AppError {
  constructor(status, action) {
    super('CONFLICT_ONLINE_SALE_STATE', `This online sale is ${status.replace('_', ' ')}; it cannot be ${action}.`, 409, { status });
  }
}

/** A refund for this payment was already requested and is not finished; nothing new is sent to Paystack. */
class OnlineRefundInProgressError extends AppError {
  constructor(paymentId) {
    super('CONFLICT_ONLINE_REFUND_IN_PROGRESS', 'A refund for this payment is already in progress. Check its status before trying again.', 409, { payment_id: String(paymentId) });
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

// ---------------------------------------------------------------- product editing

class ProductNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_PRODUCT_NOT_FOUND', 'The specified product does not exist at this outlet.', 404);
  }
}

/**
 * The product's category is also carried by a hotel selling outlet, so the one shared row is on that
 * outlet's menu too: a supermarket edit would change the hotel's menu, which this module never does.
 */
class ProductSharedWithHotelError extends AppError {
  constructor(outletNames) {
    super('BUSINESS_RULE_PRODUCT_SHARED_WITH_HOTEL_OUTLET', `This product's category is also sold at ${outletNames.join(', ')}, so changing it here would change that menu. Move the product to a mart-only category first.`, 422, {
      outlets: outletNames,
    });
  }
}

class ProductNameTakenError extends AppError {
  constructor(name, category) {
    super('CONFLICT_PRODUCT_NAME_TAKEN', `An active product named "${name}" already exists in "${category}".`, 409);
  }
}

class ProductCategoryNotCarriedError extends AppError {
  constructor(category) {
    super('VALIDATION_PRODUCT_CATEGORY_NOT_CARRIED', `"${category}" is not one of the categories this outlet carries.`, 422, { category });
  }
}

/** Cost is read from the product's stock item; if another product uses that item too, changing it here would change theirs. */
class ProductCostSharedError extends AppError {
  constructor(message = 'This product shares its stock item with another product, so its cost has to be changed in Stock.') {
    super('BUSINESS_RULE_PRODUCT_COST_SHARED', message, 422);
  }
}

/** The product's stock recipe changed while the edit waited; nothing was written. */
class ProductChangedError extends AppError {
  constructor() {
    super('CONFLICT_PRODUCT_CHANGED', 'This product changed while you were editing it. Reload and try again.', 409);
  }
}

module.exports = {
  ProductNotFoundError,
  ProductSharedWithHotelError,
  ProductNameTakenError,
  ProductCategoryNotCarriedError,
  ProductCostSharedError,
  ProductChangedError,
  OnlineSalePendingError,
  OnlineSaleNotFoundError,
  OnlineSaleStateError,
  OnlineRefundInProgressError,
  OversellNotConfirmedError,
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
