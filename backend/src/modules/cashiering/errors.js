'use strict';

/**
 * Cashiering module error types — API.md §3, PLAN.md Phase 2.5.
 */

const { AppError, ValidationError } = require('../../shared/errors');

/** A folio's status blocks the requested action — API.md §2's own worked example is exactly this error. */
class FolioClosedError extends AppError {
  constructor(folioId) {
    super('CONFLICT_FOLIO_ALREADY_CLOSED', `Folio ${folioId} is closed and cannot accept new charges.`, 409, { folioId });
  }
}

/** ARCHITECTURE.md §8: a folio line item is void, never deleted — voiding one that is already void is a conflict, not a silent no-op. */
class LineItemAlreadyVoidedError extends AppError {
  constructor(lineItemId) {
    super('CONFLICT_LINE_ITEM_ALREADY_VOIDED', `Folio line item ${lineItemId} has already been voided.`, 409, { lineItemId });
  }
}

/** ARCHITECTURE.md §7's payment state machine — a transition the diagram does not allow. */
class InvalidPaymentTransitionError extends AppError {
  constructor(from, to) {
    super('BUSINESS_RULE_INVALID_PAYMENT_TRANSITION', `A payment cannot move from "${from}" to "${to}".`, 422, { from, to });
  }
}

/** A refund (full or partial) requested for more than the payment's own captured amount, net of any prior refunds. */
class RefundExceedsCapturedAmountError extends AppError {
  constructor(paymentId, requested, available) {
    super(
      'BUSINESS_RULE_REFUND_EXCEEDS_CAPTURED_AMOUNT',
      `Refund of ${requested} exceeds the ${available} still available to refund on payment ${paymentId}.`,
      422,
      { paymentId, requested, available }
    );
  }
}

/** Split billing: the source and destination folios must belong to the same reservation. */
class CrossReservationFolioMoveError extends AppError {
  constructor() {
    super('BUSINESS_RULE_CROSS_RESERVATION_FOLIO_MOVE', 'A line item can only move between folios on the same reservation.', 422);
  }
}

/** API.md §7: an unverified webhook is persisted (for audit) but never processed. */
class WebhookSignatureInvalidError extends AppError {
  constructor() {
    super('VALIDATION_WEBHOOK_SIGNATURE_INVALID', 'The webhook signature could not be verified.', 400);
  }
}

class LineItemNotFoundError extends ValidationError {
  constructor() {
    super('LINE_ITEM_NOT_FOUND', 'The specified folio line item does not exist on this folio.');
  }
}

module.exports = {
  FolioClosedError,
  LineItemAlreadyVoidedError,
  InvalidPaymentTransitionError,
  RefundExceedsCapturedAmountError,
  CrossReservationFolioMoveError,
  WebhookSignatureInvalidError,
  LineItemNotFoundError,
};
