'use strict';

/**
 * QR self-ordering module error types — API.md §3, PLAN.md Phase 6.
 */

const { AppError, ValidationError } = require('../../shared/errors');

/** A property's outlet has not opted into guest self-ordering — see the `pos_outlets` migration header. */
class GuestOrderingDisabledError extends AppError {
  constructor() {
    super('BUSINESS_RULE_GUEST_ORDERING_DISABLED', 'Guest self-ordering is not enabled here right now.', 422);
  }
}

/** The outlet's own configured cap on total unpaid guest-order value for one token — a guarding limit, not a payment requirement (payment is always required regardless). */
class UnpaidValueCapExceededError extends AppError {
  constructor(cap) {
    super(
      'BUSINESS_RULE_GUEST_ORDER_VALUE_CAP_EXCEEDED',
      `This would exceed the maximum of ${cap} in unpaid orders allowed at once — please settle an existing order before adding another.`,
      422,
      { cap }
    );
  }
}

/** ARCHITECTURE.md §15's public/guest rate-limit tier — a real 429 with a Retry-After. */
class RateLimitedError extends AppError {
  constructor(retryAfterSeconds) {
    super('RATE_LIMITED', 'Too many orders from this code recently — please wait a moment and try again.', 429, { retryAfterSeconds });
  }
}

class GuestOrderNotFoundError extends ValidationError {
  constructor() {
    super('GUEST_ORDER_NOT_FOUND', 'The specified order does not exist.');
  }
}

class WrongPaymentMethodError extends ValidationError {
  constructor(message) {
    super('WRONG_PAYMENT_METHOD', message);
  }
}

/** A guest order's payment has already settled — a second checkout/OTP attempt against it is a conflict, not a silent no-op. */
class OrderAlreadyPaidError extends AppError {
  constructor() {
    super('CONFLICT_GUEST_ORDER_ALREADY_PAID', 'This order has already been paid.', 409);
  }
}

class OtpInvalidError extends AppError {
  constructor() {
    super('AUTH_OTP_INVALID', 'The code is incorrect, expired, or already used.', 401);
  }
}

/** PRODUCT_REQUIREMENTS.md §3.4's charge-to-room rule, applied to a QR room token: the physical room must have a real, live in-house occupant to charge. */
class NoInHouseReservationError extends AppError {
  constructor() {
    super('BUSINESS_RULE_NO_IN_HOUSE_RESERVATION', 'This room has no in-house guest to charge right now.', 422);
  }
}

/** A cart-empty submission — never a valid order. */
class EmptyCartError extends ValidationError {
  constructor() {
    super('EMPTY_CART', 'At least one item is required.', [{ field: 'items', issue: 'missing' }]);
  }
}

/** A staff action (accept/mark-on-the-way/reject) attempted against a guest order not currently in the state that action requires. */
class GuestOrderStateConflictError extends AppError {
  constructor(status, expected) {
    super('CONFLICT_GUEST_ORDER_STATE', `This order is "${status}", not "${expected}".`, 409, { status, expected });
  }
}

/**
 * Code-review fix (CRITICAL): a guest order staff already rejected (or that
 * auto-rejected) must never be resurrected by a delayed OTP verify, a late
 * Paystack webhook/confirm-payment callback, or a request-otp made after
 * the fact — `requestRoomChargeOtp`/`verifyRoomChargeOtpAndSettle`/
 * `confirmCardPayment` all check this explicitly, not just the underlying
 * `pos_orders.status`/`payment_status`, since those alone don't distinguish
 * "never paid" from "rejected and therefore must never be paid".
 */
class GuestOrderAlreadyRejectedError extends AppError {
  constructor(status) {
    super(
      'CONFLICT_GUEST_ORDER_ALREADY_REJECTED',
      `This order was already ${status === 'auto_rejected' ? 'auto-rejected' : 'rejected'} and can no longer be paid or charged.`,
      409,
      { status }
    );
  }
}

module.exports = {
  GuestOrderingDisabledError,
  UnpaidValueCapExceededError,
  RateLimitedError,
  GuestOrderNotFoundError,
  WrongPaymentMethodError,
  OrderAlreadyPaidError,
  OtpInvalidError,
  NoInHouseReservationError,
  EmptyCartError,
  GuestOrderStateConflictError,
  GuestOrderAlreadyRejectedError,
};
