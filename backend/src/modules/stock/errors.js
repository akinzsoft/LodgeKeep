'use strict';

/**
 * Stock module error types — API.md §3, PLAN.md Phase 6. Following the
 * exact shape `pos/errors.js` already established.
 */

const { AppError, ValidationError } = require('../../shared/errors');

class StockItemNotFoundError extends ValidationError {
  constructor() {
    super('STOCK_ITEM_NOT_FOUND', 'The specified stock item does not exist.');
  }
}

class OutletNotFoundError extends ValidationError {
  constructor() {
    super('OUTLET_NOT_FOUND', 'The specified outlet does not exist.');
  }
}

class MenuItemNotFoundError extends ValidationError {
  constructor() {
    super('MENU_ITEM_NOT_FOUND', 'The specified menu item does not exist.');
  }
}

/** A stock item does not belong to the outlet a caller asserted it does — the recipe upsert's "same outlet" rule, or a goods-received/wastage line naming an item from a different outlet. */
class OutletMismatchError extends ValidationError {
  constructor(message) {
    super('STOCK_ITEM_OUTLET_MISMATCH', message ?? 'The stock item does not belong to the specified outlet.');
  }
}

/** Wastage/count-adjustment mandatory reason — mirrors `pos/service.js`'s "reason" is required to void" plain ValidationError shape. */
class MissingWastageReasonError extends ValidationError {
  constructor() {
    super('MISSING_FIELD', '"reason" is required to record wastage.');
  }
}

class StockTakeNotFoundError extends ValidationError {
  constructor() {
    super('STOCK_TAKE_NOT_FOUND', 'The specified stock take does not exist.');
  }
}

/** ARCHITECTURE.md §8-adjacent: a take's status blocks the requested action. */
class StockTakeNotOpenError extends AppError {
  constructor(stockTakeId, status) {
    super('CONFLICT_STOCK_TAKE_NOT_OPEN', `Stock take ${stockTakeId} is "${status}", not open.`, 409, { stockTakeId, status });
  }
}

class StockTakeAlreadyCompletedError extends AppError {
  constructor(stockTakeId) {
    super('CONFLICT_STOCK_TAKE_ALREADY_COMPLETED', `Stock take ${stockTakeId} has already been completed.`, 409, { stockTakeId });
  }
}

class StockTakeAlreadyCancelledError extends AppError {
  constructor(stockTakeId) {
    super('CONFLICT_STOCK_TAKE_ALREADY_CANCELLED', `Stock take ${stockTakeId} has already been cancelled.`, 409, { stockTakeId });
  }
}

module.exports = {
  StockItemNotFoundError,
  OutletNotFoundError,
  MenuItemNotFoundError,
  OutletMismatchError,
  MissingWastageReasonError,
  StockTakeNotFoundError,
  StockTakeNotOpenError,
  StockTakeAlreadyCompletedError,
  StockTakeAlreadyCancelledError,
};
