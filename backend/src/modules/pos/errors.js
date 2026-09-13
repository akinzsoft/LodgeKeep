'use strict';

/**
 * POS module error types — API.md §3, PLAN.md Phase 4. Following the exact
 * shape `cashiering/errors.js` already established.
 */

const { AppError, ValidationError } = require('../../shared/errors');

/** A tab's status blocks the requested action (adding/voiding an item, settling an already-settled or voided order). */
class OrderNotOpenError extends AppError {
  constructor(orderId, status) {
    super('CONFLICT_POS_ORDER_NOT_OPEN', `Order ${orderId} is "${status}", not open.`, 409, { orderId, status });
  }
}

/** ARCHITECTURE.md §8: void, never delete — voiding an item that is already void is a conflict, not a silent no-op. */
class OrderItemAlreadyVoidedError extends AppError {
  constructor(orderItemId) {
    super('CONFLICT_POS_ORDER_ITEM_ALREADY_VOIDED', `Order item ${orderItemId} has already been voided.`, 409, { orderItemId });
  }
}

/** PRODUCT_REQUIREMENTS.md §3.4: "Reject if the folio is closed, the guest has checked out, or the room has no in-house reservation." */
class RoomChargeRejectedError extends AppError {
  constructor(reason) {
    super('BUSINESS_RULE_POS_ROOM_CHARGE_REJECTED', `Charge to room rejected: ${reason}`, 422, { reason });
  }
}

/**
 * A settlement request must cover the order's own split groups exactly
 * once each — every distinct group present among its unvoided items, no
 * group missing and none requested twice. `reason` distinguishes the two
 * ways this can fail (`'uncovered'` — a real group has no settlement;
 * `'duplicate'` — two settlement entries target the same group, which
 * would otherwise charge/settle those items twice) so the message is
 * specific, never a generic "amounts don't match."
 */
class SettlementGroupsMismatchError extends AppError {
  constructor(reason, { present, requested }) {
    const message =
      reason === 'duplicate'
        ? 'The settlement request targets the same split group more than once — each group can only be settled once per request.'
        : "The settlement request does not cover every one of the order's own split groups exactly once.";
    super('BUSINESS_RULE_POS_SETTLEMENT_GROUPS_MISMATCH', message, 422, { reason, present, requested });
  }
}

/** ARCHITECTURE.md §5's "POS tab edit" / one-open-shift-per-terminal guard. */
class ShiftAlreadyOpenError extends AppError {
  constructor(terminalId) {
    super('CONFLICT_POS_SHIFT_ALREADY_OPEN', `Terminal ${terminalId} already has an open shift.`, 409, { terminalId });
  }
}

/** A shift's own cash-up is written once, at close — closing an already-closed shift a second time is a conflict, not a silent no-op. */
class ShiftAlreadyClosedError extends AppError {
  constructor(shiftId) {
    super('CONFLICT_POS_SHIFT_ALREADY_CLOSED', `Shift ${shiftId} is already closed.`, 409, { shiftId });
  }
}

/** ARCHITECTURE.md §8: void, never delete — voiding a settlement that is already void is a conflict, not a silent no-op. */
class SettlementAlreadyVoidedError extends AppError {
  constructor(settlementId) {
    super('CONFLICT_POS_SETTLEMENT_ALREADY_VOIDED', `Settlement ${settlementId} has already been voided.`, 409, { settlementId });
  }
}

/**
 * A Register card/NQR check can only settle against money Paystack has
 * actually captured for that exact check. `reason` says which rule failed:
 * `missing` (no payment id sent), `not_found`, `wrong_check` (another
 * order or split group), `not_captured`, `already_used`, `amount_mismatch`
 * (the check's total changed after the guest paid), `currency_mismatch`.
 */
class RegisterPaymentInvalidError extends AppError {
  constructor(reason, details = {}) {
    const messages = {
      missing: 'A card or NQR check must be paid through Paystack before it can be settled.',
      not_found: 'The Paystack payment for this check could not be found.',
      wrong_check: 'That Paystack payment belongs to a different check.',
      not_captured: 'Paystack has not confirmed this payment yet.',
      already_used: 'That Paystack payment has already been used to settle a check.',
      amount_mismatch: "The amount paid does not match this check's total — the check changed after payment. Refund the payment or restore the check.",
      currency_mismatch: "The payment's currency does not match this property's currency.",
    };
    super('BUSINESS_RULE_POS_REGISTER_PAYMENT_INVALID', messages[reason] ?? messages.not_found, 422, { reason, ...details });
  }
}

/** A tab holding money Paystack has already captured cannot be voided — the payment would be left with nothing to settle or refund against. */
class OrderHasCapturedPaymentError extends AppError {
  constructor(orderId, paymentId) {
    super('CONFLICT_POS_ORDER_HAS_CAPTURED_PAYMENT', `Order ${orderId} has a captured card payment that has not been settled — settle the tab or refund the payment first.`, 409, { orderId, paymentId });
  }
}

/** A card/NQR settlement is reversed by refunding its Paystack payment (which voids the settlement too), never by voiding the settlement alone — that would leave the captured money un-refunded. */
class SettlementPaidByGatewayError extends AppError {
  constructor(settlementId, paymentId) {
    super('CONFLICT_POS_SETTLEMENT_PAID_BY_GATEWAY', `Settlement ${settlementId} was paid through Paystack — refund payment ${paymentId} instead; the refund voids this settlement.`, 409, { settlementId, paymentId });
  }
}

class OutletNotFoundError extends ValidationError {
  constructor() {
    super('OUTLET_NOT_FOUND', 'The specified outlet does not exist.');
  }
}

class TerminalNotFoundError extends ValidationError {
  constructor() {
    super('TERMINAL_NOT_FOUND', 'The specified terminal does not exist.');
  }
}

class MenuItemNotFoundError extends ValidationError {
  constructor() {
    super('MENU_ITEM_NOT_FOUND', 'The specified menu item does not exist.');
  }
}

class OrderNotFoundError extends ValidationError {
  constructor() {
    super('ORDER_NOT_FOUND', 'The specified order does not exist.');
  }
}

module.exports = {
  OrderNotOpenError,
  OrderItemAlreadyVoidedError,
  RoomChargeRejectedError,
  SettlementGroupsMismatchError,
  ShiftAlreadyOpenError,
  ShiftAlreadyClosedError,
  SettlementAlreadyVoidedError,
  RegisterPaymentInvalidError,
  OrderHasCapturedPaymentError,
  SettlementPaidByGatewayError,
  OutletNotFoundError,
  TerminalNotFoundError,
  MenuItemNotFoundError,
  OrderNotFoundError,
};
