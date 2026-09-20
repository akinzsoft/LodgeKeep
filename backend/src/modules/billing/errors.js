'use strict';

/**
 * Billing module error types — API.md §3, PLAN.md Phase 5.
 */

const { AppError } = require('../../shared/errors');

class NoActivePlanError extends AppError {
  constructor() {
    super('BILLING_NO_ACTIVE_PLAN', 'No active billing plan is configured for this environment.', 500);
  }
}

class CardVerificationFailedError extends AppError {
  constructor(gatewayStatus) {
    super(
      'BILLING_CARD_VERIFICATION_FAILED',
      `The card could not be verified (gateway reported "${gatewayStatus}"). Try again with a different card.`,
      402,
      { gatewayStatus }
    );
  }
}

class NoPaymentMethodOnFileError extends AppError {
  constructor() {
    super('BILLING_NO_PAYMENT_METHOD', 'No payment method is on file for this organization yet.', 422);
  }
}

class InvoiceNotFoundError extends AppError {
  constructor() {
    super('BILLING_INVOICE_NOT_FOUND', 'That invoice does not exist for this organization.', 404);
  }
}

/**
 * Security fix — `completeAddPaymentMethod`'s ownership/replay guard
 * (`billing_payment_method_checkouts`, see that migration's own header).
 * Covers three distinct cases behind one error, deliberately: no such
 * reference at all, a reference that belongs to a DIFFERENT tenant (the
 * same 404-not-403 shape every other cross-tenant lookup in this codebase
 * uses — confirming "this exists, just not for you" would itself leak
 * information), and a reference that has already been completed once
 * (replay). None of the three should be distinguishable to the caller.
 */
class CheckoutNotFoundError extends AppError {
  constructor() {
    super('BILLING_CHECKOUT_NOT_FOUND', 'That checkout could not be found or has already been completed.', 404);
  }
}

/**
 * The gateway's own verified amount/currency for a reference diverges from
 * what `billing_payment_method_checkouts` recorded when the checkout was
 * started — defense in depth even for a reference that does genuinely
 * belong to this tenant, in case a request was tampered with in transit
 * or a gateway response was substituted.
 */
class CheckoutMismatchError extends AppError {
  constructor() {
    super('BILLING_CHECKOUT_MISMATCH', 'The verified payment does not match the checkout that was started.', 409);
  }
}

module.exports = {
  NoActivePlanError,
  CardVerificationFailedError,
  NoPaymentMethodOnFileError,
  InvoiceNotFoundError,
  CheckoutNotFoundError,
  CheckoutMismatchError,
};
