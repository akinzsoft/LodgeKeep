'use strict';

/**
 * Exact decimal money arithmetic — ARCHITECTURE.md §1/§12: "Money is exact,
 * always... Never float, anywhere." Nothing in this codebase has needed to
 * SUM or DIVIDE money values before PLAN.md Phase 3's reporting module —
 * every earlier money column was stored, compared, or replaced whole, never
 * aggregated — so this is the first exact-arithmetic helper here, built as
 * shared infra rather than a one-off in `src/modules/reporting` since
 * Cashiering will need the identical summation for folio totals.
 *
 * Every DECIMAL money column in this schema is fixed at 2 places
 * (ARCHITECTURE.md §1's own convention, `DECIMAL-as-string in JSON`).
 * Converting to integer cents via BigInt and back is exact — no IEEE-754
 * representation error is possible, unlike `Number(a) + Number(b)`.
 *
 * PLAN.md Phase 2.5 (Cashiering) is the first caller that needs to multiply
 * money by a rate (tax) and needs signed line-item amounts (a payment posts
 * as negative), rather than only summing/dividing same-signed values — see
 * `percentOfMoney`/`negateMoney` below, added for exactly that.
 */

function toCents(decimalString) {
  const [whole, fraction = ''] = String(decimalString).split('.');
  const paddedFraction = `${fraction}00`.slice(0, 2);
  const negative = whole.startsWith('-');
  const wholeAbs = negative ? whole.slice(1) : whole;
  const cents = BigInt(wholeAbs || '0') * 100n + BigInt(paddedFraction || '0');
  return negative ? -cents : cents;
}

function fromCents(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const wholePart = abs / 100n;
  const fractionPart = abs % 100n;
  return `${negative ? '-' : ''}${wholePart}.${fractionPart.toString().padStart(2, '0')}`;
}

/** Sums an array of DECIMAL-as-string money values exactly, returning a 2-decimal string. `[]` sums to '0.00'. */
function sumMoney(values) {
  const totalCents = values.reduce((total, value) => total + toCents(value), 0n);
  return fromCents(totalCents);
}

/**
 * Divides a non-negative money total by a positive integer count, rounded
 * half-up to the nearest cent (the standard financial default) — used for
 * ADR/RevPAR, both always non-negative ratios in this pass. Returns '0.00'
 * for a zero count rather than dividing by zero.
 */
function divideMoney(totalDecimalString, count) {
  if (!count) return '0.00';
  const totalCents = toCents(totalDecimalString);
  const countBig = BigInt(count);
  const roundedCents = (totalCents * 2n + countBig) / (2n * countBig);
  return fromCents(roundedCents);
}

/**
 * `amount * rate / 100`, rounded half-up to the nearest cent — ARCHITECTURE.md
 * §12.1's fixed rounding rule, used by the cashiering tax engine
 * (`src/modules/cashiering/tax-engine.js`). `rate` is a percentage string/number
 * (e.g. '7.5000'), scaled to an integer over 10000 (four decimal places —
 * `taxes.rate`'s own column precision) so the whole computation stays exact
 * BigInt arithmetic with no intermediate float.
 */
function percentOfMoney(amountDecimalString, ratePercentString) {
  const amountCents = toCents(amountDecimalString);
  const [rateWhole, rateFraction = ''] = String(ratePercentString).split('.');
  const rateScaled = BigInt(rateWhole || '0') * 10000n + BigInt(`${rateFraction}0000`.slice(0, 4) || '0');
  const numerator = amountCents * rateScaled;
  const denominator = 100n * 10000n;
  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const roundedAbs = (absNumerator * 2n + denominator) / (2n * denominator);
  return fromCents(negative ? -roundedAbs : roundedAbs);
}

/**
 * The tax portion already contained within `totalDecimalString`, if that
 * total is inclusive of a tax at `ratePercentString`% — ARCHITECTURE.md
 * §12.1's inclusive-pricing back-calculation: `tax = total * R / (1 + R)`
 * where `R = rate/100`. Kept as exact BigInt rational arithmetic (multiply
 * both the numerator and the `(1+R)` denominator by the rate's own scale
 * before dividing) rather than computing `total / (1+R)` and subtracting,
 * which would round twice and could disagree with this by a cent on some
 * inputs. Used by `src/modules/cashiering/tax-engine.js` for an
 * inclusive-priced tax line.
 */
function inclusiveTaxPortion(totalDecimalString, ratePercentString) {
  const totalCents = toCents(totalDecimalString);
  const [rateWhole, rateFraction = ''] = String(ratePercentString).split('.');
  const rateScaled = BigInt(rateWhole || '0') * 10000n + BigInt(`${rateFraction}0000`.slice(0, 4) || '0');
  const denominator = 1000000n + rateScaled; // (100 + rate) scaled by 10000
  const numerator = totalCents * rateScaled;
  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const roundedAbs = (absNumerator * 2n + denominator) / (2n * denominator);
  return fromCents(negative ? -roundedAbs : roundedAbs);
}

/** The additive inverse of a DECIMAL-as-string money value — `'12.50' -> '-12.50'`, `'-5.00' -> '5.00'`. */
function negateMoney(decimalString) {
  return fromCents(-toCents(decimalString));
}

/** Exact comparison — never `toBeCloseTo`-shaped float comparison (ARCHITECTURE.md §1). */
function compareMoney(a, b) {
  const diff = toCents(a) - toCents(b);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

module.exports = {
  sumMoney,
  divideMoney,
  percentOfMoney,
  negateMoney,
  compareMoney,
  inclusiveTaxPortion,
  toCents,
  fromCents,
};
