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

/**
 * ONE answer for every way a typed code can fail at the till (no such code, expired, not yet valid, wrong outlet,
 * disabled, used up, not text), so a code cannot be probed for what it is.
 */
class VoucherInvalidError extends AppError {
  constructor() {
    super('BUSINESS_RULE_VOUCHER_INVALID', 'That voucher code cannot be used here.', 422);
  }
}

const NO_LONGER_REASON_TEXT = {
  disabled: 'was disabled',
  expired: 'has expired',
  not_yet: 'is not valid yet',
  used_up: 'has been used up',
  wrong_outlet: 'does not work at this outlet',
  missing: 'no longer exists',
};

/** The voucher was fine when put on the check but is not now. The check is left as it was and the voucher removable. */
class VoucherNoLongerAvailableError extends AppError {
  constructor(reason, discountId = null) {
    const why = NO_LONGER_REASON_TEXT[reason] ?? 'can no longer be used';
    super(
      'BUSINESS_RULE_VOUCHER_NO_LONGER_AVAILABLE',
      `The voucher on this check ${why}. Nothing was charged. Remove the voucher from the check and ring it up again at the full price.`,
      422,
      { reason, discountId: discountId === null ? null : String(discountId) }
    );
  }
}

/** A fixed voucher is worth more than this check can take off (the cap its creator was allowed). Add items, or use another. */
class VoucherCheckTooSmallError extends AppError {
  constructor(limitPercent) {
    super('BUSINESS_RULE_VOUCHER_CHECK_TOO_SMALL', `This voucher is worth more than this check can take off (at most ${limitPercent}% of a check). Add items to the check, or use another voucher.`, 422, { limitPercent });
  }
}

class VoucherNotOnCardError extends AppError {
  constructor() {
    super('BUSINESS_RULE_VOUCHER_NOT_ON_CARD', 'A voucher cannot be used with a card or QR payment yet. Remove the voucher, or pay by cash, a card terminal or a room charge.', 422);
  }
}

class VoucherAboveLimitError extends AppError {
  constructor(limit) {
    super('BUSINESS_RULE_VOUCHER_ABOVE_LIMIT', `A voucher can take off at most ${limit}% (your discount limit). A higher voucher needs comp authority.`, 422, { limit });
  }
}

class VoucherNeedsCompError extends AppError {
  constructor() {
    super('FORBIDDEN_VOUCHER_NEEDS_COMP', 'A voucher above your discount limit, or for the whole bill, needs comp authority (discount.comp).', 403);
  }
}

class VoucherNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_VOUCHER_NOT_FOUND', 'That voucher does not exist.', 404);
  }
}

module.exports = {
  VoucherInvalidError,
  VoucherNoLongerAvailableError,
  VoucherCheckTooSmallError,
  VoucherNotOnCardError,
  VoucherAboveLimitError,
  VoucherNeedsCompError,
  VoucherNotFoundError,
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
