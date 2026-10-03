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

module.exports = { NotASupermarketOutletError, BarcodeNotFoundError, BarcodeAlreadyUsedError, SupermarketSaleNotFoundError, SupermarketSaleAlreadyVoidedError };
