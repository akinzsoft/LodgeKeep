'use strict';

/**
 * Accounts Receivable module error types — API.md §3, PLAN.md Phase 4.
 */

const { AppError, ValidationError } = require('../../shared/errors');

/** TESTING.md AR-3: a charge would push a block-mode account over its credit limit, with no override supplied. API.md already reserves this literal code as its own worked example. */
class CreditLimitExceededError extends AppError {
  constructor({ arAccountId, projectedBalance, creditLimit }) {
    super(
      'BUSINESS_RULE_CREDIT_LIMIT_EXCEEDED',
      `This charge would take AR account ${arAccountId}'s balance to ${projectedBalance}, over its ${creditLimit} credit limit.`,
      422,
      { arAccountId, projectedBalance, creditLimit }
    );
  }
}

/** 422, not 400 — this is a real business-rule precondition ("bill to a real account"), not a malformed request. */
class ArAccountNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_AR_ACCOUNT_NOT_FOUND', 'No active AR account exists for this company at this property — create one before billing a folio to it.', 422);
  }
}

/** 422, not 400 — a friendly existence check ahead of the FK, matching this codebase's own "existence check before insert" convention (e.g. `rate_code_id`/`preferred_room_id`), so a bad or cross-tenant company id gets a real business-rule rejection instead of a raw ER_NO_REFERENCED_ROW_2 falling through to a 500. */
class CompanyProfileNotFoundError extends AppError {
  constructor() {
    super('VALIDATION_COMPANY_PROFILE_NOT_FOUND', 'No company profile exists with this id in this tenant.', 422);
  }
}

/** 422, not 400 — the request is well-formed; there is simply nothing eligible to invoice right now. */
class NoChargesToInvoiceError extends AppError {
  constructor() {
    super('VALIDATION_NO_CHARGES_TO_INVOICE', 'This account has no un-invoiced charges to generate an invoice from.', 422);
  }
}

class InvoiceAlreadyVoidError extends AppError {
  constructor(invoiceId) {
    super('CONFLICT_INVOICE_ALREADY_VOID', `Invoice ${invoiceId} has already been voided.`, 409, { invoiceId });
  }
}

class PaymentApplicationExceedsInvoiceError extends AppError {
  constructor({ invoiceId, requested, remaining }) {
    super(
      'BUSINESS_RULE_PAYMENT_APPLICATION_EXCEEDS_INVOICE',
      `Applying ${requested} to invoice ${invoiceId} would exceed its remaining balance of ${remaining}.`,
      422,
      { invoiceId, requested, remaining }
    );
  }
}

class PaymentApplicationExceedsPaymentError extends AppError {
  constructor({ paymentId, requested, remaining }) {
    super(
      'BUSINESS_RULE_PAYMENT_APPLICATION_EXCEEDS_PAYMENT',
      `Applying ${requested} would exceed payment ${paymentId}'s remaining unapplied amount of ${remaining}.`,
      422,
      { paymentId, requested, remaining }
    );
  }
}

class PaymentAlreadyVoidError extends AppError {
  constructor(paymentId) {
    super('CONFLICT_PAYMENT_ALREADY_VOID', `AR payment ${paymentId} has already been voided.`, 409, { paymentId });
  }
}

/** A credit-limit override was requested but no reason was supplied — CLAUDE.md's own "money confirmations require a reason" rule, applied to AR overrides too. */
class CreditLimitOverrideReasonRequiredError extends ValidationError {
  constructor() {
    super('MISSING_FIELD', 'A reason is required to override a credit-limit rejection.', [{ field: 'overrideReason', issue: 'missing' }]);
  }
}

module.exports = {
  CreditLimitExceededError,
  ArAccountNotFoundError,
  CompanyProfileNotFoundError,
  NoChargesToInvoiceError,
  InvoiceAlreadyVoidError,
  PaymentApplicationExceedsInvoiceError,
  PaymentApplicationExceedsPaymentError,
  PaymentAlreadyVoidError,
  CreditLimitOverrideReasonRequiredError,
};
