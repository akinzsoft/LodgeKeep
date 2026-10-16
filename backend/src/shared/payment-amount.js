'use strict';

/**
 * The one validation every amount a person PAYS IN passes (cash, card terminal, Paystack on a folio). Before this
 * the payment paths took `amount` as given, so a NEGATIVE one posted as a charge and nothing bounded a typo.
 *
 * An amount is a positive number with at most 2 decimals, no larger than the ceiling. It is NOT compared to the
 * folio balance: paying more than is owed is a deposit and leaves a credit (a negative balance) the guest draws down.
 *
 * The ceiling is `MAX_PAYMENT_AMOUNT` (default 10,000,000.00 in the folio's currency). A garbage env value falls back
 * to the default rather than disabling the guard.
 */

const { ValidationError } = require('./errors');
const { toCents } = require('./money');

const DEFAULT_MAX_PAYMENT_AMOUNT = '10000000.00';

function maxPaymentAmount() {
  const raw = process.env.MAX_PAYMENT_AMOUNT;
  return typeof raw === 'string' && /^\d+(\.\d{1,2})?$/.test(raw.trim()) && toCents(raw.trim()) > 0n ? raw.trim() : DEFAULT_MAX_PAYMENT_AMOUNT;
}

/** Returns the amount as a trimmed string, or throws a 400 `VALIDATION_INVALID_AMOUNT`. */
function assertPaymentAmount(amount) {
  const value = typeof amount === 'string' || typeof amount === 'number' ? String(amount).trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new ValidationError('INVALID_AMOUNT', '"amount" must be a positive amount with at most 2 decimal places.', [{ field: 'amount', issue: 'invalid' }]);
  }
  if (toCents(value) <= 0n) {
    throw new ValidationError('INVALID_AMOUNT', '"amount" must be greater than zero.', [{ field: 'amount', issue: 'not_positive' }]);
  }
  const max = maxPaymentAmount();
  if (toCents(value) > toCents(max)) {
    throw new ValidationError('INVALID_AMOUNT', `"amount" must not exceed ${max}.`, [{ field: 'amount', issue: 'too_large', max }]);
  }
  return value;
}

/**
 * A folio ADJUSTMENT amount: signed (a negative one is a discount or write-off), non-zero, at most 2 decimals and no
 * larger in size than the ceiling. Text, exponents, NaN and Infinity are refused.
 */
function assertAdjustmentAmount(amount) {
  const value = typeof amount === 'string' || typeof amount === 'number' ? String(amount).trim() : '';
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) {
    throw new ValidationError('INVALID_AMOUNT', '"amount" must be an amount with at most 2 decimal places, negative for a discount.', [{ field: 'amount', issue: 'invalid' }]);
  }
  const magnitude = value.replace(/^-/, '');
  if (toCents(magnitude) === 0n) {
    throw new ValidationError('INVALID_AMOUNT', '"amount" must not be zero.', [{ field: 'amount', issue: 'zero' }]);
  }
  const max = maxPaymentAmount();
  if (toCents(magnitude) > toCents(max)) {
    throw new ValidationError('INVALID_AMOUNT', `"amount" must not exceed ${max} in size.`, [{ field: 'amount', issue: 'too_large', max }]);
  }
  return value;
}

module.exports = { assertAdjustmentAmount, assertPaymentAmount, maxPaymentAmount, DEFAULT_MAX_PAYMENT_AMOUNT };
