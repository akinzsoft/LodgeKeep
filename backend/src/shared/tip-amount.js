'use strict';

/**
 * The one validation a POS tip passes (F-02, product audit). The tip arrives from the Register as sent, was added to the
 * check total and to the shift's expected cash, and was never checked: a NEGATIVE tip worked as an unapproved discount
 * (the customer paid less, the drawer expected less, and cash-up balanced), and text such as "abc" or "1e3" reached
 * MySQL as a 500.
 *
 * A tip is absent (undefined or null, meaning none) or a non-negative amount of at most 2 decimals, written as a plain
 * decimal string or number-free digits ("2.50"). No signs, no exponent, no NaN / Infinity, no separators, and nothing
 * above the ceiling. JSON numbers are refused on purpose: money travels as strings (ARCHITECTURE.md §1).
 *
 * The ceiling is `MAX_TIP_AMOUNT` (default 1,000,000.00 in the check's currency). A garbage or zero env value falls back
 * to the default rather than disabling the guard.
 */

const { ValidationError } = require('./errors');
const { toCents } = require('./money');

const DEFAULT_MAX_TIP_AMOUNT = '1000000.00';

function maxTipAmount() {
  const raw = process.env.MAX_TIP_AMOUNT;
  return typeof raw === 'string' && /^\d+(\.\d{1,2})?$/.test(raw.trim()) && toCents(raw.trim()) > 0n ? raw.trim() : DEFAULT_MAX_TIP_AMOUNT;
}

/** Returns the tip as a trimmed string (`'0.00'` when none was sent), or throws a 400 `VALIDATION_INVALID_TIP`. */
function assertTipAmount(tip) {
  if (tip === undefined || tip === null) return '0.00';
  const value = typeof tip === 'string' ? tip.trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new ValidationError('INVALID_TIP', '"tip_amount" must be an amount of zero or more with at most 2 decimal places, e.g. "2.50".', [{ field: 'tip_amount', issue: 'invalid' }]);
  }
  const max = maxTipAmount();
  if (toCents(value) > toCents(max)) {
    throw new ValidationError('INVALID_TIP', `"tip_amount" must not exceed ${max}.`, [{ field: 'tip_amount', issue: 'too_large', max }]);
  }
  return value;
}

module.exports = { assertTipAmount, maxTipAmount, DEFAULT_MAX_TIP_AMOUNT };
