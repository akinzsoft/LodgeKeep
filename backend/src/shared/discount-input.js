'use strict';

/**
 * The one validation a discount request passes. The client sends only a scope, a type and a value; the server derives
 * every amount. A value is a plain decimal string with at most 2 decimals: no sign, exponent, NaN / Infinity,
 * separators or JSON numbers (money travels as strings, ARCHITECTURE.md §1), above zero, a percent at most 100 and a
 * fixed amount at most `MAX_DISCOUNT_AMOUNT` (default 1,000,000.00; a garbage or zero env value falls back).
 */

const { ValidationError } = require('./errors');
const { toCents } = require('./money');

const DEFAULT_MAX_DISCOUNT_AMOUNT = '1000000.00';
const SCOPES = ['order', 'line'];
const TYPES = ['percent', 'fixed'];

function maxDiscountAmount() {
  const raw = process.env.MAX_DISCOUNT_AMOUNT;
  return typeof raw === 'string' && /^\d+(\.\d{1,2})?$/.test(raw.trim()) && toCents(raw.trim()) > 0n ? raw.trim() : DEFAULT_MAX_DISCOUNT_AMOUNT;
}

function invalid(message, field, issue, extra = {}) {
  return new ValidationError('INVALID_DISCOUNT', message, [{ field, issue, ...extra }]);
}

/** Returns `{scope, type, value}` (value trimmed), or throws a 400 `VALIDATION_INVALID_DISCOUNT`. */
function assertDiscountInput({ scope, type, value } = {}) {
  if (!SCOPES.includes(scope)) throw invalid(`"scope" must be one of: ${SCOPES.join(', ')}.`, 'scope', 'invalid');
  if (!TYPES.includes(type)) throw invalid(`"type" must be one of: ${TYPES.join(', ')}.`, 'type', 'invalid');
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw invalid('"value" must be an amount with at most 2 decimal places, e.g. "10" or "2.50".', 'value', 'invalid');
  const cents = toCents(text);
  if (cents <= 0n) throw invalid('"value" must be above zero.', 'value', 'not_positive');
  if (type === 'percent' && cents > 10000n) throw invalid('A percent discount cannot be more than 100.', 'value', 'too_large', { max: '100' });
  if (type === 'fixed') {
    const max = maxDiscountAmount();
    if (cents > toCents(max)) throw invalid(`A fixed discount must not exceed ${max}.`, 'value', 'too_large', { max });
  }
  return { scope, type, value: text };
}

module.exports = { assertDiscountInput, maxDiscountAmount, DEFAULT_MAX_DISCOUNT_AMOUNT, SCOPES, TYPES };
