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

module.exports = {
  NoActivePlanError,
  CardVerificationFailedError,
  NoPaymentMethodOnFileError,
  InvoiceNotFoundError,
};
