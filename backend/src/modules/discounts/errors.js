'use strict';

const { AppError } = require('../../shared/errors');

class DiscountNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_DISCOUNT_NOT_FOUND', 'That discount does not exist.', 400);
  }
}

class DiscountReasonInvalidError extends AppError {
  constructor(message = 'Choose an active reason that fits this kind of discount.') {
    super('VALIDATION_INVALID_DISCOUNT_REASON', message, 400, { field: 'reason_id' });
  }
}

/** A decided discount is immutable: it can be removed before settlement, never edited or re-pointed. */
class DiscountStateError extends AppError {
  constructor(discountId, status) {
    super('CONFLICT_DISCOUNT_STATE', `This discount is already ${String(status).replace('_', ' ')}.`, 409, { discountId: String(discountId), status });
  }
}

class DiscountAlreadyOnTargetError extends AppError {
  constructor(scope) {
    super('CONFLICT_DISCOUNT_ALREADY_APPLIED', scope === 'line' ? 'This line already has a discount. Remove it first, then add a new one.' : 'This check already has an order discount. Remove it first, then add a new one.', 409, { scope });
  }
}

class DiscountNothingToDiscountError extends AppError {
  constructor() {
    super('BUSINESS_RULE_NOTHING_TO_DISCOUNT', 'There is nothing to discount here.', 422);
  }
}

class DiscountUseCompError extends AppError {
  constructor() {
    super('BUSINESS_RULE_DISCOUNT_USE_COMP', 'A discount that takes off everything must be given as a comp, which a manager approves.', 422);
  }
}

class DiscountPaymentInProgressError extends AppError {
  constructor() {
    super('BUSINESS_RULE_DISCOUNT_PAYMENT_IN_PROGRESS', 'A card payment for this check has already been taken. Settle it, or refund it, before changing discounts.', 422);
  }
}

class DiscountNeedsApprovalError extends AppError {
  constructor(discountId) {
    super('BUSINESS_RULE_DISCOUNT_NEEDS_APPROVAL', 'The check changed, and this discount now exceeds what its giver may take off without a manager. Remove it and ask for approval again.', 422, { discountId: String(discountId) });
  }
}

class DiscountGrantInvalidError extends AppError {
  constructor(message = 'That discount can no longer be used for this sale. Ask for it again.') {
    super('VALIDATION_DISCOUNT_GRANT_INVALID', message, 422);
  }
}

class DiscountApproverNotEligibleError extends AppError {
  constructor(reason) {
    super('FORBIDDEN_APPROVER_NOT_ELIGIBLE', reason, 403);
  }
}

class DiscountLimitInvalidError extends AppError {
  constructor() {
    super('VALIDATION_INVALID_DISCOUNT_LIMIT', '"max_percent" must be a percent from 0 to 100 with at most 2 decimals.', 400, { field: 'max_percent' });
  }
}

module.exports = {
  DiscountNotFoundError,
  DiscountReasonInvalidError,
  DiscountStateError,
  DiscountAlreadyOnTargetError,
  DiscountNothingToDiscountError,
  DiscountUseCompError,
  DiscountPaymentInProgressError,
  DiscountNeedsApprovalError,
  DiscountGrantInvalidError,
  DiscountApproverNotEligibleError,
  DiscountLimitInvalidError,
};
