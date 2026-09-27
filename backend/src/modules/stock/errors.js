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

/** Gap closure — mirrors `pos/errors.js`'s `MenuCategoryInUseError` exactly. */
class StockCategoryInUseError extends AppError {
  constructor(name, itemCount) {
    super('CONFLICT_STOCK_CATEGORY_IN_USE', `"${name}" is still used by ${itemCount} stock item${itemCount === 1 ? '' : 's'} — move them to another category first.`, 409, { name, itemCount });
  }
}

/**
 * Gap closure — the stock-out override guard. Adding/settling an item whose
 * recipe would take (or has already taken) a linked stock component to <= 0
 * is allowed, never blocked outright (this module's own "negative stock is
 * allowed, never blocked" rule, above), but requires a caller-supplied
 * override reason. A dedicated code (rather than a generic MISSING_FIELD)
 * because every caller of this guard needs to reliably distinguish this one
 * rejection, reactively, from any other validation failure.
 */
class InsufficientStockOverrideRequiredError extends AppError {
  constructor(items) {
    const names = items.map((item) => item.name).join(', ');
    super(
      'BUSINESS_RULE_INSUFFICIENT_STOCK',
      `This would leave ${names} at zero or below — supply an override reason to proceed.`,
      422,
      { items },
    );
  }
}

/**
 * A transfer asked for more than the source outlet holds. Unlike a sale or
 * wastage (which may take stock negative), a transfer is refused outright —
 * see `transferStock`'s own header for why there is no override path.
 */
class InsufficientStockForTransferError extends AppError {
  constructor({ stockItemId, name, unit, fromOutletId, available, requested }) {
    super(
      'BUSINESS_RULE_INSUFFICIENT_STOCK_FOR_TRANSFER',
      `Only ${available} ${unit} of "${name}" is on hand at this outlet — cannot transfer ${requested} ${unit}. A transfer can never take stock below zero.`,
      422,
      { stockItemId, fromOutletId, available, requested },
    );
  }
}

class SameOutletTransferError extends ValidationError {
  constructor() {
    super('SAME_OUTLET_TRANSFER', 'Choose two different outlets — a transfer cannot go from an outlet to itself.', [{ field: 'to_outlet_id', issue: 'same_as_from' }]);
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
  StockCategoryInUseError,
  InsufficientStockOverrideRequiredError,
  InsufficientStockForTransferError,
  SameOutletTransferError,
};
